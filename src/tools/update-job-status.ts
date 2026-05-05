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
import { createPullRequest } from '../git/pr.js'

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
  if (!repoRoot) {
    console.warn(
      `[update_job_status] cleanup skip for job=${jobId}: no repoRoot configured for product ${productId}`,
    )
    return
  }

  // Branch-per-story: only remove the worktree if no sibling job in the same
  // story is still active. If siblings are queued/claimed/running they will
  // re-use this branch — destroying the worktree now wastes the next claim.
  const job = await prisma.claudeJob.findUnique({
    where: { id: jobId },
    select: { task: { select: { story_id: true } } },
  })
  if (job?.task) {
    const activeSiblings = await prisma.claudeJob.count({
      where: {
        task: { story_id: job.task.story_id },
        status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] },
        id: { not: jobId },
      },
    })
    if (activeSiblings > 0) {
      console.log(
        `[update_job_status] cleanup deferred for job=${jobId}: ${activeSiblings} sibling(s) still active in story ${job.task.story_id}`,
      )
      return
    }
  }

  // Keep branch when job is done and a branch was reported (agent pushed)
  const keepBranch = status === 'done' && branch !== undefined
  try {
    await removeWorktreeForJob({ repoRoot, jobId, keepBranch })
  } catch (err) {
    console.warn(
      `[update_job_status] cleanup FAILED for job=${jobId} keepBranch=${keepBranch}:`,
      err,
    )
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

export type VerifyRequired = 'ALIGNED' | 'ALIGNED_OR_PARTIAL' | 'ANY'

const SUMMARY_MIN_LENGTH = 20

/**
 * Validate whether a CLAIMED/RUNNING job can transition to DONE based on its
 * verify_result + the task's verify_required level.
 *
 * Decision matrix:
 *   verifyResult=null        → reject (run verify_task_against_plan first)
 *   EMPTY  + !verify_only    → reject
 *   EMPTY  + verify_only     → allowed
 *   ALIGNED                  → always allowed
 *   PARTIAL/DIVERGENT
 *     required=ALIGNED       → reject (strict task)
 *     required=ALIGNED_OR_PARTIAL → require non-empty summary explaining drift
 *     required=ANY           → allowed (refactor/multi-file edit)
 */
export function checkVerifyGate(
  verifyResult: string | null,
  verifyOnly: boolean,
  verifyRequired: VerifyRequired = 'ALIGNED_OR_PARTIAL',
  summary: string | undefined = undefined,
): { allowed: true } | { allowed: false; error: string } {
  if (verifyResult === null) {
    return {
      allowed: false,
      error: 'Roep eerst verify_task_against_plan aan voordat je DONE markeert.',
    }
  }
  if (verifyResult === 'EMPTY') {
    if (verifyOnly) return { allowed: true }
    return {
      allowed: false,
      error:
        'Plan-vs-implementatie verify gaf EMPTY. Geen wijzigingen gedetecteerd. ' +
        'Markeer de task als verify_only of pas de implementatie aan.',
    }
  }
  if (verifyResult === 'ALIGNED') return { allowed: true }

  // PARTIAL or DIVERGENT
  if (verifyRequired === 'ANY') return { allowed: true }
  if (verifyRequired === 'ALIGNED') {
    return {
      allowed: false,
      error:
        `Plan vereist ALIGNED maar verify gaf ${verifyResult}. ` +
        `Pas de implementatie aan zodat alle plan-paden zijn afgedekt, ` +
        `of stel verify_required in op ALIGNED_OR_PARTIAL/ANY.`,
    }
  }
  // verifyRequired === 'ALIGNED_OR_PARTIAL': vereist summary
  if (!summary || summary.trim().length < SUMMARY_MIN_LENGTH) {
    return {
      allowed: false,
      error:
        `Verify gaf ${verifyResult}. Geef een summary (≥${SUMMARY_MIN_LENGTH} chars) die uitlegt ` +
        `waarom de implementatie afwijkt van het plan, of stel verify_required in op ANY.`,
    }
  }
  return { allowed: true }
}

const DB_STATUS_MAP = {
  running: 'RUNNING',
  done: 'DONE',
  failed: 'FAILED',
} as const

export function resolveNextAction(
  queueCount: number,
  status: 'running' | 'done' | 'failed',
): 'wait_for_job_again' | 'queue_empty' | 'idle' {
  if (status === 'running') return 'idle'
  return queueCount > 0 ? 'wait_for_job_again' : 'queue_empty'
}

export async function maybeCreateAutoPr(opts: {
  jobId: string
  productId: string
  taskId: string
  worktreePath: string
  branchName: string
  summary: string | undefined
}): Promise<string | null> {
  const { jobId, productId, taskId, worktreePath, branchName, summary } = opts

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { auto_pr: true },
  })
  if (!product?.auto_pr) return null

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      title: true,
      story: { select: { id: true, code: true, title: true } },
    },
  })
  if (!task) return null

  // Branch-per-story: if a sibling job in the same story already opened a PR,
  // reuse its URL. This avoids one PR per sub-task.
  const sibling = await prisma.claudeJob.findFirst({
    where: {
      task: { story_id: task.story.id },
      pr_url: { not: null },
      id: { not: jobId },
    },
    select: { pr_url: true },
    orderBy: { created_at: 'asc' },
  })
  if (sibling?.pr_url) return sibling.pr_url

  // First DONE-task in the story → create a story-scoped PR
  const storyTitle = task.story.code ? `${task.story.code}: ${task.story.title}` : task.story.title
  const body = summary
    ? `${summary}\n\n---\n\n*Auto-generated by Scrum4Me agent (first task in story; PR-body will accumulate as sibling tasks complete).*`
    : '*Auto-generated by Scrum4Me agent (first task in story).*'

  const result = await createPullRequest({ worktreePath, branchName, title: storyTitle, body })
  if ('url' in result) return result.url

  console.warn(`[update_job_status] auto-PR skipped for job ${jobId}:`, result.error)
  return null
}

export function registerUpdateJobStatusTool(server: McpServer) {
  server.registerTool(
    'update_job_status',
    {
      title: 'Update job status',
      description:
        'Report progress on a claimed ClaudeJob. Allowed transitions from CLAIMED/RUNNING: ' +
        'running (start), done (finished), failed (error). ' +
        'The Bearer token must match the token that claimed the job. ' +
        'Before marking done: call verify_task_against_plan first — done is rejected when ' +
        'verify_result is null, EMPTY (unless task.verify_only is true), or when the verify level ' +
        'doesn’t meet task.verify_required: ALIGNED-only is strict; ALIGNED_OR_PARTIAL accepts ' +
        'PARTIAL/DIVERGENT but requires a non-empty summary (≥20 chars) explaining the drift; ANY ' +
        'accepts everything. ' +
        'Automatically emits an SSE event so the Scrum4Me UI updates in real time. ' +
        'Response includes next_action: when wait_for_job_again, immediately call wait_for_job again. When queue_empty, the agent batch is done.',
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
            idea_id: true,
            kind: true,
            verify_result: true,
            task: { select: { verify_only: true, verify_required: true } },
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
          // M12: idea-jobs hebben geen task/plan_snapshot/branch — skip de
          // verify-gate én de prepareDoneUpdate (die doet git push). Voor
          // idea-jobs is `done` direct geldig: de bijhorende update_idea_*_md
          // heeft de idea-status al naar GRILLED/PLAN_READY gezet.
          if (job.kind === 'IDEA_GRILL' || job.kind === 'IDEA_MAKE_PLAN') {
            actualStatus = 'done'
            // pushedAt blijft undefined, branch/error overrides ook
            skipWorktreeCleanup = true
          } else {
            const gate = checkVerifyGate(
              job.verify_result ?? null,
              job.task?.verify_only ?? false,
              (job.task?.verify_required ?? 'ALIGNED_OR_PARTIAL') as VerifyRequired,
              summary,
            )
            if (!gate.allowed) return toolError(gate.error)

            const plan = await prepareDoneUpdate(job_id, branch)
            actualStatus = plan.dbStatus === 'DONE' ? 'done' : 'failed'
            pushedAt = plan.pushedAt
            if (plan.branchOverride !== undefined) branchToWrite = plan.branchOverride
            if (plan.errorOverride !== undefined) errorToWrite = plan.errorOverride
            skipWorktreeCleanup = plan.skipWorktreeCleanup
          }
        }

        // Auto-PR: best-effort, only when push actually happened.
        // M12: idee-jobs hebben geen task_id en geen branch — skip auto-PR.
        let prUrl: string | null = null
        if (
          actualStatus === 'done' &&
          pushedAt &&
          branchToWrite &&
          job.kind === 'TASK_IMPLEMENTATION' &&
          job.task_id
        ) {
          const worktreeDir =
            process.env.SCRUM4ME_AGENT_WORKTREE_DIR ??
            path.join(os.homedir(), '.scrum4me-agent-worktrees')
          prUrl = await maybeCreateAutoPr({
            jobId: job_id,
            productId: job.product_id,
            taskId: job.task_id,
            worktreePath: path.join(worktreeDir, job_id),
            branchName: branchToWrite,
            summary,
          }).catch((err) => {
            console.warn(`[update_job_status] auto-PR error for job ${job_id}:`, err)
            return null
          })
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
            ...(prUrl !== null ? { pr_url: prUrl } : {}),
          },
          select: {
            id: true,
            status: true,
            branch: true,
            pushed_at: true,
            pr_url: true,
            verify_result: true,
            summary: true,
            error: true,
            started_at: true,
            finished_at: true,
          },
        })

        // M12: bij failed voor IDEA_*-jobs: zet idea.status op
        // GRILL_FAILED / PLAN_FAILED + log JOB_EVENT. Bij done laten we de
        // idea-status met rust — die wordt door update_idea_*_md gezet.
        if (actualStatus === 'failed' && job.idea_id) {
          const newIdeaStatus =
            job.kind === 'IDEA_GRILL'
              ? 'GRILL_FAILED'
              : job.kind === 'IDEA_MAKE_PLAN'
                ? 'PLAN_FAILED'
                : null
          if (newIdeaStatus) {
            await prisma.$transaction([
              prisma.idea.update({
                where: { id: job.idea_id },
                data: { status: newIdeaStatus },
              }),
              prisma.ideaLog.create({
                data: {
                  idea_id: job.idea_id,
                  type: 'JOB_EVENT',
                  content: `${job.kind} failed`,
                  metadata: { job_id, error: errorToWrite ?? null },
                },
              }),
            ])
          }
        }

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
                pr_url: updated.pr_url ?? undefined,
                verify_result: updated.verify_result?.toLowerCase() ?? undefined,
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

        const queueCount = await prisma.claudeJob.count({
          where: { user_id: userId, status: 'QUEUED' },
        })
        const nextAction = resolveNextAction(queueCount, actualStatus)

        return toolJson({
          job_id: updated.id,
          status: actualStatus,
          branch: updated.branch,
          pushed_at: updated.pushed_at?.toISOString() ?? null,
          pr_url: updated.pr_url ?? null,
          verify_result: updated.verify_result?.toLowerCase() ?? null,
          summary: updated.summary,
          error: updated.error,
          started_at: updated.started_at?.toISOString() ?? null,
          finished_at: updated.finished_at?.toISOString() ?? null,
          next_action: nextAction,
        })
      }),
  )
}
