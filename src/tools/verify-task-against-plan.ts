import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { getGitDiff } from '../git/diff.js'
import { resolveTaskRef } from '../lib/resolve-entity.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { classifyDiffAgainstPlan, type VerifyResultValue } from '../verify/classify.js'

const inputSchema = z.object({
  task_id: z.string().min(1),
  worktree_path: z.string().min(1),
})

export async function getDiffInWorktree(
  worktreePath: string,
  baseSha?: string,
): Promise<string> {
  // PBI-47 (P0): when base_sha is provided, diff against the per-job base
  // captured at claim-time so verify only sees the current task's changes.
  // Falls back to origin/main only for legacy callers without base_sha.
  const range = baseSha ? `${baseSha}...HEAD` : 'origin/main...HEAD'
  return getGitDiff(worktreePath, range)
}

export async function saveVerifyResult(jobId: string, result: VerifyResultValue): Promise<void> {
  await prisma.claudeJob.update({
    where: { id: jobId },
    data: { verify_result: result },
  })
}

export function registerVerifyTaskAgainstPlanTool(server: McpServer) {
  server.registerTool(
    'verify_task_against_plan',
    {
      title: 'Verify task against plan',
      description:
        'Run `git diff origin/main...HEAD` in the worktree and compare it against the ' +
        'frozen plan_snapshot captured at claim time. Returns ALIGNED|PARTIAL|EMPTY|DIVERGENT ' +
        'and saves verify_result on the active job. ' +
        'Call this BEFORE update_job_status("done"). ' +
        'If the result is EMPTY and task.verify_only is false, update_job_status("done") will be rejected.',
      inputSchema,
      annotations: { readOnlyHint: false },
    },
    async ({ task_id, worktree_path }) =>
      withToolErrors(async () => {
        const auth = await getAuth()
        if (!auth) return toolError('Unauthorized')
        const ref = await resolveTaskRef(task_id, auth.userId)
        if ('error' in ref) return toolError(ref.error)
        const taskId = ref.id

        const task = await prisma.task.findUnique({
          where: { id: taskId },
          select: {
            id: true,
            verify_only: true,
            claude_jobs: {
              where: { status: { in: ['CLAIMED', 'RUNNING'] } },
              orderBy: { created_at: 'desc' },
              take: 1,
              select: { id: true, plan_snapshot: true, base_sha: true },
            },
          },
        })

        if (!task) return toolError(`Task ${taskId} not found`)

        const activeJob = task.claude_jobs[0] ?? null

        // PBI-47 (P0): require base_sha so diff is scoped to this job's work,
        // not the full origin/main...HEAD which would include sibling commits
        // on a reused story/sprint branch.
        if (activeJob && !activeJob.base_sha) {
          return toolError(
            'MISSING_BASE_SHA: This claim has no base_sha. '
              + 'Re-claim the task (cancel + wait_for_job) so a fresh base_sha is captured.',
          )
        }

        let diff: string
        try {
          diff = await getDiffInWorktree(worktree_path, activeJob?.base_sha ?? undefined)
        } catch (err) {
          return toolError(
            `git diff failed in worktree (${worktree_path}): ${(err as Error).message ?? 'unknown error'}`,
          )
        }

        const { result, reasoning } = classifyDiffAgainstPlan({
          diff,
          plan: activeJob?.plan_snapshot ?? null,
        })

        if (activeJob) {
          await saveVerifyResult(activeJob.id, result)
        }

        return toolJson({
          result: result.toLowerCase() as 'aligned' | 'partial' | 'empty' | 'divergent',
          reasoning,
          verify_only: task.verify_only,
          task_id: taskId,
          job_id: activeJob?.id ?? null,
        })
      }),
  )
}
