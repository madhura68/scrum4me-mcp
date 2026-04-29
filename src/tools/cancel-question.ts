// ST-1102: cancel_question — alleen de asker (Claude) annuleert een eigen open
// vraag, bv. wanneer hij in de loop van het werk de oplossing zelf vindt en
// het antwoord niet meer relevant is.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  question_id: z.string().min(1),
})

export function registerCancelQuestionTool(server: McpServer) {
  server.registerTool(
    'cancel_question',
    {
      title: 'Cancel question',
      description:
        'Cancel an own open Claude question (only the asker may cancel). ' +
        'Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ question_id }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()

        // Atomic: alleen open vragen van deze asker mogen cancelled worden.
        const result = await prisma.claudeQuestion.updateMany({
          where: {
            id: question_id,
            asked_by: auth.userId,
            status: 'open',
          },
          data: { status: 'cancelled' },
        })

        if (result.count !== 1) {
          // Disambigueer: bestaat de vraag voor deze asker?
          const exists = await prisma.claudeQuestion.findFirst({
            where: { id: question_id, asked_by: auth.userId },
            select: { status: true },
          })
          if (!exists) return toolError(`Question ${question_id} not found or not yours`)
          return toolError(`Question ${question_id} is already ${exists.status}`)
        }

        return toolJson({ question_id, status: 'cancelled' })
      }),
  )
}
