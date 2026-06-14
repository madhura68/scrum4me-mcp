import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  question_id: z.string().min(1),
  product_id: z.string().min(1),
  answer: z.string().min(1).max(4000),
})

export function registerAnswerQuestionTool(server: McpServer) {
  server.registerTool(
    'answer_question',
    {
      title: 'Answer an open idea question',
      description:
        'Beantwoord een open grill-vraag op een idee dat de binding-user bezit (namens de binding-user).',
      inputSchema,
    },
    async ({ question_id, product_id, answer }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        // 154-P1 token-scope-guard EERST (mirror list_ideas/create_idea).
        if (!(await userCanAccessProduct(product_id, auth.userId))) {
          return toolError(`Product ${product_id} not found or not accessible`)
        }
        const q = await prisma.claudeQuestion.findUnique({
          where: { id: question_id },
          select: {
            idea_id: true,
            options: true,
            idea: { select: { user_id: true, product_id: true } },
          },
        })
        if (!q || !q.idea_id || !q.idea || q.idea.user_id !== auth.userId || q.idea.product_id !== product_id) {
          return toolError('Question not found')
        }
        const opts = Array.isArray(q.options)
          ? (q.options as unknown[]).filter((o): o is string => typeof o === 'string')
          : []
        if (opts.length > 0 && !opts.includes(answer)) {
          return toolError('Invalid answer option')
        }
        const res = await prisma.claudeQuestion.updateMany({
          where: {
            id: question_id,
            status: 'open',
            expires_at: { gt: new Date() },
            idea: { is: { user_id: auth.userId, product_id } },
          },
          data: { status: 'answered', answer, answered_by: auth.userId, answered_at: new Date() },
        })
        if (res.count === 0) return toolError('Question already answered or expired')
        return toolJson({ ok: true, question_id })
      }),
  )
}
