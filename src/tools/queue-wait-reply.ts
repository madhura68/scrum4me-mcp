import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'
import { resolveQueueIdentity } from '../queue/identity.js'
import { claimNextReply } from '../queue/claim.js'
import { openQueueListener, waitForQueueWakeup } from '../queue/listen.js'
import { getInstanceId } from '../presence/instance.js'
import { messageView, type QueueMessageLike } from '../queue/view.js'
import { QUEUE_MODELS } from '@shared/queue-identity.js'
import type { QueueAddress } from '../queue/types.js'
import { legacyMarkerWhere } from '../queue/marked.js'

const CALLER_PROTOCOL =
  'Remove answered request-ids from the next queue_wait_reply call; every reply carries its in_reply_to.'

const DEFAULT_WAIT_SECONDS = 300

const inputSchema = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(100),
  wait_seconds: z.number().int().min(0).max(600).default(DEFAULT_WAIT_SECONDS),
  // Zie queue-push.ts: afgeleid van QUEUE_MODELS, nooit overgetypt.
  as: z.enum(QUEUE_MODELS).optional(),
})

interface ToolExtra {
  signal?: AbortSignal
}

/**
 * §5.2: idempotent read (already-done replies stay retrievable — at-least-once
 * delivery to the requester) + drain of every currently claimable reply
 * (claim + auto-ack per row). Returns ALL available replies in one response.
 */
async function collectAvailableReplies(
  self: QueueAddress,
  messageIds: string[],
  claimedBy: string,
): Promise<Array<ReturnType<typeof messageView>>> {
  const alreadyDone = (await prisma.agentMessage.findMany({
    where: {
      in_reply_to: { in: messageIds },
      to_server: self.server,
      to_model: self.model,
      status: 'done',
      ...legacyMarkerWhere(),
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  })) as QueueMessageLike[]
  const byId = new Map<string, ReturnType<typeof messageView>>()
  for (const row of alreadyDone) byId.set(row.id, messageView(row))
  for (;;) {
    const claimed = await claimNextReply({
      server: self.server,
      model: self.model,
      messageIds,
      claimedBy,
    })
    if (!claimed) break
    byId.set(claimed.id, messageView(claimed))
  }
  return [...byId.values()]
}

export function registerQueueWaitReplyTool(server: McpServer) {
  server.registerTool(
    'queue_wait_reply',
    {
      title: 'Queue wait reply',
      description:
        'Fetch replies to YOUR OWN queue_push requests — the correlation filter (in_reply_to) is ' +
        'part of the claim query, so parallel sessions can never steal each other\'s answers. ' +
        'Returns ALL currently available replies for the given set in one response, each with its ' +
        'in_reply_to; remove answered request-ids from the next call. Already-delivered replies are ' +
        'returned again (idempotent read, at-least-once). wait_seconds 0 = non-blocking check; ' +
        'default 300 = block until the first reply. Timeout returns {status:"timeout"} — not an ' +
        'error, simply call again.',
      inputSchema,
    },
    async ({ message_ids, wait_seconds, as }, extra?: ToolExtra) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const self = resolveQueueIdentity(as)
        const waitSeconds = wait_seconds ?? DEFAULT_WAIT_SECONDS
        const signal = extra?.signal ?? new AbortController().signal
        // Audit-only claimed_by for auto-acked replies; no lease (claim+ack is
        // one transaction — there is nothing to finish later).
        const claimedBy = `mcp:${getInstanceId()}`

        let replies = await collectAvailableReplies(self, message_ids, claimedBy)
        if (replies.length > 0) return toolJson({ status: 'ok', replies, hint: CALLER_PROTOCOL })
        if (waitSeconds === 0 || signal.aborted) return toolJson({ status: 'timeout', replies: [] })

        const deadline = Date.now() + waitSeconds * 1000
        const idSet = new Set<string>(message_ids)
        const listenClient = await openQueueListener()
        try {
          // One direct attempt right after LISTEN — closes the setup gap (§5).
          replies = await collectAvailableReplies(self, message_ids, claimedBy)
          if (replies.length > 0) return toolJson({ status: 'ok', replies, hint: CALLER_PROTOCOL })
          while (Date.now() < deadline && !signal.aborted) {
            await waitForQueueWakeup(listenClient, signal, (payload) =>
              typeof payload.in_reply_to === 'string' && idSet.has(payload.in_reply_to),
            )
            if (signal.aborted) break
            replies = await collectAvailableReplies(self, message_ids, claimedBy)
            if (replies.length > 0) return toolJson({ status: 'ok', replies, hint: CALLER_PROTOCOL })
          }
        } finally {
          await listenClient.end().catch(() => {})
        }
        // §7: timeout is not an error. No cancel rollback needed either —
        // claim+ack is one transaction; the idempotent read catches
        // post-commit loss on the next call.
        return toolJson({ status: 'timeout', replies: [] })
      }),
  )
}
