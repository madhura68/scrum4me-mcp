import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { QUEUE_REPLY_TYPE, QUEUE_TERMINAL_STATUSES, isQueueRequestType } from '@shared/queue-identity.js'
import { releaseLease } from '../queue/lease-register.js'
import { verifyLocalOwnership } from '../queue/ownership.js'
import { QUEUE_CHANNEL, envelopeOf } from '../queue/notify.js'
import type { AgentMessageRecord } from '../queue/claim.js'
import { assertLegacyQueueRow, LEGACY_MARKER_SQL } from '../queue/marked.js'

const inputSchema = z.object({
  message_id: z.string().uuid(),
  reply: z.string().min(1).optional(),
  claim_token: z.string().min(1).optional(),
})

type DoneOutcome =
  | { error: string }
  | { done: AgentMessageRecord; replyRow: AgentMessageRecord | null }

export function registerQueueDoneTool(server: McpServer) {
  server.registerTool(
    'queue_done',
    {
      title: 'Queue done',
      description:
        'Finish a queue message. With reply: transactionally insert the reply row ' +
        '(result/data/reviewed, addressed back to the requester) and set the request to done. ' +
        'Without reply: ack/close. Pass the claim_token from queue_next when finishing your own ' +
        'claim. On QUEUE_CLAIM_EXPIRED or QUEUE_NOT_CLAIMER: discard local work and re-claim via ' +
        'queue_next (JOB_CANCELLED pattern) — never resubmit results of an expired claim.',
      inputSchema,
    },
    async ({ message_id, reply, claim_token }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const outcome = await prisma.$transaction(async (tx): Promise<DoneOutcome> => {
          const rows = await tx.$queryRaw<AgentMessageRecord[]>`
            SELECT * FROM agent_message WHERE id = ${message_id}::uuid FOR UPDATE
          `
          const req = rows[0]
          if (!req) return { error: `QUEUE_NOT_FOUND: message ${message_id} does not exist` }
          try { assertLegacyQueueRow(req as unknown as Record<string, unknown>) }
          catch { return { error: 'PPE_LEGACY_ROUTE_REJECTED' } }
          if ((QUEUE_TERMINAL_STATUSES as readonly string[]).includes(req.status)) {
            return { error: `QUEUE_ALREADY_TERMINAL: message ${message_id} is already ${req.status}` }
          }
          const verdict = verifyLocalOwnership({
            messageId: message_id,
            rowStatus: req.status,
            claimToken: claim_token,
          })
          if (!verdict.ok) return { error: verdict.error }
          // Step (c) — atomic under the FOR UPDATE lock: claimed_by must equal
          // the full expected value EXACTLY (no substring/LIKE). Catches races
          // with sweep/re-claim (§5.4 round-6 precedence).
          if (verdict.expectedClaimedBy !== null && req.claimed_by !== verdict.expectedClaimedBy) {
            return { error: `QUEUE_NOT_CLAIMER: message ${message_id} was re-claimed by another owner` }
          }

          if (reply !== undefined) {
            if (!isQueueRequestType(req.type)) {
              return {
                error:
                  'VALIDATION_ERROR: reply is only possible on request messages ' +
                  `(task/info/review_request); message ${message_id} has type ${req.type}`,
              }
            }
            const replyType = QUEUE_REPLY_TYPE[req.type]
            const ins = await tx.$queryRaw<AgentMessageRecord[]>`
              INSERT INTO agent_message
                (type, from_server, from_model, to_server, to_model, body, in_reply_to, source)
              VALUES
                (${replyType}, ${req.to_server}, ${req.to_model},
                 ${req.from_server}, ${req.from_model}, ${reply}, ${req.id}::uuid, 'mcp')
              RETURNING *
            `
            const upd = await tx.$queryRaw<AgentMessageRecord[]>`
              UPDATE agent_message SET status = 'done', finished_at = now()
               WHERE id = ${req.id}::uuid AND ${LEGACY_MARKER_SQL} RETURNING *
            `
            // Both envelopes inside the transaction (fire at COMMIT) — same as
            // CLI doneWithReply: reply row (pending/null) + request (done/prev).
            const replyPayload = JSON.stringify(envelopeOf(ins[0], null))
            await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${replyPayload})`
            const donePayload = JSON.stringify(envelopeOf(upd[0], req.status))
            await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${donePayload})`
            return { done: upd[0], replyRow: ins[0] }
          }

          const upd = await tx.$queryRaw<AgentMessageRecord[]>`
            UPDATE agent_message SET status = 'done', finished_at = now()
             WHERE id = ${req.id}::uuid AND ${LEGACY_MARKER_SQL} RETURNING *
          `
          const donePayload = JSON.stringify(envelopeOf(upd[0], req.status))
          await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${donePayload})`
          return { done: upd[0], replyRow: null }
        })

        if ('error' in outcome) return toolError(outcome.error)
        // §5.4: entry removed after terminal completion.
        releaseLease(message_id)
        return toolJson({
          message_id,
          status: 'done',
          reply_id: outcome.replyRow?.id ?? null,
        })
      }),
  )
}
