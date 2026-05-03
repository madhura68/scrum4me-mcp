import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const ACTIVE_STATUSES = ['QUEUED', 'CLAIMED', 'RUNNING'] as const

const inputSchema = z.object({
  product_id: z.string().min(1).optional(),
})

export function registerCheckQueueEmptyTool(server: McpServer) {
  server.registerTool(
    'check_queue_empty',
    {
      title: 'Check queue empty',
      description:
        'Synchronous, non-blocking check of how many ClaudeJobs are still active ' +
        "(QUEUED, CLAIMED, RUNNING). Optionally scoped to one product via product_id; " +
        'without it, aggregates across all accessible products. ' +
        "Use after the last update_job_status('done') in a batch to decide whether to " +
        'keep working or finalize. Forbidden for demo accounts.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ product_id }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        const { userId } = auth

        if (product_id) {
          if (!(await userCanAccessProduct(product_id, userId))) {
            return toolError(`Product ${product_id} not found or not accessible`)
          }
          const remaining = await prisma.claudeJob.count({
            where: {
              user_id: userId,
              product_id,
              status: { in: [...ACTIVE_STATUSES] },
            },
          })
          return toolJson({ empty: remaining === 0, remaining })
        }

        const groups = await prisma.claudeJob.groupBy({
          by: ['product_id'],
          where: {
            user_id: userId,
            status: { in: [...ACTIVE_STATUSES] },
            product: {
              OR: [
                { user_id: userId },
                { members: { some: { user_id: userId } } },
              ],
            },
          },
          _count: true,
        })

        const by_product = Object.fromEntries(groups.map((g) => [g.product_id, g._count]))
        const remaining = groups.reduce((sum, g) => sum + g._count, 0)
        return toolJson({ empty: remaining === 0, remaining, by_product })
      }),
  )
}
