// Phase 3 (TASK_REVIEW): nieuwste implementatie-context van een task.
// DONE-SprintTaskExecution wint van de TASK_IMPLEMENTATION-job-velden:
// executie-sha's zijn in prod 100% gevuld, job-sha's ~36-42% (spec §5).

import { prisma } from '../prisma.js'

export type TaskImplContext = {
  plan_snapshot: string | null
  base_sha: string | null
  head_sha: string | null
  pr_url: string | null
  execution_id: string | null
}

export async function resolveTaskImplContext(taskId: string): Promise<TaskImplContext> {
  const execution = await prisma.sprintTaskExecution.findFirst({
    where: { task_id: taskId, status: 'DONE' },
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      plan_snapshot: true,
      base_sha: true,
      head_sha: true,
      sprint_job: { select: { pr_url: true } },
    },
  })
  const implJob = await prisma.claudeJob.findFirst({
    where: { task_id: taskId, kind: 'TASK_IMPLEMENTATION' },
    orderBy: { created_at: 'desc' },
    select: { plan_snapshot: true, base_sha: true, head_sha: true, pr_url: true },
  })

  if (execution) {
    return {
      plan_snapshot: execution.plan_snapshot ?? null,
      base_sha: execution.base_sha ?? null,
      head_sha: execution.head_sha ?? null,
      pr_url: execution.sprint_job?.pr_url ?? implJob?.pr_url ?? null,
      execution_id: execution.id,
    }
  }
  if (implJob) {
    return {
      plan_snapshot: implJob.plan_snapshot,
      base_sha: implJob.base_sha,
      head_sha: implJob.head_sha,
      pr_url: implJob.pr_url,
      execution_id: null,
    }
  }
  return { plan_snapshot: null, base_sha: null, head_sha: null, pr_url: null, execution_id: null }
}
