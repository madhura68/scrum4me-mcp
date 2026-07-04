// Copilot idea-chat (spec 2026-07-04 §5.2): het M17-send-protocol als MCP-tool.
// Byte-voor-byte dezelfde tx-volgorde als web actions/idea-chat.ts en de
// coalescing in update-job-status.ts: lock → persist → coalesce → enqueue.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { notifyJobEnqueued } from '../lib/dispatch/notify.js'
import { parseContentPolicy, checkContentPolicy, ContentPolicyError } from '@shared/content-policy.js'

const inputSchema = z.object({
  product_id: z.string().min(1),
  idea_id: z.string().min(1),
  content: z.string().trim().min(1).max(4000),
  // false = per-binding dispatch-kill-switch actief: alleen persist (spec §5.2).
  enqueue: z.boolean().default(true),
})

const ACTIVE = ['QUEUED', 'CLAIMED', 'RUNNING'] as const

// Tx-afbreek-marker: productgrens verschoof onder de lock (anti-enum: naar
// buiten toe niet te onderscheiden van niet-bestaan).
class IdeaGoneError extends Error {}

export function registerSendIdeaChatMessageTool(server: McpServer) {
  server.registerTool(
    'send_idea_chat_message',
    {
      title: 'Send idea chat message',
      description:
        'Plaatst een user-bericht in het idee-kanaal en enqueuet (of coalescet) een IDEA_CHAT-beurt (copilot idea-chat).',
      inputSchema,
    },
    async (input) =>
      withToolErrors(async () => {
        const parsed = inputSchema.parse(input)
        const auth = await requireWriteAccess()
        if (!(await userCanAccessProduct(parsed.product_id, auth.userId))) {
          return toolError(`Product ${parsed.product_id} not found or not accessible`)
        }
        const idea = await prisma.idea.findUnique({
          where: { id: parsed.idea_id },
          select: { user_id: true, product_id: true },
        })
        if (!idea || idea.user_id !== auth.userId || idea.product_id !== parsed.product_id) {
          return toolError('Idea not found')
        }

        // AVG content-policy op het chat-bericht (spec §3.6) — zelfde gate-vorm
        // als create_idea: parse fail-closed, weigering vóór élke write.
        const product = await prisma.product.findUnique({
          where: { id: parsed.product_id },
          select: { content_policy: true },
        })
        let policy
        try {
          policy = parseContentPolicy(product?.content_policy)
        } catch (err) {
          if (err instanceof ContentPolicyError) {
            return toolError(`Product content_policy is ongeldig geconfigureerd: ${err.message}`)
          }
          throw err
        }
        const verdict = checkContentPolicy(policy, parsed.content)
        if (!verdict.allowed) return toolError(verdict.reason)

        try {
          const result = await prisma.$transaction(async (tx) => {
            // Per-idea lock — zelfde lock als web-send (SELECT id, product_id …)
            // en de MCP-afronding, zodat coalescing geen lost-wakeup kent
            // (M17 §4.1/§4.5). product_id wordt ÓNDER de lock gelezen en is
            // beslissend (codex r1-P1): een concurrent (ont)koppeling mag de
            // enqueue-beslissing niet op stale state baseren.
            const locked = await tx.$queryRaw<Array<{ id: string; product_id: string | null }>>`
              SELECT id, product_id FROM ideas WHERE id = ${parsed.idea_id} FOR UPDATE`
            if (
              locked.length === 0 ||
              (locked[0].product_id !== null && locked[0].product_id !== parsed.product_id)
            ) {
              throw new IdeaGoneError() // grens verschoven onder de lock → tx afbreken, niets persisten
            }
            const lockedProductId = locked[0].product_id
            const message = await tx.ideaChatMessage.create({
              data: { idea_id: parsed.idea_id, role: 'USER', kind: 'TEXT', content: parsed.content },
              select: { id: true },
            })
            // Productloos (concurrent ontkoppeld) of kill-switch: persist-only —
            // web-pariteit (ClaudeJob.product_id is NOT NULL).
            if (!parsed.enqueue || lockedProductId === null) {
              return { messageId: message.id, jobEnqueued: false, coalesced: false, jobId: null as string | null }
            }
            const active = await tx.claudeJob.findFirst({
              where: { idea_id: parsed.idea_id, kind: 'IDEA_CHAT', status: { in: [...ACTIVE] } },
              select: { id: true },
            })
            if (active) {
              return { messageId: message.id, jobEnqueued: false, coalesced: true, jobId: null as string | null }
            }
            // Géén source-override: default SYSTEM — de isSystemIdeaChat-guard in
            // update_job_status (en de chat-payload in wait_for_job) accepteert
            // alleen SYSTEM-jobs (codex r1-P1). Herkomst-audit zit in de IdeaLog.
            const job = await tx.claudeJob.create({
              data: {
                user_id: auth.userId,
                product_id: lockedProductId,
                idea_id: parsed.idea_id,
                kind: 'IDEA_CHAT',
                status: 'QUEUED',
              },
              select: { id: true },
            })
            await tx.ideaLog.create({
              data: {
                idea_id: parsed.idea_id,
                type: 'JOB_EVENT',
                content: 'IDEA_CHAT queued',
                metadata: { job_id: job.id, kind: 'IDEA_CHAT', source: 'COPILOT' },
              },
            })
            return { messageId: message.id, jobEnqueued: true, coalesced: false, jobId: job.id }
          })

          if (result.jobId) {
            // Ná de commit: wekt LISTENende workers (patroon update-job-status).
            await notifyJobEnqueued({
              job_id: result.jobId,
              user_id: auth.userId,
              product_id: parsed.product_id,
              kind: 'IDEA_CHAT',
              idea_id: parsed.idea_id,
            })
          }
          return toolJson({
            message_id: result.messageId,
            job_enqueued: result.jobEnqueued,
            coalesced: result.coalesced,
          })
        } catch (err) {
          if (err instanceof IdeaGoneError) return toolError('Idea not found')
          if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002') {
            // Vangrail claude_jobs_one_active_idea_chat_key won de race; de tx is
            // teruggerold (bericht NIET opgeslagen). Service mapt dit op 409.
            return toolError('Idea chat turn already active — bericht niet opgeslagen, verstuur opnieuw')
          }
          throw err
        }
      }),
  )
}
