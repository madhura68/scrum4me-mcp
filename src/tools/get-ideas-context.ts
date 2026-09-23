import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({ product_id: z.string().min(1) })

export async function handleGetIdeasContext(input: z.input<typeof inputSchema>) {
  return withToolErrors(async () => {
    const { product_id } = inputSchema.parse(input)
    const auth = await getAuth()
    if (!(await userCanAccessProduct(product_id, auth.userId))) {
      return toolError(`Product ${product_id} not found or not accessible`)
    }
    const open_ideas = await prisma.idea.findMany({
      where: {
        user_id: auth.userId, archived: false, status: { not: 'PLANNED' },
        OR: [{ product_id }, { product_id: null }],
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: 50,
      select: { id: true, code: true, title: true, status: true, created_at: true },
    })
    return toolJson({ product_id, limit: 50, open_ideas })
  })
}

export function registerGetIdeasContextTool(server: McpServer) {
  server.registerTool('get_ideas_context', {
    title: 'Compact open ideas context',
    description: 'Read at most 50 of your non-archived, non-PLANNED ideas, oldest first, ' +
      'for this product or without a product. Returns only compact fields, without descriptions or plans. ' +
      'Use get_idea_context for one full idea. This preserves context selection; list_ideas remains a separate product-only list.',
    inputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, handleGetIdeasContext)
}
