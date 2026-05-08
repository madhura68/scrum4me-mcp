// update_job_status — agent rapporteert voortgang: running | done | failed | skipped.
// Auth: Bearer-token moet matchen claimed_by_token_id van de job.
// Triggert automatisch een SSE-event naar de UI via pg_notify.
//
// 'skipped' is de no-op exit voor TASK_IMPLEMENTATION jobs waar verify_task_against_plan
// EMPTY oplevert omdat de wijzigingen al in origin/main staan (parallel werk, eerdere
// PR, race tussen siblings). Geen verify-gate, geen PR, geen cascade. De worker moet
// de bijbehorende task apart op DONE zetten via update_task_status als de inhoudelijke
// vereisten al zijn voldaan.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from 'pg'
import * as os from 'node:os'
import * as path from 'node:path'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, toolError, withToolErrors } from '../errors.js'
import { removeWorktreeForJob } from '../git/worktree.js'
import { getWorktreeRoot } from '../git/worktree-paths.js'
import { releaseLocksOnTerminal } from '../git/job-locks.js'
import { resolveRepoRoot } from './wait-for-job.js'
import { pushBranchForJob } from '../git/push.js'
import { createPullRequest, markPullRequestReady } from '../git/pr.js'
import { cancelPbiOnFailure } from '../cancel/pbi-cascade.js'
import { propagateStatusUpwards } from '../lib/tasks-status-update.js'
import { triggerPush } from '../lib/push-trigger.js'
import { transition as prFlowTransition } from '../flow/pr-flow.js'
import { transition as sprintRunTransition } from '../flow/sprint-run.js'
import { executeEffects } from '../flow/effects.js'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execGh = promisify(execFileCb)

async function fetchConflictFiles(prUrl: string): Promise<string[]> {
  try {
    const { stdout } = await execGh('gh', ['pr', 'view', prUrl, '--json', 'files'])
    const parsed = JSON.parse(stdout) as { files?: Array<{ path: string }> }
    return parsed.files?.map((f) => f.path) ?? []
  } catch {
    return []
  }
}

const inputSchema = z.object({
  job_id: z.string().min(1),
  status: z.enum(['running', 'done', 'failed', 'skipped']),
  branch: z.string().min(1).optional(),
  summary: z.string().max(1_000).optional(),
  error: z.string().max(2_000).optional(),
  model_id: z.string().min(1).max(200).optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  cache_write_tokens: z.number().int().nonnegative().optional(),
  actual_thinking_tokens: z.number().int().nonnegative().optional(),
})

export async function cleanupWorktreeForTerminalStatus(
  productId: string,
  jobId: string,
  status: 'done' | 'failed' | 'skipped',
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
  headSha: string | undefined
}

export async function prepareDoneUpdate(
  jobId: string,
  branch: string | undefined,
): Promise<DoneUpdatePlan> {
  const worktreeDir = getWorktreeRoot()
  const worktreePath = path.join(worktreeDir, jobId)
  const branchName = branch ?? `feat/job-${jobId.slice(-8)}`

  const pushResult = await pushBranchForJob({ worktreePath, branchName })

  if (pushResult.pushed) {
    let headSha: string | undefined
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const exec = promisify(execFile)
      const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
      headSha = stdout.trim()
    } catch (err) {
      console.warn(`[prepareDoneUpdate] failed to resolve HEAD sha for job ${jobId}:`, err)
    }
    return {
      dbStatus: 'DONE',
      pushedAt: new Date(),
      branchOverride: branchName,
      errorOverride: undefined,
      skipWorktreeCleanup: false,
      headSha,
    }
  }

  if (pushResult.reason === 'no-changes') {
    return {
      dbStatus: 'DONE',
      pushedAt: undefined,
      branchOverride: undefined,
      errorOverride: undefined,
      skipWorktreeCleanup: false,
      headSha: undefined,
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
    headSha: undefined,
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

// PBI-50 F4-T1: aggregate verify-gate voor SPRINT_IMPLEMENTATION DONE.
// Bron: alleen SprintTaskExecution-rows voor deze job. Per row:
//   DONE     → checkVerifyGate met snapshot-velden (gate per row)
//   SKIPPED  → alleen toegestaan als verify_required_snapshot === 'ANY'
//   FAILED/PENDING/RUNNING → blocker (sprint mag niet DONE met openstaand werk)
// Bij overall pass → { allowed: true }; anders error met opsomming.
export async function checkSprintVerifyGate(
  sprintJobId: string,
): Promise<{ allowed: true } | { allowed: false; error: string }> {
  const executions = await prisma.sprintTaskExecution.findMany({
    where: { sprint_job_id: sprintJobId },
    orderBy: { order: 'asc' },
    select: {
      id: true,
      task_id: true,
      order: true,
      status: true,
      verify_result: true,
      verify_summary: true,
      verify_required_snapshot: true,
      verify_only_snapshot: true,
      task: { select: { code: true, title: true } },
    },
  })
  if (executions.length === 0) {
    return {
      allowed: false,
      error:
        'Sprint-job heeft geen SprintTaskExecution-rows. ' +
        'Dit duidt op een claim-bug; reclaim de sprint.',
    }
  }

  const blockers: string[] = []
  for (const exec of executions) {
    const taskLabel = `${exec.task.code}: ${exec.task.title}`
    if (exec.status === 'PENDING' || exec.status === 'RUNNING') {
      blockers.push(`[${exec.status}] ${taskLabel} — onafgemaakt werk`)
      continue
    }
    if (exec.status === 'FAILED') {
      blockers.push(`[FAILED] ${taskLabel}`)
      continue
    }
    if (exec.status === 'SKIPPED') {
      if (exec.verify_required_snapshot !== 'ANY') {
        blockers.push(
          `[SKIPPED] ${taskLabel} — alleen toegestaan bij verify_required=ANY`,
        )
      }
      continue
    }
    // DONE: per-row gate
    const gate = checkVerifyGate(
      exec.verify_result,
      exec.verify_only_snapshot,
      exec.verify_required_snapshot,
      exec.verify_summary ?? undefined,
    )
    if (!gate.allowed) {
      blockers.push(`[DONE-gate] ${taskLabel}: ${gate.error}`)
    }
  }

  if (blockers.length === 0) return { allowed: true }
  return {
    allowed: false,
    error:
      `Sprint kan niet DONE — ${blockers.length} task(s) blokkeren:\n` +
      blockers.map((b) => `  - ${b}`).join('\n'),
  }
}

// PBI-50 F4-T2: idempotent SprintRun-finalisering.
// Invariant: alleen aanroepen wanneer alle stories in de sprint status
// DONE/FAILED/CANCELLED hebben. Effect: SprintRun.status → DONE +
// finished_at = NOW(). Idempotent — bij al-DONE: no-op.
export async function finalizeSprintRunOnDone(sprintRunId: string): Promise<void> {
  const sprintRun = await prisma.sprintRun.findUnique({
    where: { id: sprintRunId },
    select: { id: true, status: true, sprint_id: true },
  })
  if (!sprintRun) return
  if (sprintRun.status === 'DONE') return // idempotent

  // Check alle stories in deze sprint zijn klaar
  const openStories = await prisma.story.count({
    where: {
      sprint_id: sprintRun.sprint_id,
      status: { notIn: ['DONE', 'FAILED'] },
    },
  })
  if (openStories > 0) return // nog werk over — niet finaliseren

  await prisma.sprintRun.update({
    where: { id: sprintRunId },
    data: { status: 'DONE', finished_at: new Date() },
  })
}

const DB_STATUS_MAP = {
  running: 'RUNNING',
  done: 'DONE',
  failed: 'FAILED',
  skipped: 'SKIPPED',
} as const

export function resolveNextAction(
  queueCount: number,
  status: 'running' | 'done' | 'failed' | 'skipped',
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

  const job = await prisma.claudeJob.findUnique({
    where: { id: jobId },
    select: {
      sprint_run_id: true,
      sprint_run: {
        select: { id: true, pr_strategy: true, sprint: { select: { sprint_goal: true } } },
      },
    },
  })

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      title: true,
      story: { select: { id: true, code: true, title: true } },
    },
  })
  if (!task) return null

  // PBI-46 SPRINT-mode: hergebruik 1 draft-PR voor de hele SprintRun.
  // Mens zet 'm ready-for-review zodra de SprintRun DONE is.
  if (job?.sprint_run && job.sprint_run.pr_strategy === 'SPRINT') {
    const sprintSibling = await prisma.claudeJob.findFirst({
      where: {
        sprint_run_id: job.sprint_run_id,
        pr_url: { not: null },
        id: { not: jobId },
      },
      select: { pr_url: true },
      orderBy: { created_at: 'asc' },
    })
    if (sprintSibling?.pr_url) return sprintSibling.pr_url

    // Eerste DONE in deze SprintRun → maak draft-PR aan, geen auto-merge.
    const goal = job.sprint_run.sprint.sprint_goal
    const sprintTitle = `Sprint: ${goal}`.slice(0, 200)
    const body = summary
      ? `${summary}\n\n---\n\n*Draft PR voor sprint-run \`${job.sprint_run.id}\`. Wordt ready-for-review zodra alle stories DONE zijn (auto-merge bewust uit voor sprint-mode).*`
      : `*Draft PR voor sprint-run \`${job.sprint_run.id}\`. Wordt ready-for-review zodra alle stories DONE zijn (auto-merge bewust uit voor sprint-mode).*`

    const result = await createPullRequest({
      worktreePath,
      branchName,
      title: sprintTitle,
      body,
      draft: true,
      enableAutoMerge: false,
    })
    if ('url' in result) return result.url
    console.warn(`[update_job_status] sprint draft-PR skipped for job ${jobId}:`, result.error)
    return null
  }

  // STORY-mode (default of legacy): branch-per-story, sibling-tasks delen PR.
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

  const storyTitle = task.story.code ? `${task.story.code}: ${task.story.title}` : task.story.title
  const body = summary
    ? `${summary}\n\n---\n\n*Auto-generated by Scrum4Me agent (first task in story; PR-body will accumulate as sibling tasks complete).*`
    : '*Auto-generated by Scrum4Me agent (first task in story).*'

  const result = await createPullRequest({ worktreePath, branchName, title: storyTitle, body })
  if ('url' in result) return result.url

  console.warn(`[update_job_status] auto-PR skipped for job ${jobId}:`, result.error)
  return null
}

// PBI-50 F4-T2: SPRINT_BATCH PR-flow. Eén draft-PR voor de hele sprint,
// title = sprint.sprint_goal. Mens reviewt + mergt zelf — geen auto-merge.
// Lijkt op de SPRINT-mode van maybeCreateAutoPr maar zonder task-context.
export async function maybeCreateSprintBatchPr(opts: {
  jobId: string
  productId: string
  worktreePath: string
  branchName: string
  summary: string | undefined
}): Promise<string | null> {
  const { jobId, productId, worktreePath, branchName, summary } = opts

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { auto_pr: true },
  })
  if (!product?.auto_pr) return null

  const job = await prisma.claudeJob.findUnique({
    where: { id: jobId },
    select: {
      sprint_run_id: true,
      sprint_run: {
        select: { id: true, sprint: { select: { sprint_goal: true } } },
      },
    },
  })
  if (!job?.sprint_run) return null

  // Resume-pad: oude SprintRun heeft mogelijk al een PR via vorige run-job.
  // Lookup via SprintRunChain (previous_run_id) of via sibling-SPRINT-job.
  const previousRun = await prisma.sprintRun.findUnique({
    where: { id: job.sprint_run.id },
    select: { previous_run_id: true },
  })
  if (previousRun?.previous_run_id) {
    const prevPr = await prisma.claudeJob.findFirst({
      where: { sprint_run_id: previousRun.previous_run_id, pr_url: { not: null } },
      select: { pr_url: true },
    })
    if (prevPr?.pr_url) return prevPr.pr_url
  }

  const goal = job.sprint_run.sprint.sprint_goal
  const sprintTitle = `Sprint: ${goal}`.slice(0, 200)
  const body = summary
    ? `${summary}\n\n---\n\n*Draft PR voor sprint-batch \`${job.sprint_run.id}\` (single-session). Wordt ready-for-review zodra alle tasks DONE zijn.*`
    : `*Draft PR voor sprint-batch \`${job.sprint_run.id}\` (single-session). Wordt ready-for-review zodra alle tasks DONE zijn.*`

  const result = await createPullRequest({
    worktreePath,
    branchName,
    title: sprintTitle,
    body,
    draft: true,
    enableAutoMerge: false,
  })
  if ('url' in result) return result.url
  console.warn(`[update_job_status] sprint-batch draft-PR skipped for job ${jobId}:`, result.error)
  return null
}

export function registerUpdateJobStatusTool(server: McpServer) {
  server.registerTool(
    'update_job_status',
    {
      title: 'Update job status',
      description:
        'Report progress on a claimed ClaudeJob. Allowed transitions from CLAIMED/RUNNING: ' +
        'running (start), done (finished), failed (error), skipped (no-op exit). ' +
        'The Bearer token must match the token that claimed the job. ' +
        'Before marking done: call verify_task_against_plan first — done is rejected when ' +
        'verify_result is null, EMPTY (unless task.verify_only is true), or when the verify level ' +
        'doesn’t meet task.verify_required: ALIGNED-only is strict; ALIGNED_OR_PARTIAL accepts ' +
        'PARTIAL/DIVERGENT but requires a non-empty summary (≥20 chars) explaining the drift; ANY ' +
        'accepts everything. ' +
        "Use 'skipped' for TASK_IMPLEMENTATION when verify_task_against_plan returns EMPTY because " +
        'the requested changes are already present in origin/main (parallel work, earlier PR, race ' +
        "between siblings). 'skipped' requires a non-empty error (≥10 chars) describing the reason " +
        "(e.g. 'no_op_changes_already_in_main') and skips the verify-gate, auto-PR and PBI fail-cascade. " +
        'Mark the underlying task DONE separately via update_task_status if its requirements are met. ' +
        'Automatically emits an SSE event so the Scrum4Me UI updates in real time. ' +
        'Optionally accepts token-usage fields (model_id + input/output/cache_read/cache_write tokens) ' +
        'for cost tracking — typically populated by a PostToolUse hook from the local Claude Code transcript, ' +
        'not by the agent itself. ' +
        'Response includes next_action: when wait_for_job_again, immediately call wait_for_job again. When queue_empty, the agent batch is done.',
      inputSchema,
    },
    async ({
      job_id,
      status,
      branch,
      summary,
      error,
      model_id,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_write_tokens,
      actual_thinking_tokens,
    }) =>
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
            sprint_run_id: true,
            kind: true,
            verify_result: true,
            task: { select: { verify_only: true, verify_required: true } },
          },
        })

        if (!job) return toolError(`Job ${job_id} not found`)
        if (job.claimed_by_token_id !== tokenId) {
          return toolError('PERMISSION_DENIED: This job was not claimed by your token')
        }
        if (job.status === 'CANCELLED') {
          // PBI fail-cascade got here first. The agent must abandon any
          // local work and call wait_for_job again instead of forcing this
          // job into DONE/FAILED.
          return toolError(
            'JOB_CANCELLED: This job was cancelled by the PBI fail-cascade. ' +
              'Discard your local changes and call wait_for_job for the next item.',
          )
        }
        if (!['CLAIMED', 'RUNNING'].includes(job.status)) {
          return toolError(`Job is already in terminal state: ${job.status.toLowerCase()}`)
        }

        // 'skipped' = no-op exit. Only valid for TASK_IMPLEMENTATION (verify=EMPTY
        // patroon) en vereist een non-empty error met ≥10 chars uitleg, zoals
        // 'no_op_changes_already_in_main'. Geen verify-gate, geen PR, geen
        // PBI fail-cascade, geen propagation naar task/story/PBI.
        if (status === 'skipped') {
          if (job.kind !== 'TASK_IMPLEMENTATION') {
            return toolError(
              `'skipped' is alleen toegestaan voor TASK_IMPLEMENTATION (kind=${job.kind})`,
            )
          }
          if (!error || error.trim().length < 10) {
            return toolError(
              "'skipped' vereist non-empty error met reden (≥10 chars), bv. 'no_op_changes_already_in_main'",
            )
          }
        }

        // For DONE: push first, adjust DB status based on result
        let actualStatus = status
        let pushedAt: Date | undefined
        let branchToWrite = branch
        let errorToWrite = error
        let skipWorktreeCleanup = false
        let headShaToWrite: string | undefined

        if (status === 'done') {
          // M12: idea-jobs hebben geen task/plan_snapshot/branch — skip de
          // verify-gate én de prepareDoneUpdate (die doet git push). Voor
          // idea-jobs is `done` direct geldig: de bijhorende update_idea_*_md
          // heeft de idea-status al naar GRILLED/PLAN_READY gezet.
          if (job.kind === 'IDEA_GRILL' || job.kind === 'IDEA_MAKE_PLAN') {
            actualStatus = 'done'
            // pushedAt blijft undefined, branch/error overrides ook
            skipWorktreeCleanup = true
          } else if (job.kind === 'SPRINT_IMPLEMENTATION') {
            // PBI-50 F4-T2: aggregate verify-gate via SprintTaskExecution-rows.
            // Geen single-task verify_result op de SPRINT-job zelf.
            const gate = await checkSprintVerifyGate(job_id)
            if (!gate.allowed) return toolError(gate.error)

            const plan = await prepareDoneUpdate(job_id, branch)
            actualStatus = plan.dbStatus === 'DONE' ? 'done' : 'failed'
            pushedAt = plan.pushedAt
            if (plan.branchOverride !== undefined) branchToWrite = plan.branchOverride
            if (plan.errorOverride !== undefined) errorToWrite = plan.errorOverride
            skipWorktreeCleanup = plan.skipWorktreeCleanup
            headShaToWrite = plan.headSha
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
            headShaToWrite = plan.headSha
          }
        }

        // Auto-PR: best-effort, only when push actually happened.
        // M12: idee-jobs hebben geen task_id en geen branch — skip auto-PR.
        // PBI-50: SPRINT_IMPLEMENTATION krijgt een eigen PR-flow (sprint-goal als title).
        let prUrl: string | null = null
        if (
          actualStatus === 'done' &&
          pushedAt &&
          branchToWrite &&
          job.kind === 'TASK_IMPLEMENTATION' &&
          job.task_id
        ) {
          const worktreeDir = getWorktreeRoot()
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
        } else if (
          actualStatus === 'done' &&
          pushedAt &&
          branchToWrite &&
          job.kind === 'SPRINT_IMPLEMENTATION'
        ) {
          const worktreeDir = getWorktreeRoot()
          prUrl = await maybeCreateSprintBatchPr({
            jobId: job_id,
            productId: job.product_id,
            worktreePath: path.join(worktreeDir, job_id),
            branchName: branchToWrite,
            summary,
          }).catch((err) => {
            console.warn(`[update_job_status] sprint-batch PR error for job ${job_id}:`, err)
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
            ...(actualStatus === 'done' || actualStatus === 'failed' || actualStatus === 'skipped'
              ? { finished_at: now }
              : {}),
            ...(branchToWrite !== undefined ? { branch: branchToWrite } : {}),
            ...(pushedAt !== undefined ? { pushed_at: pushedAt } : {}),
            ...(summary !== undefined ? { summary } : {}),
            ...(errorToWrite !== undefined ? { error: errorToWrite } : {}),
            ...(prUrl !== null ? { pr_url: prUrl } : {}),
            ...(headShaToWrite !== undefined ? { head_sha: headShaToWrite } : {}),
            ...(model_id !== undefined ? { model_id } : {}),
            ...(input_tokens !== undefined ? { input_tokens } : {}),
            ...(output_tokens !== undefined ? { output_tokens } : {}),
            ...(cache_read_tokens !== undefined ? { cache_read_tokens } : {}),
            ...(cache_write_tokens !== undefined ? { cache_write_tokens } : {}),
            ...(actual_thinking_tokens !== undefined ? { actual_thinking_tokens } : {}),
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
            head_sha: true,
          },
        })

        // PBI-46 sprint-flow: propageer Task → Story → PBI → Sprint → SprintRun
        // bij elke task-statusovergang (DONE of FAILED). De helper handelt ook
        // sibling-cancel binnen dezelfde SprintRun af bij FAILED.
        // Idea-jobs hebben geen task_id en worden hier overgeslagen.
        let sprintRunBecameDone = false
        let storyBecameDone = false
        if (
          (actualStatus === 'done' || actualStatus === 'failed') &&
          job.kind === 'TASK_IMPLEMENTATION' &&
          job.task_id
        ) {
          try {
            const propagation = await propagateStatusUpwards(
              job.task_id,
              actualStatus === 'done' ? 'DONE' : 'FAILED',
            )
            sprintRunBecameDone = actualStatus === 'done' && propagation.sprintRunChanged
            storyBecameDone = actualStatus === 'done' && propagation.storyChanged
          } catch (err) {
            console.warn(
              `[update_job_status] propagateStatusUpwards error for task ${job.task_id}:`,
              err,
            )
          }
        }

        // PBI-47 (P0): STORY-mode auto-merge timing fix.
        // Only enable auto-merge when this DONE was the *last* task of a STORY
        // (story.status flipped to DONE) and pr_strategy === STORY. The
        // pr-flow transition emits ENABLE_AUTO_MERGE with the head_sha guard.
        if (
          storyBecameDone &&
          updated.pr_url &&
          headShaToWrite &&
          job.kind === 'TASK_IMPLEMENTATION'
        ) {
          const storyCtx = await prisma.claudeJob.findUnique({
            where: { id: job_id },
            select: {
              task: { select: { story: { select: { status: true } } } },
              sprint_run: { select: { pr_strategy: true } },
            },
          })
          if (
            storyCtx?.sprint_run?.pr_strategy === 'STORY'
            && storyCtx.task?.story.status === 'DONE'
          ) {
            const result = prFlowTransition(
              { kind: 'pr_opened', strategy: 'STORY', prUrl: updated.pr_url },
              {
                type: 'STORY_COMPLETED',
                storyId: '',
                headSha: headShaToWrite,
              },
            )
            const outcomes = await executeEffects(result.effects)
            // PBI-47 (C2): route MERGE_CONFLICT to sprint-run flow → PAUSED.
            // Other reasons (CHECKS_FAILED, GH_AUTH_ERROR, AUTO_MERGE_NOT_ALLOWED, UNKNOWN)
            // remain warnings; CHECKS_FAILED is already covered by the task-FAIL cascade.
            for (const o of outcomes) {
              if (o.effect === 'ENABLE_AUTO_MERGE' && !o.ok) {
                console.warn(
                  `[update_job_status] auto-merge fail for ${updated.pr_url}: ${o.reason} ${o.stderr.slice(0, 200)}`,
                )
                if (o.reason === 'MERGE_CONFLICT') {
                  const sprintRunId = await prisma.claudeJob
                    .findUnique({
                      where: { id: job_id },
                      select: { sprint_run_id: true },
                    })
                    .then((j) => j?.sprint_run_id)
                  if (sprintRunId) {
                    const conflictFiles = await fetchConflictFiles(updated.pr_url)
                    const conflictResult = sprintRunTransition(
                      { kind: 'running', sprintRunId },
                      {
                        type: 'MERGE_CONFLICT',
                        prUrl: updated.pr_url,
                        prHeadSha: headShaToWrite ?? '',
                        conflictFiles,
                        resumeInstructions:
                          'Resolve the conflict on this branch, push, then resume the sprint via the UI.',
                      },
                    )
                    await executeEffects(conflictResult.effects)
                  }
                }
              }
            }
          }
        }

        // SPRINT-mode: bij sprint-DONE de draft-PR ready-for-review zetten.
        // Mens reviewt + mergt zelf — geen auto-merge in deze modus.
        // PBI-49 P2: gebruik niet alleen updated.pr_url — als de laatste task
        // verify-only is of geen wijzigingen pusht, krijgt die geen pr_url.
        // Zoek de eerst aangemaakte PR op binnen de SprintRun als fallback.
        if (sprintRunBecameDone) {
          const ctx = await prisma.claudeJob
            .findUnique({
              where: { id: job_id },
              select: {
                sprint_run_id: true,
                sprint_run: { select: { pr_strategy: true, status: true } },
              },
            })
          if (
            ctx?.sprint_run?.pr_strategy === 'SPRINT'
            && ctx.sprint_run.status === 'DONE'
            && ctx.sprint_run_id
          ) {
            const sprintPrUrl = updated.pr_url
              ?? (await prisma.claudeJob.findFirst({
                where: { sprint_run_id: ctx.sprint_run_id, pr_url: { not: null } },
                orderBy: { created_at: 'asc' },
                select: { pr_url: true },
              }))?.pr_url
              ?? null
            if (sprintPrUrl) {
              try {
                const ready = await markPullRequestReady({ prUrl: sprintPrUrl })
                if ('error' in ready) {
                  console.warn(
                    `[update_job_status] markPullRequestReady failed for ${sprintPrUrl}: ${ready.error}`,
                  )
                }
              } catch (err) {
                console.warn(`[update_job_status] markPullRequestReady error:`, err)
              }
            }
          }
        }

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
          const notifyPayload: Record<string, unknown> = {
            type: 'claude_job_status',
            job_id: updated.id,
            user_id: job.user_id,
            product_id: job.product_id,
            status: actualStatus,
            branch: updated.branch ?? undefined,
            pushed_at: updated.pushed_at?.toISOString() ?? undefined,
            pr_url: updated.pr_url ?? undefined,
            verify_result: updated.verify_result?.toLowerCase() ?? undefined,
            summary: updated.summary ?? undefined,
            error: updated.error ?? undefined,
          }
          if (job.task_id) notifyPayload.task_id = job.task_id
          if (job.idea_id) {
            notifyPayload.idea_id = job.idea_id
            notifyPayload.kind = job.kind
          }
          await pg.query(`SELECT pg_notify('scrum4me_changes', $1)`, [JSON.stringify(notifyPayload)])
          await pg.end()
        } catch {
          // non-fatal — status is already persisted
        }

        if (actualStatus === 'failed' || actualStatus === 'done') {
          const isFailed = actualStatus === 'failed'
          void triggerPush(job.user_id, {
            title: isFailed ? 'Job gefaald' : 'Job klaar',
            body: (updated.summary ?? updated.error ?? `Job ${updated.id}`).slice(0, 120),
            url: updated.pr_url ?? '/dashboard',
            tag: `job-${updated.id}`,
          })
        }

        // Best-effort worktree cleanup on terminal transitions (skip if push failed — worktree preserved)
        if (
          (actualStatus === 'done' || actualStatus === 'failed' || actualStatus === 'skipped') &&
          !skipWorktreeCleanup
        ) {
          await cleanupWorktreeForTerminalStatus(job.product_id, job_id, actualStatus, branchToWrite)
        }

        // PBI fail-cascade: when a TASK_IMPLEMENTATION job ends in FAILED,
        // cancel all queued/claimed/running siblings under the same PBI and
        // undo any pushed commits (close open PRs / open revert-PRs for
        // already-merged ones). Idempotent + non-blocking — never throws.
        // PBI-50: SPRINT_IMPLEMENTATION SKIPS this — cascade naar tasks/stories/
        // PBIs is al gebeurd via per-task update_task_status('failed')-calls
        // van de worker. Sprint-job heeft geen task_id; cancelPbi-flow past niet.
        if (actualStatus === 'failed' && job.kind === 'TASK_IMPLEMENTATION' && job.task_id) {
          await cancelPbiOnFailure(job_id)
        }

        // PBI-50 F4-T2: SPRINT_IMPLEMENTATION DONE → finalize SprintRun.
        if (
          actualStatus === 'done' &&
          job.kind === 'SPRINT_IMPLEMENTATION' &&
          job.sprint_run_id
        ) {
          try {
            await finalizeSprintRunOnDone(job.sprint_run_id)
            // Mark draft-PR ready-for-review als de SprintRun nu DONE is
            const finalRun = await prisma.sprintRun.findUnique({
              where: { id: job.sprint_run_id },
              select: { status: true },
            })
            if (finalRun?.status === 'DONE' && updated.pr_url) {
              try {
                const ready = await markPullRequestReady({ prUrl: updated.pr_url })
                if ('error' in ready) {
                  console.warn(
                    `[update_job_status] sprint-batch markPullRequestReady failed for ${updated.pr_url}: ${ready.error}`,
                  )
                }
              } catch (err) {
                console.warn(`[update_job_status] sprint-batch markPullRequestReady error:`, err)
              }
            }
          } catch (err) {
            console.warn(`[update_job_status] finalizeSprintRunOnDone error:`, err)
          }
        }

        // PBI-50 F4-T3: SPRINT_IMPLEMENTATION FAILED →
        //  - Detect QUOTA_PAUSE: error-prefix → PAUSED met pause_context.
        //  - Anders: vul SprintRun.failure_reason + failed_task_id (uit error).
        if (actualStatus === 'failed' && job.kind === 'SPRINT_IMPLEMENTATION' && job.sprint_run_id) {
          const isQuotaPause = (errorToWrite ?? '').startsWith('QUOTA_PAUSE:')
          if (isQuotaPause) {
            // Vind laatst-DONE execution voor pause-context
            const lastDone = await prisma.sprintTaskExecution.findFirst({
              where: { sprint_job_id: job_id, status: 'DONE' },
              orderBy: { order: 'desc' },
              select: { id: true, order: true, task_id: true },
            })
            await prisma.sprintRun.update({
              where: { id: job.sprint_run_id },
              data: {
                status: 'PAUSED',
                pause_context: {
                  pause_reason: 'QUOTA_DEPLETED',
                  paused_at: new Date().toISOString(),
                  resume_instructions:
                    'Wacht tot quota is gereset, dan resume de SprintRun via de UI. Een nieuwe SprintRun wordt gemaakt met previous_run_id en branch hergebruik.',
                  last_completed_execution_id: lastDone?.id ?? null,
                  last_completed_order: lastDone?.order ?? null,
                  last_completed_task_id: lastDone?.task_id ?? null,
                  pr_url: updated.pr_url ?? null,
                  pr_head_sha: updated.head_sha ?? null,
                  conflict_files: [],
                  claude_question_id: '',
                } as any,
              },
            })
          } else {
            const failedTaskId = (errorToWrite ?? '').match(/task[:\s]+([a-z0-9]+)/i)?.[1] ?? null
            await prisma.sprintRun.update({
              where: { id: job.sprint_run_id },
              data: {
                status: 'FAILED',
                failure_reason: errorToWrite?.slice(0, 500) ?? null,
                failed_task_id: failedTaskId,
                finished_at: new Date(),
              },
            })
          }
        }

        // PBI-9: release product-worktree locks on terminal transitions.
        // No-op for jobs without registered locks (i.e. TASK_IMPLEMENTATION).
        if (actualStatus === 'done' || actualStatus === 'failed' || actualStatus === 'skipped') {
          await releaseLocksOnTerminal(job_id)
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
