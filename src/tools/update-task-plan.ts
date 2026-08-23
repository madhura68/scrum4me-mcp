import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessTask } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { taskStatusToApi } from '../status.js'
import { executePpeMutation, ppeInputSchema, sha256PpeBytes } from '../lib/ppe-operation.js'

const inputSchema = z.object({
  task_id: z.string().min(1),
  implementation_plan: z.string(),
  expected_current_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  replacement_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  ppe: ppeInputSchema.optional(),
})

export async function handleUpdateTaskPlan({
  task_id, implementation_plan, expected_current_hash, replacement_hash, ppe,
}: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    if (!(await userCanAccessTask(task_id, auth.userId))) {
      return toolError(`Task ${task_id} not found or not accessible`)
    }
    const casComplete = expected_current_hash !== undefined && replacement_hash !== undefined
    if ((ppe !== undefined) !== casComplete) throw new Error('PPE_INPUT_INCOMPLETE')
    const request = {
      task_id,
      expected_current_hash: expected_current_hash ?? null,
      replacement_hash: replacement_hash ?? null,
      implementation_plan,
    }
    return executePpeMutation({
      ppe,
      operationKind: 'TASK_PLAN_CAS',
      targetScope: `task:${task_id}`,
      request,
      authority: 'composition',
      mutate: async () => {
        if (!ppe) {
          const task = await prisma.task.update({
            where: { id: task_id },
            data: { implementation_plan },
            select: { id: true, status: true, implementation_plan: true },
          })
          return toolJson({ id: task.id, status: taskStatusToApi(task.status), implementation_plan: task.implementation_plan })
        }
        if (sha256PpeBytes(implementation_plan) !== replacement_hash) throw new Error('PPE_TASK_PLAN_REPLACEMENT_HASH')
        const task = await prisma.$transaction(async (tx) => {
          const current = await tx.task.findUnique({
            where: { id: task_id },
            select: { id: true, status: true, implementation_plan: true },
          })
          if (!current || sha256PpeBytes(current.implementation_plan) !== expected_current_hash) {
            throw new Error('PPE_TASK_PLAN_CAS')
          }
          const changed = await tx.task.updateMany({
            where: { id: task_id, implementation_plan: current.implementation_plan },
            data: { implementation_plan },
          })
          if (changed.count !== 1) throw new Error('PPE_ZERO_AFFECTED_ROWS')
          return { ...current, implementation_plan }
        })
        return toolJson({ id: task.id, status: taskStatusToApi(task.status), implementation_plan: task.implementation_plan })
      },
    })
  })
}

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
    handleUpdateTaskPlan,
  )
}
