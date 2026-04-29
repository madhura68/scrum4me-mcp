// MCP authoring tool: create een Product Backlog Item.
//
// Sort_order wordt automatisch op last+1 binnen de prioriteits-groep gezet als
// niet meegegeven. Code-veld blijft null — auto-codes (PBI-1, PBI-2, …) worden
// door de Scrum4Me-app gegenereerd, kan optioneel later via UI worden gezet.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  product_id: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  priority: z.number().int().min(1).max(4),
  sort_order: z.number().optional(),
})

export function registerCreatePbiTool(server: McpServer) {
  server.registerTool(
    'create_pbi',
    {
      title: 'Create PBI',
      description:
        'Add a Product Backlog Item to a product. Sort_order auto-set to last+1 within the priority group if not provided. Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ product_id, title, description, priority, sort_order }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        if (!(await userCanAccessProduct(product_id, auth.userId))) {
          return toolError(`Product ${product_id} not found or not accessible`)
        }

        let resolvedSortOrder = sort_order
        if (resolvedSortOrder === undefined) {
          const last = await prisma.pbi.findFirst({
            where: { product_id, priority },
            orderBy: { sort_order: 'desc' },
            select: { sort_order: true },
          })
          resolvedSortOrder = (last?.sort_order ?? 0) + 1.0
        }

        const pbi = await prisma.pbi.create({
          data: {
            product_id,
            title,
            description: description ?? null,
            priority,
            sort_order: resolvedSortOrder,
          },
          select: {
            id: true,
            title: true,
            description: true,
            priority: true,
            sort_order: true,
            created_at: true,
          },
        })
        return toolJson(pbi)
      }),
  )
}
