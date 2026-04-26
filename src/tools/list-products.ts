import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'

export function registerListProductsTool(server: McpServer) {
  server.registerTool(
    'list_products',
    {
      title: 'List accessible products',
      description:
        'List all active products the authenticated user owns or is a member of. ' +
        'Use this to find a product_id for other tools.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      withToolErrors(async () => {
        const auth = await getAuth()
        const products = await prisma.product.findMany({
          where: {
            archived: false,
            OR: [
              { user_id: auth.userId },
              { members: { some: { user_id: auth.userId } } },
            ],
          },
          orderBy: { created_at: 'desc' },
          select: {
            id: true,
            code: true,
            name: true,
            description: true,
            repo_url: true,
            definition_of_done: true,
          },
        })
        return toolJson(products)
      }),
  )
}
