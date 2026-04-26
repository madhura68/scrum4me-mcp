import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessTask } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { TASK_STATUS_API_VALUES, taskStatusFromApi, taskStatusToApi } from '../status.js'

const inputSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum(TASK_STATUS_API_VALUES as [string, ...string[]]),
})

export function registerUpdateTaskStatusTool(server: McpServer) {
  server.registerTool(
    'update_task_status',
    {
      title: 'Update task status',
      description:
        'Set the status of a task. Allowed values: todo, in_progress, review, done. ' +
        'Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ task_id, status }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        const dbStatus = taskStatusFromApi(status)
        if (!dbStatus) {
          return toolError(`Unknown status: ${status}`)
        }
        if (!(await userCanAccessTask(task_id, auth.userId))) {
          return toolError(`Task ${task_id} not found or not accessible`)
        }
        const task = await prisma.task.update({
          where: { id: task_id },
          data: { status: dbStatus },
          select: { id: true, status: true, implementation_plan: true },
        })
        return toolJson({
          id: task.id,
          status: taskStatusToApi(task.status),
          implementation_plan: task.implementation_plan,
        })
      }),
  )
}
