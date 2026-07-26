import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'
import { resolveQueueIdentity } from '../queue/identity.js'
import { claimNextRequest, rollbackQueueClaim, type ClaimedAgentMessage } from '../queue/claim.js'
import { registerLease, releaseLease } from '../queue/lease-register.js'
import { openQueueListener, waitForQueueWakeup } from '../queue/listen.js'
import { getInstanceId } from '../presence/instance.js'
import { messageView } from '../queue/view.js'
import { QUEUE_REQUEST_TYPES } from '@shared/queue-identity.js'
import type { QueueAddress } from '../queue/types.js'

const INSTRUCTIONS_TEXT =
  'Execute within meta.task.cwd. If required context is missing → queue_fail, do not guess. ' +
  'Finish from THIS session with queue_done({ message_id, reply, claim_token }) or ' +
  'queue_fail({ message_id, error, claim_token }); claims do not survive an MCP restart.'

const inputSchema = z.object({
  wait_seconds: z.number().int().min(0).max(600).default(0),
  as: z.enum(['claude', 'codex', 'jp']).optional(),
})

interface ToolExtra {
  signal?: AbortSignal
}

interface ClaimResult {
  row: ClaimedAgentMessage
  claimToken: string
  claimedBy: string
}

async function tryClaim(self: QueueAddress): Promise<ClaimResult | null> {
  // Unpredictable per-claim token — ownership proof for queue_done/queue_fail
  // (§5.3). <instance_id> in claimed_by is audit only; the checks compare the
  // full string and the local lease register, never the instance id.
  const claimToken = randomUUID()
  const claimedBy = `mcp:${getInstanceId()}:${claimToken}`
  const row = await claimNextRequest({ server: self.server, model: self.model, claimedBy })
  if (!row) return null
  registerLease(row.id, { claimToken, claimedBy })
  return { row, claimToken, claimedBy }
}

export function registerQueueNextTool(server: McpServer) {
  server.registerTool(
    'queue_next',
    {
      title: 'Queue next',
      description:
        'Claim the next queue request (task/info/review_request) addressed to you, FIFO. ' +
        'Returns the message plus a claim_token — keep it and pass it to queue_done/queue_fail. ' +
        'Execute within meta.task.cwd; missing required context → queue_fail, do not guess. ' +
        'wait_seconds 0 (default) = non-blocking; up to 600 = bounded wait for new work. ' +
        'Timeout returns {status:"timeout"} — not an error.',
      inputSchema,
    },
    async ({ wait_seconds, as }, extra?: ToolExtra) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const self = resolveQueueIdentity(as)
        const waitSeconds = wait_seconds ?? 0
        const signal = extra?.signal ?? new AbortController().signal

        // MCP-cancel BEFORE any claim: nothing was mutated (§7).
        if (signal.aborted) return toolJson({ status: 'timeout', message: null })

        let claimed = await tryClaim(self)
        if (!claimed && waitSeconds > 0) {
          const deadline = Date.now() + waitSeconds * 1000
          const listenClient = await openQueueListener()
          try {
            // One direct attempt right after LISTEN — closes the setup gap (§5).
            claimed = await tryClaim(self)
            while (!claimed && Date.now() < deadline && !signal.aborted) {
              await waitForQueueWakeup(listenClient, signal, (payload) =>
                (payload.status === undefined || payload.status === 'pending') &&
                payload.to_server === self.server &&
                payload.to_model === self.model &&
                typeof payload.type === 'string' &&
                (QUEUE_REQUEST_TYPES as readonly string[]).includes(payload.type),
              )
              if (signal.aborted) break
              claimed = await tryClaim(self)
            }
          } finally {
            await listenClient.end().catch(() => {})
          }
        }

        if (!claimed) return toolJson({ status: 'timeout', message: null })

        if (signal.aborted) {
          // MCP-cancel right after the claim transaction: the response will
          // never reach the client — roll back (claimed → pending) and drop
          // the lease (§7). Rollback matches on exact claimed_by only.
          releaseLease(claimed.row.id)
          await rollbackQueueClaim(claimed.row.id, claimed.claimedBy)
          return toolJson({ status: 'cancelled', message: null })
        }

        return toolJson({
          status: 'claimed',
          message: messageView(claimed.row),
          claim_token: claimed.claimToken,
          instructions: INSTRUCTIONS_TEXT,
        })
      }),
  )
}
