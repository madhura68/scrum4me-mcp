import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({ product_id: z.string().min(1) })

export function registerListIdeaQuestionsTool(server: McpServer) {
  server.registerTool(
    'list_idea_questions',
    {
      title: 'List open idea questions',
      description:
        'Open vragen op ideeën die de huidige binding-user bezit, in dit product (voor de copilot-vraag-kaart).',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ product_id }) =>
      withToolErrors(async () => {
        const auth = await getAuth()
        if (!(await userCanAccessProduct(product_id, auth.userId))) {
          return toolError(`Product ${product_id} not found or not accessible`)
        }
        const rows = await prisma.claudeQuestion.findMany({
          where: {
            product_id,
            status: 'open',
            expires_at: { gt: new Date() },
            idea: { is: { user_id: auth.userId, product_id } },
          },
          orderBy: { created_at: 'desc' },
          take: 50,
          select: {
            id: true,
            idea_id: true,
            question: true,
            options: true,
            created_at: true,
            expires_at: true,
            idea: { select: { code: true, title: true } },
          },
        })
        return toolJson({
          count: rows.length,
          questions: rows.map((q) => ({
            question_id: q.id,
            idea_id: q.idea_id,
            idea_code: q.idea?.code ?? null,
            idea_title: q.idea?.title ?? null,
            question: q.question,
            options: q.options ?? null,
            created_at: q.created_at.toISOString(),
            expires_at: q.expires_at.toISOString(),
          })),
        })
      }),
  )
}
