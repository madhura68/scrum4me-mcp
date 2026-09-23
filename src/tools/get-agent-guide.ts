import type { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { resolveAgentGuide } from '../lib/agent-guide.js'
import { productContextInputSchema } from '../lib/agent-context.js'

export async function handleGetAgentGuide(input: z.input<typeof productContextInputSchema>) {
  return withToolErrors(async () => {
    const { product_id, agent } = productContextInputSchema.parse(input)
    const auth = await getAuth()
    if (!(await userCanAccessProduct(product_id, auth.userId))) {
      return toolError(`Product ${product_id} not found or not accessible`)
    }
    const product = await prisma.product.findFirst({
      where: { id: product_id },
      select: { id: true, code: true, name: true, enabled_doc_folders: true },
    })
    if (!product) return toolError(`Product ${product_id} not found or not accessible`)
    return toolJson(await resolveAgentGuide(product, agent))
  })
}

export function registerGetAgentGuideTool(server: McpServer) {
  server.registerTool(
    'get_agent_guide',
    {
      title: 'Build & document guide for a product',
      description:
        'Resolve the binding build & document guide for a product (global default ' +
        'plus optional active runtime, exact-model and product supplements). Optionally pass the known ' +
        'agent runtime and exact model_id, as with get_context. Call this and follow guide_md before building or documenting.',
      inputSchema: productContextInputSchema,
      annotations: { readOnlyHint: true },
    },
    handleGetAgentGuide,
  )
}
