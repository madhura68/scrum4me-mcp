import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { resolveTaskRef } from '../lib/resolve-entity.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { TASK_STATUS_API_VALUES, taskStatusFromApi, taskStatusToApi } from '../status.js'
import { updateTaskStatusWithStoryPromotion } from '../lib/tasks-status-update.js'

const inputSchema = z.object({
  task_id: z.string().min(1),
  status: z.enum(TASK_STATUS_API_VALUES as [string, ...string[]]),
  // PBI-50: optionele sprint_run_id voor SPRINT_IMPLEMENTATION-flow.
  // Wanneer aanwezig: server valideert dat task in deze sprint zit, run
  // actief is, en de huidige token een ClaudeJob in deze run heeft geclaimt.
  sprint_run_id: z.string().min(1).optional(),
})

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
    async ({ task_id, status, sprint_run_id }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        const dbStatus = taskStatusFromApi(status)
        if (!dbStatus) {
          return toolError(`Unknown status: ${status}`)
        }
        const ref = await resolveTaskRef(task_id, auth.userId)
        if ('error' in ref) return toolError(ref.error)
        const taskId = ref.id

        // PBI-50: validate explicit sprint_run_id binding.
        if (sprint_run_id) {
          const sprintRun = await prisma.sprintRun.findUnique({
            where: { id: sprint_run_id },
            select: { id: true, status: true, sprint_id: true },
          })
          if (!sprintRun) {
            return toolError(`SprintRun ${sprint_run_id} not found`)
          }
          if (
            sprintRun.status !== 'QUEUED' &&
            sprintRun.status !== 'RUNNING' &&
            sprintRun.status !== 'PAUSED'
          ) {
            return toolError(
              `SprintRun ${sprint_run_id} is in terminal state ${sprintRun.status}; cannot update task status against it`,
            )
          }

          // Task moet in deze sprint zitten
          const task = await prisma.task.findUnique({
            where: { id: taskId },
            select: { story: { select: { sprint_id: true } } },
          })
          if (!task || task.story.sprint_id !== sprintRun.sprint_id) {
            return toolError(
              `Task ${taskId} is not in sprint ${sprintRun.sprint_id} (sprint_run ${sprint_run_id})`,
            )
          }

          // Token-coupling: huidige token moet een actieve ClaudeJob in deze
          // SprintRun hebben geclaimt (typisch de SPRINT_IMPLEMENTATION-job).
          const tokenJob = await prisma.claudeJob.findFirst({
            where: {
              sprint_run_id,
              claimed_by_token_id: auth.tokenId,
              status: { in: ['CLAIMED', 'RUNNING'] },
            },
            select: { id: true },
          })
          if (!tokenJob) {
            return toolError(
              `Forbidden: current token has no active claim in sprint_run ${sprint_run_id}`,
            )
          }
        }

        const { task, storyStatusChange, sprintRunChanged } =
          await updateTaskStatusWithStoryPromotion(taskId, dbStatus, undefined, sprint_run_id)

        // Voor SPRINT-flow: stuur expliciete sprint_run_status mee zodat
        // worker zijn loop kan breken bij FAILED/PAUSED zonder extra query.
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
      }),
  )
}
