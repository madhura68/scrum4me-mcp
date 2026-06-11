import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const STATUS_VALUES = [
  'DRAFT', 'GRILLING', 'GRILL_FAILED', 'GRILLED', 'PLANNING', 'PLAN_FAILED',
  'PLAN_READY', 'REVIEWING_PLAN', 'PLAN_REVIEW_FAILED', 'PLAN_REVIEWED', 'PLANNED',
] as const

const inputSchema = z.object({
  product_id: z.string().min(1),
  status: z.enum(STATUS_VALUES).optional(),
  include_archived: z.boolean().optional(),
})

export async function handleListIdeas(input: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const parsed = inputSchema.parse(input)
    const auth = await getAuth()
    if (!(await userCanAccessProduct(parsed.product_id, auth.userId))) {
      return toolError(`Product ${parsed.product_id} not found or not accessible`)
    }
    const ideas = await prisma.idea.findMany({
      where: {
        user_id: auth.userId,
        product_id: parsed.product_id,
        ...(parsed.include_archived ? {} : { archived: false }),
        ...(parsed.status ? { status: parsed.status } : {}),
      },
      orderBy: { updated_at: 'desc' },
      take: 50,
      select: { id: true, code: true, title: true, status: true, updated_at: true },
    })
    return toolJson(ideas)
  })
}

export function registerListIdeasTool(server: McpServer) {
  server.registerTool(
    'list_ideas',
    {
      title: 'List ideas',
      description: 'List ideas of a product (max 50, newest first). Optional status filter.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => handleListIdeas(input),
  )
}
