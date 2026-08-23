import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { legacyMarkerWhere } from '../queue/marked.js'
import { messageView, type QueueMessageLike } from '../queue/view.js'

// Bewuste afwijking van spec §5's "(refine-check)": .refine() levert een
// ZodEffects op, terwijl elke tool in dit repo een kaal ZodObject als
// inputSchema aan registerTool geeft (queue-push.ts:19). De minstens-één-eis
// wordt daarom als guard in de handler afgedwongen; de caller krijgt dan een
// VALIDATION_ERROR-toolresultaat in plaats van een schema-rejectie.
const inputSchema = z.object({
  sprint_id: z.string().min(1).optional(),
  story_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  include_archived: z.boolean().default(false),
})

const MATCH_LIMIT = 100

function workItemProductId(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const workItem = (meta as Record<string, unknown>).work_item
  if (!workItem || typeof workItem !== 'object' || Array.isArray(workItem)) return null
  const productId = (workItem as Record<string, unknown>).product_id
  return typeof productId === 'string' && productId !== '' ? productId : null
}

export function registerQueueFindByWorkItemTool(server: McpServer) {
  server.registerTool(
    'queue_find_by_work_item',
    {
      title: 'Queue find by work item',
      description:
        'Read-only, non-claiming: find queue messages linked to a Scrum4Me work item ' +
        'via meta.work_item, ACROSS all addresses (not scoped to your own). Pass at ' +
        'least one of sprint_id/story_id/task_id; multiple ids filter as AND. Because ' +
        'queue_push derives the full hierarchy, searching by story also finds its ' +
        'task-level messages. Results are product-guarded: only messages whose ' +
        'work_item.product_id you can access are returned. Direct replies of the ' +
        'surviving matches are attached under the same include_archived predicate ' +
        '(default false = active rows only). Retention boundary: rows older than ' +
        'S4M_RETENTION_DAYS (default 60) have moved to the cold-store archive and are ' +
        'NOT searched — an empty result on old work means moved, not never-existed.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ sprint_id, story_id, task_id, include_archived }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        if (!sprint_id && !story_id && !task_id) {
          return toolError(
            'VALIDATION_ERROR: geef minstens één van sprint_id, story_id of task_id',
          )
        }
        const includeArchived = include_archived ?? false

        const idFilters: Record<string, unknown>[] = []
        // Jsonb-padfilter; in-repo precedent: src/flow/effects.ts:129.
        if (sprint_id) idFilters.push({ meta: { path: ['work_item', 'sprint_id'], equals: sprint_id } })
        if (story_id) idFilters.push({ meta: { path: ['work_item', 'story_id'], equals: story_id } })
        if (task_id) idFilters.push({ meta: { path: ['work_item', 'task_id'], equals: task_id } })

        const matchWhere: Record<string, unknown> = {
          AND: idFilters,
          ...legacyMarkerWhere(),
        }
        if (!includeArchived) matchWhere.archived_at = null
        const matches = (await prisma.agentMessage.findMany({
          where: matchWhere as never,
          orderBy: { created_at: 'desc' },
          take: MATCH_LIMIT,
        })) as QueueMessageLike[]
        const truncated = matches.length === MATCH_LIMIT

        // Productguard (spec §5): rijen zonder work_item.product_id nooit
        // teruggeven; per distinct product userCanAccessProduct.
        const productIds = new Set<string>()
        for (const match of matches) {
          const productId = workItemProductId(match.meta)
          if (productId) productIds.add(productId)
        }
        const allowed = new Set<string>()
        for (const productId of productIds) {
          if (await userCanAccessProduct(productId, auth.userId)) allowed.add(productId)
        }
        const kept = matches.filter((match) => {
          const productId = workItemProductId(match.meta)
          return productId !== null && allowed.has(productId)
        })

        // Directe replies van overlevende matches, zelfde archived-predicaat.
        let replies: QueueMessageLike[] = []
        if (kept.length > 0) {
          const replyWhere: Record<string, unknown> = {
            in_reply_to: { in: kept.map((match) => match.id) },
            ...legacyMarkerWhere(),
          }
          if (!includeArchived) replyWhere.archived_at = null
          replies = (await prisma.agentMessage.findMany({
            where: replyWhere as never,
            orderBy: { created_at: 'desc' },
          })) as QueueMessageLike[]
        }

        const combined = [...kept, ...replies].sort(
          (a, b) => b.created_at.getTime() - a.created_at.getTime(),
        )
        return toolJson({
          count: combined.length,
          truncated,
          messages: combined.map(messageView),
        })
      }),
  )
}
