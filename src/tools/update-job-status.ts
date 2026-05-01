// update_job_status — agent rapporteert voortgang: running | done | failed.
// Auth: Bearer-token moet matchen claimed_by_token_id van de job.
// Triggert automatisch een SSE-event naar de UI via pg_notify.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from 'pg'
import * as os from 'node:os'
import * as path from 'node:path'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, toolError, withToolErrors } from '../errors.js'
import { removeWorktreeForJob } from '../git/worktree.js'
import { resolveRepoRoot } from './wait-for-job.js'
import { pushBranchForJob } from '../git/push.js'

const inputSchema = z.object({
  job_id: z.string().min(1),
  status: z.enum(['running', 'done', 'failed']),
  branch: z.string().min(1).optional(),
  summary: z.string().max(1_000).optional(),
  error: z.string().max(2_000).optional(),
})

export async function cleanupWorktreeForTerminalStatus(
  productId: string,
  jobId: string,
  status: 'done' | 'failed',
  branch: string | undefined,
): Promise<void> {
  const repoRoot = await resolveRepoRoot(productId)
  if (!repoRoot) return

  // Keep branch when job is done and a branch was reported (agent pushed)
  const keepBranch = status === 'done' && branch !== undefined
  try {
    await removeWorktreeForJob({ repoRoot, jobId, keepBranch })
  } catch (err) {
    console.warn(`[update_job_status] Worktree cleanup failed for job ${jobId}:`, err)
  }
}

export type DoneUpdatePlan = {
  dbStatus: 'DONE' | 'FAILED'
  pushedAt: Date | undefined
  branchOverride: string | undefined
  errorOverride: string | undefined
  skipWorktreeCleanup: boolean
}

export async function prepareDoneUpdate(
  jobId: string,
  branch: string | undefined,
): Promise<DoneUpdatePlan> {
  const worktreeDir =
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR ?? path.join(os.homedir(), '.scrum4me-agent-worktrees')
  const worktreePath = path.join(worktreeDir, jobId)
  const branchName = branch ?? `feat/job-${jobId.slice(-8)}`

  const pushResult = await pushBranchForJob({ worktreePath, branchName })

  if (pushResult.pushed) {
    return {
      dbStatus: 'DONE',
      pushedAt: new Date(),
      branchOverride: branchName,
      errorOverride: undefined,
      skipWorktreeCleanup: false,
    }
  }

  if (pushResult.reason === 'no-changes') {
    return {
      dbStatus: 'DONE',
      pushedAt: undefined,
      branchOverride: undefined,
      errorOverride: undefined,
      skipWorktreeCleanup: false,
    }
  }

  // Push failed — job becomes FAILED, worktree stays for manual inspection
  const snippet = pushResult.stderr.slice(0, 200)
  return {
    dbStatus: 'FAILED',
    pushedAt: undefined,
    branchOverride: undefined,
    errorOverride: `push failed (${pushResult.reason}): ${snippet}`,
    skipWorktreeCleanup: true,
  }
}

const DB_STATUS_MAP = {
  running: 'RUNNING',
  done: 'DONE',
  failed: 'FAILED',
} as const

export function registerUpdateJobStatusTool(server: McpServer) {
  server.registerTool(
    'update_job_status',
    {
      title: 'Update job status',
      description:
        'Report progress on a claimed ClaudeJob. Allowed transitions from CLAIMED/RUNNING: ' +
        'running (start), done (finished), failed (error). ' +
        'The Bearer token must match the token that claimed the job. ' +
        'Automatically emits an SSE event so the Scrum4Me UI updates in real time.',
      inputSchema,
    },
    async ({ job_id, status, branch, summary, error }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        const { tokenId, userId } = auth

        const job = await prisma.claudeJob.findUnique({
          where: { id: job_id },
          select: {
            id: true,
            status: true,
            claimed_by_token_id: true,
            user_id: true,
            product_id: true,
            task_id: true,
          },
        })

        if (!job) return toolError(`Job ${job_id} not found`)
        if (job.claimed_by_token_id !== tokenId) {
          return toolError('PERMISSION_DENIED: This job was not claimed by your token')
        }
        if (!['CLAIMED', 'RUNNING'].includes(job.status)) {
          return toolError(`Job is already in terminal state: ${job.status.toLowerCase()}`)
        }

        // For DONE: push first, adjust DB status based on result
        let actualStatus = status
        let pushedAt: Date | undefined
        let branchToWrite = branch
        let errorToWrite = error
        let skipWorktreeCleanup = false

        if (status === 'done') {
          const plan = await prepareDoneUpdate(job_id, branch)
          actualStatus = plan.dbStatus === 'DONE' ? 'done' : 'failed'
          pushedAt = plan.pushedAt
          if (plan.branchOverride !== undefined) branchToWrite = plan.branchOverride
          if (plan.errorOverride !== undefined) errorToWrite = plan.errorOverride
          skipWorktreeCleanup = plan.skipWorktreeCleanup
        }

        const dbStatus = DB_STATUS_MAP[actualStatus as keyof typeof DB_STATUS_MAP]
        const now = new Date()
        const updated = await prisma.claudeJob.update({
          where: { id: job_id },
          data: {
            status: dbStatus,
            ...(actualStatus === 'running' ? { started_at: now } : {}),
            ...(actualStatus === 'done' || actualStatus === 'failed' ? { finished_at: now } : {}),
            ...(branchToWrite !== undefined ? { branch: branchToWrite } : {}),
            ...(pushedAt !== undefined ? { pushed_at: pushedAt } : {}),
            ...(summary !== undefined ? { summary } : {}),
            ...(errorToWrite !== undefined ? { error: errorToWrite } : {}),
          },
          select: {
            id: true,
            status: true,
            branch: true,
            pushed_at: true,
            summary: true,
            error: true,
            started_at: true,
            finished_at: true,
          },
        })

        // Notify UI via SSE
        try {
          const pg = new Client({ connectionString: process.env.DATABASE_URL })
          await pg.connect()
          await pg.query(
            `SELECT pg_notify('scrum4me_changes', $1)`,
            [
              JSON.stringify({
                type: 'claude_job_status',
                job_id: updated.id,
                task_id: job.task_id,
                user_id: job.user_id,
                product_id: job.product_id,
                status: actualStatus,
                branch: updated.branch ?? undefined,
                pushed_at: updated.pushed_at?.toISOString() ?? undefined,
                summary: updated.summary ?? undefined,
                error: updated.error ?? undefined,
              }),
            ],
          )
          await pg.end()
        } catch {
          // non-fatal — status is already persisted
        }

        // Best-effort worktree cleanup on terminal transitions (skip if push failed — worktree preserved)
        if ((actualStatus === 'done' || actualStatus === 'failed') && !skipWorktreeCleanup) {
          await cleanupWorktreeForTerminalStatus(job.product_id, job_id, actualStatus, branchToWrite)
        }

        return toolJson({
          job_id: updated.id,
          status: actualStatus,
          branch: updated.branch,
          pushed_at: updated.pushed_at?.toISOString() ?? null,
          summary: updated.summary,
          error: updated.error,
          started_at: updated.started_at?.toISOString() ?? null,
          finished_at: updated.finished_at?.toISOString() ?? null,
        })
      }),
  )
}
