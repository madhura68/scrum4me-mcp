import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { resolveTaskRef } from '../lib/resolve-entity.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { TASK_STATUS_API_VALUES, taskStatusFromApi, taskStatusToApi } from '../status.js'
import { updateTaskStatusWithStoryPromotion } from '../lib/tasks-status-update.js'
import { executePpeMutation, ppeInputSchema } from '../lib/ppe-operation.js'

const inputSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum(TASK_STATUS_API_VALUES as [string, ...string[]]),
  sprint_run_id: z.string().min(1).optional(),
  expected_status: z.enum(TASK_STATUS_API_VALUES as [string, ...string[]]).optional(),
  ppe: ppeInputSchema.optional(),
})

const PPE_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  todo: ['in_progress', 'failed', 'excluded'],
  in_progress: ['review', 'failed'],
  review: ['in_progress', 'done', 'failed'],
  done: [],
  failed: [],
  excluded: [],
}

export async function handleUpdateTaskStatus({
  task_id, status, sprint_run_id, expected_status, ppe,
}: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    const dbStatus = taskStatusFromApi(status)
    if (!dbStatus) return toolError(`Unknown status: ${status}`)
    if ((ppe === undefined) !== (expected_status === undefined)) throw new Error('PPE_INPUT_INCOMPLETE')
    if (ppe && !PPE_STATUS_TRANSITIONS[expected_status!]?.includes(status)) {
      throw new Error('PPE_STATUS_REGRESSION')
    }

    const ref = await resolveTaskRef(task_id, auth.userId)
    if ('error' in ref) return toolError(ref.error)
    const taskId = ref.id

    if (sprint_run_id) {
      const sprintRun = await prisma.sprintRun.findUnique({
        where: { id: sprint_run_id },
        select: { id: true, status: true, sprint_id: true },
      })
      if (!sprintRun) return toolError(`SprintRun ${sprint_run_id} not found`)
      if (!['QUEUED', 'RUNNING', 'PAUSED'].includes(sprintRun.status)) {
        return toolError(`SprintRun ${sprint_run_id} is in terminal state ${sprintRun.status}; cannot update task status against it`)
      }
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        select: { story: { select: { sprint_id: true } } },
      })
      if (!task || task.story.sprint_id !== sprintRun.sprint_id) {
        return toolError(`Task ${taskId} is not in sprint ${sprintRun.sprint_id} (sprint_run ${sprint_run_id})`)
      }
      const tokenJob = await prisma.claudeJob.findFirst({
        where: {
          sprint_run_id,
          claimed_by_token_id: auth.tokenId,
          status: { in: ['CLAIMED', 'RUNNING'] },
        },
        select: { id: true },
      })
      if (!tokenJob) return toolError(`Forbidden: current token has no active claim in sprint_run ${sprint_run_id}`)
    }

    const request = {
      task_id: taskId,
      expected_status: expected_status ?? null,
      target_status: status,
      sprint_run_id: sprint_run_id ?? null,
    }
    return executePpeMutation({
      ppe,
      operationKind: 'TASK_STATUS_CAS',
      targetScope: `task:${taskId}`,
      request,
      authority: 'execution',
      mutate: async () => {
        const mutation = ppe
          ? await prisma.$transaction(async (tx) => {
              const current = await tx.task.findUnique({
                where: { id: taskId },
                select: { status: true },
              })
              const expectedDbStatus = taskStatusFromApi(expected_status!)
              if (!current || !expectedDbStatus || current.status !== expectedDbStatus) {
                throw new Error('PPE_TASK_STATUS_CAS')
              }
              const locked = await tx.task.updateMany({
                where: { id: taskId, status: expectedDbStatus },
                data: { status: expectedDbStatus },
              })
              if (locked.count !== 1) throw new Error('PPE_ZERO_AFFECTED_ROWS')
              return updateTaskStatusWithStoryPromotion(taskId, dbStatus, tx, sprint_run_id)
            })
          : await updateTaskStatusWithStoryPromotion(taskId, dbStatus, undefined, sprint_run_id)

        const { task, storyStatusChange, sprintRunChanged } = mutation
        let sprintRunStatusChange: string | null = null
        if (sprintRunChanged && sprint_run_id) {
          const updated = await prisma.sprintRun.findUnique({
            where: { id: sprint_run_id },
            select: { status: true },
          })
          sprintRunStatusChange = updated?.status ?? null
        }
        return toolJson({
          id: task.id,
          status: taskStatusToApi(task.status),
          implementation_plan: task.implementation_plan,
          story_status_change: storyStatusChange,
          sprint_run_status_change: sprintRunStatusChange,
        })
      },
    })
  })
}

export function registerUpdateTaskStatusTool(server: McpServer) {
  server.registerTool(
    'update_task_status',
    {
      title: 'Update task status',
      description:
        'Set the status of a task. Allowed values: todo, in_progress, review, done, failed. ' +
        'Optional sprint_run_id binds the update to a SPRINT_IMPLEMENTATION run for ' +
        'cascade-propagation; the server validates that the task belongs to the sprint ' +
        'and that the calling token has claimed a job in that run. ' +
        'Forbidden for demo accounts.',
      inputSchema,
    },
    handleUpdateTaskStatus,
  )
}
