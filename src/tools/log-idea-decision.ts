// MCP-tool: agents loggen een tussentijdse beslissing of notitie tijdens
// een grill- of make-plan-sessie. Verschijnt in de Timeline-tab van de
// idea-detailpagina.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Prisma } from '@prisma/client'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userOwnsIdea } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  idea_id: z.string().min(1),
  type: z.enum(['DECISION', 'NOTE']),
  content: z.string().min(1).max(4_000),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export function registerLogIdeaDecisionTool(server: McpServer) {
  server.registerTool(
    'log_idea_decision',
    {
      title: 'Log idea decision/note',
      description:
        "Append a DECISION or NOTE entry to an idea's timeline. Use to capture deliberations during grill or make-plan sessions. Forbidden for demo accounts.",
      inputSchema,
    },
    async ({ idea_id, type, content, metadata }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        if (!(await userOwnsIdea(idea_id, auth.userId))) {
          return toolError('Idea not found')
        }

        const log = await prisma.ideaLog.create({
          data: {
            idea_id,
            type,
            content,
            metadata: (metadata as Prisma.InputJsonValue | undefined) ?? undefined,
          },
          select: { id: true, type: true, created_at: true },
        })

        return toolJson({
          ok: true,
          log: {
            id: log.id,
            type: log.type,
            created_at: log.created_at.toISOString(),
          },
        })
      }),
  )
}
