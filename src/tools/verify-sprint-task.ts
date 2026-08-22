// PBI-50 F3-T1: verify_sprint_task
//
// Execution-aware verify-tool voor SPRINT_IMPLEMENTATION-flow.
// Verschilt van verify_task_against_plan in:
//   - input via execution_id (niet task_id)
//   - base_sha komt uit SprintTaskExecution.base_sha; voor task[1..N] zonder
//     base_sha vult de tool dynamisch met head_sha van vorige DONE-execution
//   - plan_snapshot komt uit execution.plan_snapshot (frozen op claim-tijd)
//   - resultaat opgeslagen op execution-row, niet op ClaudeJob.verify_result
//   - response geeft allowed_for_done direct mee

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { getGitDiff } from '../git/diff.js'
import { classifyDiffAgainstPlan } from '../verify/classify.js'
import { checkVerifyGate } from './update-job-status.js'

const inputSchema = z.object({
  execution_id: z.string().min(1),
  worktree_path: z.string().min(1),
  summary: z.string().max(2000).optional(),
})

export function registerVerifySprintTaskTool(server: McpServer) {
  server.registerTool(
    'verify_sprint_task',
    {
      title: 'Verify SprintTaskExecution against frozen plan',
      description:
        'Run `git diff <base_sha>...HEAD` in the worktree and classify against the ' +
        'frozen plan_snapshot of this SprintTaskExecution. Returns ALIGNED|PARTIAL|EMPTY|' +
        'DIVERGENT plus reasoning + allowed_for_done (computed via the standard verify-gate ' +
        'with the execution\'s frozen verify_required/verify_only). ' +
        'For task[1..N] zonder base_sha vult de tool die in op basis van de head_sha van de ' +
        'vorige DONE-execution. Optional summary is opgeslagen voor PARTIAL/DIVERGENT-rationale ' +
        'en gebruikt door de gate. ' +
        'Call this BEFORE update_task_execution(DONE) for each task in the sprint batch. ' +
        'Forbidden for demo accounts.',
      inputSchema,
      annotations: { readOnlyHint: false },
    },
    async ({ execution_id, worktree_path, summary }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()

        const execution = await prisma.sprintTaskExecution.findUnique({
          where: { id: execution_id },
          select: {
            id: true,
            sprint_job_id: true,
            order: true,
            base_sha: true,
            plan_snapshot: true,
            verify_required_snapshot: true,
            verify_only_snapshot: true,
            sprint_job: {
              select: { claimed_by_token_id: true, status: true, kind: true },
            },
          },
        })
        if (!execution) {
          return toolError(`SprintTaskExecution ${execution_id} not found`)
        }
        if (execution.sprint_job.kind !== 'SPRINT_IMPLEMENTATION') {
          return toolError(
            `Execution ${execution_id} hangs at job kind ${execution.sprint_job.kind}, expected SPRINT_IMPLEMENTATION`,
          )
        }
        if (execution.sprint_job.claimed_by_token_id !== auth.tokenId) {
          return toolError(
            `Forbidden: token does not own SPRINT_IMPLEMENTATION job for execution ${execution_id}`,
          )
        }

        // Resolve base_sha. Voor task[0] is dit gevuld bij claim. Voor
        // task[1..N] wordt dit dynamisch gevuld op basis van de vorige
        // DONE-execution's head_sha. Persist na fill zodat herhaalde calls
        // dezelfde base gebruiken.
        let baseSha = execution.base_sha
        if (!baseSha) {
          const previousDone = await prisma.sprintTaskExecution.findFirst({
            where: {
              sprint_job_id: execution.sprint_job_id,
              order: { lt: execution.order },
              status: 'DONE',
              head_sha: { not: null },
            },
            orderBy: { order: 'desc' },
            select: { head_sha: true },
          })
          if (!previousDone?.head_sha) {
            return toolError(
              `MISSING_BASE_SHA: execution ${execution_id} has no base_sha and no previous DONE-execution with head_sha. Did you skip update_task_execution(DONE) on a prior task?`,
            )
          }
          baseSha = previousDone.head_sha
          await prisma.sprintTaskExecution.update({
            where: { id: execution_id },
            data: { base_sha: baseSha },
          })
        }

        let diff: string
        try {
          diff = await getGitDiff(worktree_path, `${baseSha}...HEAD`)
        } catch (err) {
          return toolError(
            `git diff failed in worktree (${worktree_path}): ${(err as Error).message ?? 'unknown error'}`,
          )
        }

        const { result, reasoning } = classifyDiffAgainstPlan({
          diff,
          plan: execution.plan_snapshot,
        })

        await prisma.sprintTaskExecution.update({
          where: { id: execution_id },
          data: {
            verify_result: result,
            ...(summary !== undefined ? { verify_summary: summary } : {}),
          },
        })

        const gate = checkVerifyGate(
          result,
          execution.verify_only_snapshot,
          execution.verify_required_snapshot,
          summary,
        )

        return toolJson({
          execution_id: execution.id,
          result: result.toLowerCase() as 'aligned' | 'partial' | 'empty' | 'divergent',
          reasoning,
          base_sha: baseSha,
          allowed_for_done: gate.allowed,
          reason: gate.allowed ? null : gate.error,
        })
      }),
  )
}
