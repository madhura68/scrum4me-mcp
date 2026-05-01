// update_job_status — agent rapporteert voortgang: running | done | failed.
// Auth: Bearer-token moet matchen claimed_by_token_id van de job.
// Triggert automatisch een SSE-event naar de UI via pg_notify.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from 'pg'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, toolError, withToolErrors } from '../errors.js'
import { removeWorktreeForJob } from '../git/worktree.js'
import { resolveRepoRoot } from './wait-for-job.js'

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

        const dbStatus = DB_STATUS_MAP[status]
        const now = new Date()
        const updated = await prisma.claudeJob.update({
          where: { id: job_id },
          data: {
            status: dbStatus,
            ...(status === 'running' ? { started_at: now } : {}),
            ...(status === 'done' || status === 'failed' ? { finished_at: now } : {}),
            ...(branch !== undefined ? { branch } : {}),
            ...(summary !== undefined ? { summary } : {}),
            ...(error !== undefined ? { error } : {}),
          },
          select: {
            id: true,
            status: true,
            branch: true,
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
                status,
                branch: updated.branch ?? undefined,
                summary: updated.summary ?? undefined,
                error: updated.error ?? undefined,
              }),
            ],
          )
          await pg.end()
        } catch {
          // non-fatal — status is already persisted
        }

        // Best-effort worktree cleanup on terminal transitions
        if (status === 'done' || status === 'failed') {
          await cleanupWorktreeForTerminalStatus(job.product_id, job_id, status, branch)
        }

        return toolJson({
          job_id: updated.id,
          status,
          branch: updated.branch,
          summary: updated.summary,
          error: updated.error,
          started_at: updated.started_at?.toISOString() ?? null,
          finished_at: updated.finished_at?.toISOString() ?? null,
        })
      }),
  )
}
