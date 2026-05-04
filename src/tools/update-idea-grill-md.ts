// MCP-tool: schrijft het grill_md-resultaat na een IDEA_GRILL-job en zet
// de idea-status op GRILLED. Logt een IdeaLog{GRILL_RESULT}-entry.
//
// Wordt aangeroepen door de worker als laatste stap van een grill-sessie.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userOwnsIdea } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  idea_id: z.string().min(1),
  markdown: z.string().min(1).max(64_000),
})

export function registerUpdateIdeaGrillMdTool(server: McpServer) {
  server.registerTool(
    'update_idea_grill_md',
    {
      title: 'Update idea grill_md',
      description:
        'Save the grill-result markdown for an idea and transition status to GRILLED. Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ idea_id, markdown }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        if (!(await userOwnsIdea(idea_id, auth.userId))) {
          return toolError('Idea not found')
        }

        const result = await prisma.$transaction([
          prisma.idea.update({
            where: { id: idea_id },
            data: { grill_md: markdown, status: 'GRILLED' },
            select: { id: true, status: true, code: true },
          }),
          prisma.ideaLog.create({
            data: {
              idea_id,
              type: 'GRILL_RESULT',
              content: `Grill result (${markdown.length} chars)`,
              metadata: { length: markdown.length },
            },
          }),
        ])

        return toolJson({
          ok: true,
          idea: result[0],
        })
      }),
  )
}
