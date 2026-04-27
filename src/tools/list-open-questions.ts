// ST-1102: list_open_questions — toont vragen die de tokengebruiker (Claude)
// zelf heeft gesteld, status open of answered. Bedoeld als check-up bij begin
// van een nieuwe sessie: zijn er antwoorden binnengekomen op eerdere vragen?

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'

const MAX_RESULTS = 50

const inputSchema = z.object({
  story_id: z.string().min(1).optional(),
})

export function registerListOpenQuestionsTool(server: McpServer) {
  server.registerTool(
    'list_open_questions',
    {
      title: 'List open questions',
      description:
        'List Claude questions asked by the current token, status open or answered, ' +
        `most recent first (max ${MAX_RESULTS}). Optionally filter by story_id.`,
      inputSchema,
    },
    async ({ story_id }) =>
      withToolErrors(async () => {
        const auth = await getAuth()
        const rows = await prisma.claudeQuestion.findMany({
          where: {
            asked_by: auth.userId,
            status: { in: ['open', 'answered'] },
            ...(story_id ? { story_id } : {}),
          },
          orderBy: { created_at: 'desc' },
          take: MAX_RESULTS,
          select: {
            id: true,
            story_id: true,
            task_id: true,
            status: true,
            question: true,
            answer: true,
            created_at: true,
            answered_at: true,
            expires_at: true,
          },
        })

        return toolJson({
          count: rows.length,
          questions: rows.map((q) => ({
            question_id: q.id,
            story_id: q.story_id,
            task_id: q.task_id,
            status: q.status,
            question: q.question,
            answer: q.answer,
            created_at: q.created_at.toISOString(),
            answered_at: q.answered_at?.toISOString() ?? null,
            expires_at: q.expires_at.toISOString(),
          })),
        })
      }),
  )
}
