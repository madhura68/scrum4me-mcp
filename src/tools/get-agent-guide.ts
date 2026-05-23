import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { resolveAgentGuide } from '../lib/agent-guide.js'

const inputSchema = z.object({
  product_id: z.string().min(1),
})

export function registerGetAgentGuideTool(server: McpServer) {
  server.registerTool(
    'get_agent_guide',
    {
      title: 'Build & document guide for a product',
      description:
        'Resolve the binding build & document guide for a product (global default ' +
        'plus an optional per-product override). Call this and follow guide_md before ' +
        'building or documenting.',
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ product_id }) =>
      withToolErrors(async () => {
        const auth = await getAuth()
        const product = await prisma.product.findFirst({
          where: {
            id: product_id,
            OR: [
              { user_id: auth.userId },
              { members: { some: { user_id: auth.userId } } },
            ],
          },
          select: { id: true, code: true, name: true, enabled_doc_folders: true },
        })
        if (!product) {
          return toolError(`Product ${product_id} not found or not accessible`)
        }
        const result = await resolveAgentGuide(product)
        return toolJson(result)
      }),
  )
}
