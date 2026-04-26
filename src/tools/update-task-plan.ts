import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessTask } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { taskStatusToApi } from '../status.js'

const inputSchema = z.object({
  task_id: z.string().min(1),
  implementation_plan: z.string(),
})

export function registerUpdateTaskPlanTool(server: McpServer) {
  server.registerTool(
    'update_task_plan',
    {
      title: 'Update task implementation plan',
      description:
        'Save or replace the implementation_plan on a task. ' +
        'Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ task_id, implementation_plan }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        if (!(await userCanAccessTask(task_id, auth.userId))) {
          return toolError(`Task ${task_id} not found or not accessible`)
        }
        const task = await prisma.task.update({
          where: { id: task_id },
          data: { implementation_plan },
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
