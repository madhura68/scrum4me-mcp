// IDEA-118: idea aanmaken vanuit de copilot-chat. Code-generatie en
// transactie-vorm identiek aan Scrum4Me actions/ideas.ts createIdeaAction.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { nextIdeaCode } from '../lib/idea-code.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { parseContentPolicy, checkContentPolicy, ContentPolicyError } from '@shared/content-policy.js'

const inputSchema = z.object({
  product_id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional(),
})

export async function handleCreateIdea(input: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const parsed = inputSchema.parse(input)
    const auth = await requireWriteAccess()
    if (!(await userCanAccessProduct(parsed.product_id, auth.userId))) {
      return toolError(`Product ${parsed.product_id} not found or not accessible`)
    }

    // AVG content-policy gate (sub-project C): weiger verboden veld-/feature-
    // verzoeken vóór er een idee ontstaat. Fail-closed bij een malformed policy.
    const product = await prisma.product.findUnique({
      where: { id: parsed.product_id },
      select: { content_policy: true },
    })
    let policy
    try {
      policy = parseContentPolicy(product?.content_policy)
    } catch (err) {
      if (err instanceof ContentPolicyError) {
        return toolError(`Product content_policy is ongeldig geconfigureerd: ${err.message}`)
      }
      throw err
    }
    const verdict = checkContentPolicy(policy, `${parsed.title}\n${parsed.description ?? ''}`)
    if (!verdict.allowed) {
      return toolError(verdict.reason)
    }

    const idea = await prisma.$transaction(async (tx) => {
      const code = await nextIdeaCode(auth.userId, tx)
      return tx.idea.create({
        data: {
          user_id: auth.userId,
          product_id: parsed.product_id,
          code,
          title: parsed.title,
          description: parsed.description ?? null,
          status: 'DRAFT',
        },
        select: { id: true, code: true },
      })
    })
    return toolJson({ id: idea.id, code: idea.code, status: 'DRAFT' })
  })
}

export function registerCreateIdeaTool(server: McpServer) {
  server.registerTool(
    'create_idea',
    {
      title: 'Create idea',
      description:
        'Create a new DRAFT idea for a product. The code (IDEA-nnn) is generated server-side. Forbidden for demo accounts.',
      inputSchema,
    },
    async (input) => handleCreateIdea(input),
  )
}
