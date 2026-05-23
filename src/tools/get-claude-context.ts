import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { storyStatusToApi, taskStatusToApi } from '../status.js'
import { resolveAgentGuide } from '../lib/agent-guide.js'

const inputSchema = z.object({
  product_id: z.string().min(1),
})

export function registerGetClaudeContextTool(server: McpServer) {
  server.registerTool(
    'get_claude_context',
    {
      title: 'Bundled context for Claude Code',
      description:
        'Fetch product, active sprint, next story (with tasks) and open todos in one call. ' +
        'Always start a Scrum4Me workflow with this tool.',
      inputSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ product_id }) =>
      withToolErrors(async () => {
        const auth = await getAuth()

        const product = await prisma.product.findFirst({
          where: {
            id: product_id,
            OR: [
              { user_id: auth.userId },
              { members: { some: { user_id: auth.userId } } },
            ],
          },
          select: {
            id: true,
            code: true,
            name: true,
            description: true,
            repo_url: true,
            definition_of_done: true,
            enabled_doc_folders: true,
          },
        })

        if (!product) {
          return toolError(`Product ${product_id} not found or not accessible`)
        }

        const activeSprint = await prisma.sprint.findFirst({
          where: { product_id, status: 'OPEN' },
          orderBy: { created_at: 'desc' },
          select: { id: true, sprint_goal: true, status: true },
        })

        let nextStory = null
        if (activeSprint) {
          const story = await prisma.story.findFirst({
            where: {
              sprint_id: activeSprint.id,
              status: { in: ['OPEN', 'IN_SPRINT'] },
              OR: [
                { tasks: { none: {} } },
                { tasks: { some: { status: { not: 'DONE' } } } },
              ],
            },
            orderBy: [{ priority: 'asc' }, { sort_order: 'asc' }],
            select: {
              id: true,
              code: true,
              title: true,
              description: true,
              acceptance_criteria: true,
              priority: true,
              status: true,
              tasks: {
                orderBy: [{ priority: 'asc' }, { sort_order: 'asc' }],
                select: {
                  id: true,
                  title: true,
                  description: true,
                  implementation_plan: true,
                  priority: true,
                  sort_order: true,
                  status: true,
                },
              },
            },
          })
          if (story) {
            nextStory = {
              ...story,
              status: storyStatusToApi(story.status),
              tasks: story.tasks.map((t, i) => ({
                ...t,
                code: story.code ? `${story.code}.${i + 1}` : null,
                status: taskStatusToApi(t.status),
              })),
            }
          }
        }

        const openIdeas = await prisma.idea.findMany({
          where: {
            user_id: auth.userId,
            archived: false,
            status: { not: 'PLANNED' },
            OR: [{ product_id: product_id }, { product_id: null }],
          },
          orderBy: { created_at: 'asc' },
          take: 50,
          select: {
            id: true,
            code: true,
            title: true,
            description: true,
            status: true,
            created_at: true,
          },
        })

        let agent_guide: string | null = null
        let agent_guide_error: string | null = null
        try {
          const guide = await resolveAgentGuide(product)
          agent_guide = guide.guide_md
        } catch (err) {
          agent_guide_error = err instanceof Error ? err.message : String(err)
        }

        return toolJson({
          product,
          active_sprint: activeSprint,
          next_story: nextStory,
          open_ideas: openIdeas,
          agent_guide,
          agent_guide_error,
        })
      }),
  )
}
