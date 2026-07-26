import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { QUEUE_TERMINAL_STATUSES } from '@shared/queue-identity.js'
import { releaseLease } from '../queue/lease-register.js'
import { verifyLocalOwnership } from '../queue/ownership.js'
import { QUEUE_CHANNEL, envelopeOf } from '../queue/notify.js'
import type { AgentMessageRecord } from '../queue/claim.js'

const inputSchema = z.object({
  message_id: z.string().uuid(),
  error: z.string().min(1),
  claim_token: z.string().min(1).optional(),
})

type FailOutcome = { error: string } | { failed: AgentMessageRecord }

export function registerQueueFailTool(server: McpServer) {
  server.registerTool(
    'queue_fail',
    {
      title: 'Queue fail',
      description:
        'Mark a queue message as failed with an error text (stop-at-first-error contract: ' +
        'when required context is missing, fail — do not guess). Same validations and ownership ' +
        'contract as queue_done: pass the claim_token from queue_next for your own claim; on ' +
        'QUEUE_CLAIM_EXPIRED or QUEUE_NOT_CLAIMER discard local work and re-claim via queue_next.',
      inputSchema,
    },
    async ({ message_id, error, claim_token }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const outcome = await prisma.$transaction(async (tx): Promise<FailOutcome> => {
          const rows = await tx.$queryRaw<AgentMessageRecord[]>`
            SELECT * FROM agent_message WHERE id = ${message_id}::uuid FOR UPDATE
          `
          const req = rows[0]
          if (!req) return { error: `QUEUE_NOT_FOUND: message ${message_id} does not exist` }
          if ((QUEUE_TERMINAL_STATUSES as readonly string[]).includes(req.status)) {
            return { error: `QUEUE_ALREADY_TERMINAL: message ${message_id} is already ${req.status}` }
          }
          const verdict = verifyLocalOwnership({
            messageId: message_id,
            rowStatus: req.status,
            claimToken: claim_token,
          })
          if (!verdict.ok) return { error: verdict.error }
          if (verdict.expectedClaimedBy !== null && req.claimed_by !== verdict.expectedClaimedBy) {
            return { error: `QUEUE_NOT_CLAIMER: message ${message_id} was re-claimed by another owner` }
          }

          const upd = await tx.$queryRaw<AgentMessageRecord[]>`
            UPDATE agent_message SET status = 'failed', error = ${error}, finished_at = now()
             WHERE id = ${req.id}::uuid RETURNING *
          `
          const payload = JSON.stringify(envelopeOf(upd[0], req.status))
          await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${payload})`
          return { failed: upd[0] }
        })

        if ('error' in outcome) return toolError(outcome.error)
        releaseLease(message_id)
        return toolJson({ message_id, status: 'failed' })
      }),
  )
}
