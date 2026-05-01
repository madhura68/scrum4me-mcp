// wait_for_job — blokkeert tot een QUEUED ClaudeJob beschikbaar is, claimt 'm
// atomisch via FOR UPDATE SKIP LOCKED, en retourneert de volledige task-context.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from 'pg'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, toolError, withToolErrors } from '../errors.js'
import { createWorktreeForJob } from '../git/worktree.js'

/** Parse `https://github.com/<owner>/<name>(.git)?` → `<name>`. */
export function repoNameFromUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null
  const m = repoUrl.match(/[/:]([^/]+?)(?:\.git)?\/?$/)
  return m ? m[1] : null
}

export async function resolveRepoRoot(productId: string): Promise<string | null> {
  const envKey = `SCRUM4ME_REPO_ROOT_${productId}`
  if (process.env[envKey]) return process.env[envKey]!

  const configPath = path.join(os.homedir(), '.scrum4me-agent-config.json')
  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    const config = JSON.parse(raw) as { repoRoots?: Record<string, string> }
    if (config.repoRoots?.[productId]) return config.repoRoots[productId]
  } catch {
    // ignore — fall through to convention-based fallback
  }

  // Convention-based fallback: ~/Projects/<repo-name> with .git/ inside.
  // Lets the agent work without explicit env-config when checkouts follow
  // the standard ~/Projects/<name> layout.
  try {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { repo_url: true },
    })
    const name = repoNameFromUrl(product?.repo_url)
    if (!name) return null
    const candidate = path.join(os.homedir(), 'Projects', name)
    await fs.access(path.join(candidate, '.git'))
    return candidate
  } catch {
    return null
  }
}

export async function rollbackClaim(jobId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE claude_jobs
    SET status = 'QUEUED', claimed_by_token_id = NULL, claimed_at = NULL, plan_snapshot = NULL
    WHERE id = ${jobId}
  `
}

/**
 * Resolve the branch name for a newly-claimed job.
 *
 * Branch-per-story: if a sibling job in the same story already has a branch
 * (assigned during its own claim), reuse it so all sub-tasks in the story
 * land in one PR. Otherwise generate a fresh `feat/story-<8-char>` name.
 *
 * Returns also `siblingHasActiveWorktree` so the caller can decide to remove
 * a stale sibling worktree before creating a new one (git refuses to check
 * out the same branch in two worktrees).
 */
export async function resolveBranchForJob(
  jobId: string,
  storyId: string,
): Promise<{ branchName: string; reused: boolean }> {
  const sibling = await prisma.claudeJob.findFirst({
    where: {
      task: { story_id: storyId },
      branch: { not: null },
      id: { not: jobId },
    },
    orderBy: { created_at: 'asc' },
    select: { branch: true },
  })
  if (sibling?.branch) return { branchName: sibling.branch, reused: true }
  return { branchName: `feat/story-${storyId.slice(-8)}`, reused: false }
}

export async function attachWorktreeToJob(
  productId: string,
  jobId: string,
  storyId: string,
): Promise<{ worktree_path: string; branch_name: string; reused_branch: boolean } | { error: string }> {
  const repoRoot = await resolveRepoRoot(productId)
  if (!repoRoot) {
    await rollbackClaim(jobId)
    return {
      error:
        `No repo root configured for product ${productId}. ` +
        `Set env var SCRUM4ME_REPO_ROOT_${productId} or add to ~/.scrum4me-agent-config.json.`,
    }
  }

  const { branchName, reused } = await resolveBranchForJob(jobId, storyId)
  try {
    const { worktreePath, branchName: actualBranch } = await createWorktreeForJob({
      repoRoot,
      jobId,
      branchName,
      reuseBranch: reused,
    })
    return { worktree_path: worktreePath, branch_name: actualBranch, reused_branch: reused }
  } catch (err) {
    await rollbackClaim(jobId)
    return { error: `Worktree creation failed: ${(err as Error).message}` }
  }
}

const MAX_WAIT_SECONDS = 600
const POLL_INTERVAL_MS = 5_000
const STALE_CLAIMED_INTERVAL = "30 minutes"

const inputSchema = z.object({
  product_id: z.string().min(1).optional(),
  wait_seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).default(300),
})

const STALE_ERROR_MSG = 'agent did not complete job within 2 attempts'

export async function resetStaleClaimedJobs(userId: string): Promise<void> {
  // Jobs that exceeded the retry limit → FAILED
  const failedRows = await prisma.$queryRaw<
    Array<{ id: string; task_id: string; product_id: string }>
  >`
    UPDATE claude_jobs
    SET status = 'FAILED',
        finished_at = NOW(),
        error = ${STALE_ERROR_MSG}
    WHERE user_id = ${userId}
      AND status = 'CLAIMED'
      AND claimed_at < NOW() - INTERVAL '30 minutes'
      AND retry_count >= 2
    RETURNING id, task_id, product_id
  `

  // Jobs under the retry limit → back to QUEUED, increment retry_count
  const requeuedRows = await prisma.$queryRaw<
    Array<{ id: string; task_id: string; product_id: string; retry_count: number }>
  >`
    UPDATE claude_jobs
    SET status = 'QUEUED',
        claimed_by_token_id = NULL,
        claimed_at = NULL,
        plan_snapshot = NULL,
        retry_count = retry_count + 1
    WHERE user_id = ${userId}
      AND status = 'CLAIMED'
      AND claimed_at < NOW() - INTERVAL '30 minutes'
      AND retry_count < 2
    RETURNING id, task_id, product_id, retry_count
  `

  if (failedRows.length === 0 && requeuedRows.length === 0) return

  // Notify UI via SSE for each transition (best-effort)
  try {
    const pg = new Client({ connectionString: process.env.DATABASE_URL })
    await pg.connect()
    for (const j of failedRows) {
      await pg.query('SELECT pg_notify($1, $2)', [
        'scrum4me_changes',
        JSON.stringify({
          type: 'claude_job_status',
          job_id: j.id,
          task_id: j.task_id,
          user_id: userId,
          product_id: j.product_id,
          status: 'failed',
          error: STALE_ERROR_MSG,
        }),
      ])
    }
    for (const j of requeuedRows) {
      await pg.query('SELECT pg_notify($1, $2)', [
        'scrum4me_changes',
        JSON.stringify({
          type: 'claude_job_status',
          job_id: j.id,
          task_id: j.task_id,
          user_id: userId,
          product_id: j.product_id,
          status: 'queued',
        }),
      ])
    }
    await pg.end()
  } catch {
    // non-fatal — status transitions are already persisted
  }
}

export async function tryClaimJob(
  userId: string,
  tokenId: string,
  productId?: string,
): Promise<string | null> {
  // Atomic claim in a single transaction — also captures plan_snapshot from task
  const rows = await prisma.$transaction(async (tx) => {
    // SELECT FOR UPDATE OF claude_jobs SKIP LOCKED — join tasks to read implementation_plan
    const found = productId
      ? await tx.$queryRaw<Array<{ id: string; implementation_plan: string | null }>>`
          SELECT cj.id, t.implementation_plan
          FROM claude_jobs cj
          JOIN tasks t ON t.id = cj.task_id
          WHERE cj.user_id = ${userId}
            AND cj.product_id = ${productId}
            AND cj.status = 'QUEUED'
          ORDER BY cj.created_at ASC
          LIMIT 1
          FOR UPDATE OF cj SKIP LOCKED
        `
      : await tx.$queryRaw<Array<{ id: string; implementation_plan: string | null }>>`
          SELECT cj.id, t.implementation_plan
          FROM claude_jobs cj
          JOIN tasks t ON t.id = cj.task_id
          WHERE cj.user_id = ${userId}
            AND cj.status = 'QUEUED'
          ORDER BY cj.created_at ASC
          LIMIT 1
          FOR UPDATE OF cj SKIP LOCKED
        `

    if (found.length === 0) return []

    const jobId = found[0].id
    const snapshot = found[0].implementation_plan ?? ''
    await tx.$executeRaw`
      UPDATE claude_jobs
      SET status = 'CLAIMED',
          claimed_by_token_id = ${tokenId},
          claimed_at = NOW(),
          plan_snapshot = ${snapshot}
      WHERE id = ${jobId}
    `
    return [{ id: jobId }]
  })

  return rows.length > 0 ? rows[0].id : null
}

async function getFullJobContext(jobId: string) {
  const job = await prisma.claudeJob.findUnique({
    where: { id: jobId },
    include: {
      task: {
        include: {
          story: {
            include: {
              pbi: { select: { id: true, title: true, priority: true, status: true } },
              sprint: { select: { id: true, sprint_goal: true, status: true } },
            },
          },
        },
      },
      product: { select: { id: true, name: true, repo_url: true } },
    },
  })
  if (!job) return null

  const { task } = job
  const { story } = task
  const { pbi, sprint } = story

  return {
    job_id: job.id,
    status: 'claimed',
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      implementation_plan: task.implementation_plan,
      priority: task.priority,
    },
    story: {
      id: story.id,
      title: story.title,
      description: story.description,
      acceptance_criteria: story.acceptance_criteria,
    },
    pbi: {
      id: pbi.id,
      title: pbi.title,
      priority: pbi.priority,
      status: pbi.status,
    },
    sprint: sprint
      ? { id: sprint.id, goal: sprint.sprint_goal, status: sprint.status }
      : null,
    product: {
      id: job.product.id,
      name: job.product.name,
      repo_url: job.product.repo_url,
    },
    branch_suggestion: `feat/job-${job.id.slice(-8)}`,
  }
}

export function registerWaitForJobTool(server: McpServer) {
  server.registerTool(
    'wait_for_job',
    {
      title: 'Wait for job',
      description:
        'Block until a QUEUED ClaudeJob is available for this user, then claim it atomically ' +
        'and return full task context (implementation_plan, story, pbi, sprint, repo_url). ' +
        'Also creates a git worktree for the job and returns worktree_path and branch_name. ' +
        'Work exclusively in worktree_path — do all file edits and commits there. ' +
        'Resets stale CLAIMED jobs (>30min) back to QUEUED before scanning. ' +
        'Pass optional product_id to scope to a specific product. ' +
        'Returns { status: "timeout" } when wait_seconds elapses without a job. ' +
        'Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ product_id, wait_seconds }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        const { userId, tokenId } = auth

        // 1. Reset stale claimed jobs
        await resetStaleClaimedJobs(userId)

        // 2. Try immediate claim
        let jobId = await tryClaimJob(userId, tokenId, product_id)
        if (jobId) {
          const ctx = await getFullJobContext(jobId)
          if (!ctx) return toolError('Job claimed but context fetch failed')
          const wt = await attachWorktreeToJob(ctx.product.id, jobId, ctx.story.id)
          if ('error' in wt) return toolError(wt.error)
          return toolJson({ ...ctx, worktree_path: wt.worktree_path, branch_name: wt.branch_name })
        }

        // 3. No job available — LISTEN and poll until timeout
        const deadline = Date.now() + wait_seconds * 1000
        const listenClient = new Client({ connectionString: process.env.DATABASE_URL })
        await listenClient.connect()
        await listenClient.query('LISTEN scrum4me_changes')

        try {
          while (Date.now() < deadline) {
            // Wait for a notification or poll interval
            await new Promise<void>((resolve) => {
              const pollTimer = setTimeout(resolve, POLL_INTERVAL_MS)
              listenClient.once('notification', (msg) => {
                try {
                  const payload = JSON.parse(msg.payload ?? '{}')
                  if (
                    payload.type === 'claude_job_enqueued' &&
                    payload.user_id === userId &&
                    (!product_id || payload.product_id === product_id)
                  ) {
                    clearTimeout(pollTimer)
                    resolve()
                  }
                } catch {
                  // ignore parse errors
                }
              })
            })

            await resetStaleClaimedJobs(userId)
            jobId = await tryClaimJob(userId, tokenId, product_id)
            if (jobId) {
              const ctx = await getFullJobContext(jobId)
              if (!ctx) return toolError('Job claimed but context fetch failed')
              const wt = await attachWorktreeToJob(ctx.product.id, jobId, ctx.story.id)
              if ('error' in wt) return toolError(wt.error)
              return toolJson({ ...ctx, worktree_path: wt.worktree_path, branch_name: wt.branch_name })
            }
          }
        } finally {
          await listenClient.end().catch(() => {})
        }

        return toolJson({ status: 'timeout', message: 'No job available within wait window' })
      }),
  )
}
