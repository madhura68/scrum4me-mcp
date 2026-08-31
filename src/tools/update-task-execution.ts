// PBI-50 F3-T2: update_task_execution
//
// SPRINT_IMPLEMENTATION-flow lifecycle-tool. Worker roept dit aan voor elke
// task in de batch om de SprintTaskExecution-row te muteren:
//   PENDING → RUNNING → DONE/FAILED/SKIPPED
// Idempotent: dezelfde call kan veilig herhaald worden.

import * as path from 'node:path'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { getWorktreeRoot } from '../git/worktree-paths.js'
import { resolveWorktreeHead, maybeBackupPush } from '../git/branch-safety.js'

const inputSchema = z.object({
  execution_id: z.string().min(1),
  status: z.enum(['PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED']),
  base_sha: z.string().optional(),
  head_sha: z.string().optional(),
  skip_reason: z.string().max(2000).optional(),
})

export function registerUpdateTaskExecutionTool(server: McpServer) {
  server.registerTool(
    'update_task_execution',
    {
      title: 'Update SprintTaskExecution status',
      description:
        'Mutate a SprintTaskExecution row in a SPRINT_IMPLEMENTATION batch. ' +
        'Status: PENDING|RUNNING|DONE|FAILED|SKIPPED. Worker calls this for each ' +
        'task transition. Token must own the parent SPRINT_IMPLEMENTATION ClaudeJob. ' +
        'Idempotent — safe to retry. Schrijft started_at (RUNNING) en finished_at ' +
        '(DONE/FAILED/SKIPPED). Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ execution_id, status, base_sha, head_sha, skip_reason }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()

        const execution = await prisma.sprintTaskExecution.findUnique({
          where: { id: execution_id },
          select: {
            id: true,
            sprint_job_id: true,
            sprint_job: {
              select: { claimed_by_token_id: true, status: true, kind: true, branch: true },
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
        if (
          execution.sprint_job.status !== 'CLAIMED' &&
          execution.sprint_job.status !== 'RUNNING'
        ) {
          return toolError(
            `Sprint job is in terminal state ${execution.sprint_job.status}`,
          )
        }

        // Spec §3.1 (load-bearing): bij DONE resolvet de server zelf HEAD in
        // de job-worktree en persisteert head_sha — óók als de caller er geen
        // meestuurt (de sprint-prompt doet dat niet) en óók wanneer de
        // backup-push hieronder als up-to-date wordt overgeslagen.
        const worktreePath = path.join(getWorktreeRoot(), execution.sprint_job_id)
        let effectiveHeadSha = head_sha
        if (status === 'DONE' && effectiveHeadSha === undefined) {
          effectiveHeadSha = (await resolveWorktreeHead(worktreePath)) ?? undefined
        }

        const now = new Date()
        const updated = await prisma.sprintTaskExecution.update({
          where: { id: execution_id },
          data: {
            status,
            ...(base_sha !== undefined ? { base_sha } : {}),
            ...(effectiveHeadSha !== undefined ? { head_sha: effectiveHeadSha } : {}),
            ...(skip_reason !== undefined ? { skip_reason } : {}),
            ...(status === 'RUNNING' ? { started_at: now } : {}),
            ...(status === 'DONE' || status === 'FAILED' || status === 'SKIPPED'
              ? { finished_at: now }
              : {}),
          },
          select: {
            id: true,
            status: true,
            base_sha: true,
            head_sha: true,
            verify_result: true,
            verify_summary: true,
            skip_reason: true,
            started_at: true,
            finished_at: true,
          },
        })

        // Spec §3.1: taakgrens-push — best-effort, ff-only, raakt nooit
        // pushed_at of de PR-keten.
        if (status === 'DONE' && execution.sprint_job.branch) {
          try {
            await maybeBackupPush({
              worktreePath,
              branchName: execution.sprint_job.branch,
              context: `task-boundary:${execution_id}`,
            })
          } catch (err) {
            // maybeBackupPush hoort nooit te throwen; dit is de contractuele
            // backstop — een pushprobleem mag de DONE-transitie nooit raken.
            console.warn(`[update_task_execution] backup push failed:`, err)
          }
        }

        return toolJson({
          execution_id: updated.id,
          status: updated.status,
          base_sha: updated.base_sha,
          head_sha: updated.head_sha,
          verify_result: updated.verify_result,
          verify_summary: updated.verify_summary,
          skip_reason: updated.skip_reason,
          started_at: updated.started_at?.toISOString() ?? null,
          finished_at: updated.finished_at?.toISOString() ?? null,
        })
      }),
  )
}
