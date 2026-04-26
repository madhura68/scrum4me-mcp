import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessStory } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  story_id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(['PASSED', 'FAILED']),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export function registerLogTestResultTool(server: McpServer) {
  server.registerTool(
    'log_test_result',
    {
      title: 'Log test result',
      description:
        'Append a TEST_RESULT entry (PASSED or FAILED) to a story log. ' +
        'Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ story_id, content, status, metadata }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        if (!(await userCanAccessStory(story_id, auth.userId))) {
          return toolError(`Story ${story_id} not found or not accessible`)
        }
        const log = await prisma.storyLog.create({
          data: {
            story_id,
            type: 'TEST_RESULT',
            content,
            status,
            metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          },
          select: { id: true, created_at: true },
        })
        return toolJson({ id: log.id, created_at: log.created_at })
      }),
  )
}
