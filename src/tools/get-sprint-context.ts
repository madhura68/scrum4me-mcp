import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { storyStatusToApi, taskStatusToApi } from '../status.js'

const inputSchema = z.object({
  sprint_id: z.string().min(1),
  task_id: z.string().min(1).optional(),
})

export async function handleGetSprintContext(input: z.input<typeof inputSchema>) {
  return withToolErrors(async () => {
    const { sprint_id, task_id } = inputSchema.parse(input)
    const auth = await getAuth()
    const sprint = await prisma.sprint.findUnique({
      where: { id: sprint_id },
      select: {
        id: true, code: true, product_id: true, sprint_goal: true, status: true,
        start_date: true, end_date: true, completed_at: true,
      },
    })
    if (!sprint || !(await userCanAccessProduct(sprint.product_id, auth.userId))) {
      return toolError(`Sprint ${sprint_id} not found or not accessible`)
    }

    const stories = await prisma.story.findMany({
      where: { sprint_id: sprint.id, product_id: sprint.product_id },
      orderBy: [
        { pbi: { sort_order: 'asc' } }, { pbi: { created_at: 'asc' } }, { pbi: { id: 'asc' } },
        { sort_order: 'asc' }, { created_at: 'asc' }, { id: 'asc' },
      ],
      select: {
        id: true, code: true, title: true, status: true, priority: true, sort_order: true,
        pbi: { select: { id: true, code: true, title: true } },
        tasks: {
          orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }, { id: 'asc' }],
          select: { id: true, code: true, title: true, status: true, priority: true, sort_order: true },
        },
      },
    })

    let selected_task = null
    if (task_id) {
      // Story membership is authoritative; do not trust the denormalized Task.sprint_id.
      const task = await prisma.task.findFirst({
        where: { id: task_id, story: { sprint_id: sprint.id, product_id: sprint.product_id } },
        select: {
          id: true, code: true, title: true, status: true, priority: true, sort_order: true,
          description: true, implementation_plan: true, repo_url: true,
          story: { select: { id: true, code: true, title: true, description: true, acceptance_criteria: true } },
        },
      })
      if (!task) return toolError(`Task ${task_id} not found or not accessible in sprint ${sprint_id}`)
      selected_task = { ...task, status: taskStatusToApi(task.status) }
    }

    return toolJson({
      sprint,
      stories: stories.map((story) => ({
        ...story,
        status: storyStatusToApi(story.status),
        tasks: story.tasks.map((task) => ({ ...task, status: taskStatusToApi(task.status) })),
      })),
      selected_task,
    })
  })
}

export function registerGetSprintContextTool(server: McpServer) {
  server.registerTool('get_sprint_context', {
    title: 'Compact sprint context and one optional task plan',
    description: 'Read a sprint by database ID with all stories and tasks, including terminal statuses, ' +
      'in PBI/story/task sort_order. The overview excludes descriptions and plans. ' +
      'Pass one task_id in a separate call for that task\'s full description, implementation_plan and story acceptance criteria. ' +
      'No task_id returns selected_task: null. Accessible closed sprints can also be read. This does not select or start work.',
    inputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, handleGetSprintContext)
}
