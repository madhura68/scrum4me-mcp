// ST-1102: get_question_answer — vraag de huidige status + antwoord op van een
// eerder gestelde vraag. Bedoeld voor Claude om in een latere sessie het
// resultaat op te pikken (voor wanneer ask_user_question async werd gebruikt).

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  question_id: z.string().min(1),
})

export function registerGetQuestionAnswerTool(server: McpServer) {
  server.registerTool(
    'get_question_answer',
    {
      title: 'Get question answer',
      description:
        'Fetch the current status and (if available) answer for a previously-asked Claude question. ' +
        'Use this when ask_user_question was called with wait_seconds=0 (or timed out) and you want ' +
        'to check whether the user has answered.',
      inputSchema,
    },
    async ({ question_id }) =>
      withToolErrors(async () => {
        const auth = await getAuth()
        const q = await prisma.claudeQuestion.findUnique({
          where: { id: question_id },
          select: {
            id: true,
            product_id: true,
            story_id: true,
            task_id: true,
            status: true,
            question: true,
            options: true,
            answer: true,
            answered_by: true,
            answered_at: true,
            expires_at: true,
          },
        })
        if (!q) return toolError(`Question ${question_id} not found`)
        if (!(await userCanAccessProduct(q.product_id, auth.userId))) {
          return toolError(`Question ${question_id} not accessible`)
        }

        return toolJson({
          question_id: q.id,
          status: q.status,
          story_id: q.story_id,
          task_id: q.task_id,
          question: q.question,
          options: q.options,
          answer: q.answer,
          answered_by: q.answered_by,
          answered_at: q.answered_at?.toISOString() ?? null,
          expires_at: q.expires_at.toISOString(),
        })
      }),
  )
}
