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
        'Resolve the binding guide for explicit inspection, a missing startup guide, or a job without an applicable guide. ' +
        'Combines the global default with active runtime, exact-model and product supplements. ' +
        'Use the same product and agent input as a preceding get_context call, or the job product and known identity when no guide was supplied. ' +
        'Include known runtime, omit only an unknown model_id, and omit agent if runtime is unknown; never guess identity. ' +
        'Read guide_md, check agent_context.applied_profiles and follow the guide for task distribution, subagent model selection and verification within the assignment. ' +
        'Keep the user- or runner-selected main model unchanged. An available guide needs no second call, and a missing profile alone is not a reason to retry. ' +
        'If this fallback fails, report the missing guide without a retry loop. Direct inspection and explicit refresh remain available.',
      inputSchema: productContextInputSchema,
      annotations: { readOnlyHint: true },
    },
    handleGetAgentGuide,
  )
}
