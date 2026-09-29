import type { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { resolveProductRef } from '../lib/resolve-entity.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { resolveAgentGuide } from '../lib/agent-guide.js'
import { agentContext, productContextInputSchema } from '../lib/agent-context.js'

export async function handleGetContext(input: z.input<typeof productContextInputSchema>) {
  return withToolErrors(async () => {
    const { product_id, agent } = productContextInputSchema.parse(input)
    const auth = await getAuth()
    const ref = await resolveProductRef(product_id, auth.userId)
    if ('error' in ref) return toolError(ref.error)
    if (!(await userCanAccessProduct(ref.id, auth.userId))) {
      return toolError(`Product ${product_id} not found or not accessible`)
    }
    const product = await prisma.product.findFirst({
      where: { id: ref.id },
      select: {
        id: true, code: true, name: true, description: true, repo_url: true,
        definition_of_done: true, enabled_doc_folders: true,
      },
    })
    if (!product) return toolError(`Product ${product_id} not found or not accessible`)

    const active_sprints = await prisma.sprint.findMany({
      where: { product_id: product.id, status: 'OPEN' },
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      select: { id: true, code: true, sprint_goal: true, status: true, start_date: true },
    })

    let agent_guide: string | null = null
    let agent_guide_error: string | null = null
    let agent_context = agentContext(agent, null, null)
    try {
      const guide = await resolveAgentGuide(product, agent)
      agent_guide = guide.guide_md
      agent_context = guide.agent_context
    } catch (error) {
      agent_guide_error = error instanceof Error ? error.message : String(error)
    }

    return toolJson({ product, active_sprints, agent_context, agent_guide, agent_guide_error })
  })
}

export function registerGetContextTool(server: McpServer) {
  const definition = {
    title: 'Compact product and agent context',
    description:
      'Start an interactive main session, or restore it after compaction, with the product, every OPEN sprint and the applicable agent guide. ' +
      'Include known agent.runtime even if model_id is unknown; include only an exact known model_id. Omit agent if runtime is unknown; never guess identity. ' +
      'Read agent_guide, check agent_context.applied_profiles and follow the guide for task distribution, subagent model selection and verification. Keep the user-selected main model unchanged. ' +
      'Fetch get_agent_guide once with the same product/agent input only if the guide is missing or empty; a missing profile alone needs no extra call. ' +
      'Subagents use delegated context; worker jobs follow their kind prompt/payload instead of automatically repeating this startup. ' +
      'Use get_sprint_context for the assigned sprint and one task plan, or get_ideas_context when relevant. Preserve the assignment after compaction; context does not start other work.',
    inputSchema: productContextInputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }
  server.registerTool('get_context', definition, handleGetContext)
  server.registerTool('get_claude_context', {
    ...definition,
    title: 'Deprecated alias for get_context',
    description: 'Deprecated: use get_context. This alias returns the same compact response; ' +
      'active_sprint, next_story and open_ideas are no longer included. ' + definition.description,
  }, handleGetContext)
}
