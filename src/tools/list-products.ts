import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'

export async function handleListProducts() {
  return withToolErrors(async () => {
    const auth = await getAuth()
    // auth.scopedProducts zit al op de AuthContext — geen tweede token-lookup.
    const scoped = auth.scopedProducts
    const products = await prisma.product.findMany({
      where: {
        archived: false,
        // IDEA-118: scoped token ziet alléén z'n gescopete producten —
        // dit is tevens de startup-gate-check van de copilot-service.
        ...(scoped.length > 0 ? { id: { in: scoped } } : {}),
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
  })
}

export function registerListProductsTool(server: McpServer) {
  server.registerTool(
    'list_products',
    {
      title: 'List accessible products',
      description:
        'List all active products the authenticated user owns or is a member of. ' +
        'Scoped tokens only see their scoped products. ' +
        'Use this to find a product_id for other tools.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => handleListProducts(),
  )
}
