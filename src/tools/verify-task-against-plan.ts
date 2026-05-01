import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessTask } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { classifyDiffAgainstPlan, type VerifyResultValue } from '../verify/classify.js'

const exec = promisify(execFile)

const inputSchema = z.object({
  task_id: z.string().min(1),
  worktree_path: z.string().min(1),
})

export async function getDiffInWorktree(worktreePath: string): Promise<string> {
  const { stdout } = await exec('git', ['diff', 'origin/main...HEAD'], { cwd: worktreePath })
  return stdout
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
        if (!(await userCanAccessTask(task_id, auth.userId))) {
          return toolError(`Task ${task_id} not found or not accessible`)
        }

        const task = await prisma.task.findUnique({
          where: { id: task_id },
          select: {
            id: true,
            verify_only: true,
            claude_jobs: {
              where: { status: { in: ['CLAIMED', 'RUNNING'] } },
              orderBy: { created_at: 'desc' },
              take: 1,
              select: { id: true, plan_snapshot: true },
            },
          },
        })

        if (!task) return toolError(`Task ${task_id} not found`)

        const activeJob = task.claude_jobs[0] ?? null

        let diff: string
        try {
          diff = await getDiffInWorktree(worktree_path)
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
          task_id,
          job_id: activeJob?.id ?? null,
        })
      }),
  )
}
