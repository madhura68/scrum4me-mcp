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
import {
  markWorktreeCleanupPending,
  isWorktreeCleanupPending,
  clearWorktreeCleanupPending,
} from '../git/worktree-cleanup-queue.js'
import { releaseLocksOnTerminal } from '../git/job-locks.js'
import { resolveRepoRoot } from './wait-for-job.js'
import { pushBranchForJob } from '../git/push.js'
import { notifyJobEnqueued } from '../lib/dispatch/notify.js'
import { createPullRequest, getPullRequestState, listPullRequestFiles, markPullRequestReady } from '../git/pr.js'
import { cancelPbiOnFailure } from '../cancel/pbi-cascade.js'
import { propagateStatusUpwards } from '../lib/tasks-status-update.js'
import { triggerPush } from '../lib/push-trigger.js'
import { transition as prFlowTransition } from '../flow/pr-flow.js'
import { transition as sprintRunTransition } from '../flow/sprint-run.js'
import { executeEffects } from '../flow/effects.js'
import { maybeEnqueueDeployJob } from '../lib/dispatch/deploy-job.js'
import { repoBucketKey, maybeAutoDeploySprintBatchPr } from '../lib/dispatch/sprint-batch-deploy.js'

async function fetchConflictFiles(prUrl: string): Promise<string[]> {
  const result = await listPullRequestFiles({ prUrl })
  if (Array.isArray(result)) return result
  return []
}

const inputSchema = z.object({
  job_id: z.string().min(1),
  status: z.enum(['running', 'done', 'failed', 'skipped']),
  branch: z.string().min(1).optional(),
  summary: z.string().max(4_000).optional(),
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
  // Branch-shared check: bepaal welke siblings dezelfde branch reuse'n.
  //   - SPRINT pr_strategy → alle TASK_IMPLEMENTATION jobs in dezelfde
  //     sprint_run delen feat/sprint-<id>.
  //   - STORY pr_strategy / legacy → alle TASK_IMPLEMENTATION jobs in
  //     dezelfde story delen feat/story-<id>.
  // Bij active siblings: defer cleanup (en in elk geval keepBranch=true)
  // zodat de volgende claim de branch kan reuse'n.
  const job = await prisma.claudeJob.findUnique({
    where: { id: jobId },
    select: {
      task: { select: { story_id: true, repo_url: true } },
      sprint_run_id: true,
      sprint_run: { select: { pr_strategy: true } },
    },
  })

  const repoKey = job?.task?.repo_url ?? null
  const repoRoot = await resolveRepoRoot(productId, repoKey)
  if (!repoRoot) {
    console.warn(
      `[update_job_status] cleanup skip for job=${jobId}: no repoRoot configured for product ${productId}`,
    )
    return
  }

  let activeSiblings = 0
  let scope = ''
  if (job?.sprint_run && job.sprint_run.pr_strategy === 'SPRINT') {
    activeSiblings = await prisma.claudeJob.count({
      where: {
        sprint_run_id: job.sprint_run_id,
        ...(job.task ? { task: { repo_url: repoKey } } : {}),
        status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] },
        id: { not: jobId },
      },
    })
    scope = `sprint_run ${job.sprint_run_id}`
  } else if (job?.task) {
    activeSiblings = await prisma.claudeJob.count({
      where: {
        task: { story_id: job.task.story_id, repo_url: repoKey },
        status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] },
        id: { not: jobId },
      },
    })
    scope = `story ${job.task.story_id}`
  }

  if (activeSiblings > 0) {
    console.log(
      `[update_job_status] cleanup deferred for job=${jobId}: ${activeSiblings} sibling(s) still active in ${scope}`,
    )
    return
  }

  // Keep branch when:
  //   - job is done en agent rapporteerde push (branch !== undefined), of
  //   - SPRINT pr_strategy job is skipped — andere stories delen branch.
  const keepBranch =
    (status === 'done' && branch !== undefined) ||
    (status === 'skipped' && job?.sprint_run?.pr_strategy === 'SPRINT')
  try {
    await removeWorktreeForJob({ repoRoot, jobId, keepBranch })
  } catch (err) {
    console.warn(
      `[update_job_status] cleanup FAILED for job=${jobId} keepBranch=${keepBranch}:`,
      err,
    )
  }
}

function terminalStatusForCleanup(dbStatus: string): 'done' | 'failed' | 'skipped' | null {
  if (dbStatus === 'DONE') return 'done'
  if (dbStatus === 'FAILED') return 'failed'
  if (dbStatus === 'SKIPPED') return 'skipped'
  return null
}

// Perform the worktree removal that update_job_status deferred (marked pending),
// using the same sibling-aware logic. Called by the worker runner AFTER the
// agent's Claude process has exited — i.e. after the PostToolUse usage-capture
// hook (cwd = worktree) has had its chance to run. No-op if nothing is pending.
// Best-effort: never throws.
export async function runDeferredWorktreeCleanup(jobId: string): Promise<void> {
  if (!(await isWorktreeCleanupPending(jobId))) return
  try {
    const job = await prisma.claudeJob.findUnique({
      where: { id: jobId },
      select: { product_id: true, status: true, branch: true },
    })
    const status = job ? terminalStatusForCleanup(job.status) : null
    if (job?.product_id && status) {
      await cleanupWorktreeForTerminalStatus(job.product_id, jobId, status, job.branch ?? undefined)
    }
  } catch (err) {
    console.warn(`[update_job_status] deferred worktree cleanup FAILED for job=${jobId}:`, err)
  } finally {
    await clearWorktreeCleanupPending(jobId).catch(() => {})
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
  // Resolve branch in deze volgorde:
  //   1. Expliciete `branch`-arg van Claude (meestal niet meegegeven).
  //   2. ClaudeJob.branch uit de DB — gezet door attachWorktreeToJob met de
  //      juiste pr_strategy: feat/sprint-<id> voor SPRINT, feat/story-<id>
  //      voor STORY met sibling-reuse.
  //   3. Legacy fallback feat/job-<8> — alleen voor jobs zonder DB-branch
  //      (zou niet moeten voorkomen na PBI-50).
  let resolvedBranch = branch
  if (!resolvedBranch) {
    const dbJob = await prisma.claudeJob.findUnique({
      where: { id: jobId },
      select: { branch: true },
    })
    resolvedBranch = dbJob?.branch ?? undefined
  }
  const branchName = resolvedBranch ?? `feat/job-${jobId.slice(-8)}`

  const worktreeDir = getWorktreeRoot()
  const worktreePath = path.join(worktreeDir, jobId)

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

export type JobTimestampUpdate = {
  claimed_at?: Date
  started_at?: Date
  finished_at?: Date
}

// Bepaalt welke lifecycle-timestamps update_job_status schrijft bij een
// status-overgang. Set-once (backfill alleen als nu null) houdt de invariant
// claimed_at ≤ started_at ≤ finished_at: een job die CLAIMED → done gaat
// zonder `running`-rapport krijgt alsnog een started_at, en claimed_at
// (normaal door wait_for_job bij claim gezet) wordt nooit overschreven.
export function resolveJobTimestamps(
  status: 'running' | 'done' | 'failed' | 'skipped',
  current: { claimed_at: Date | null; started_at: Date | null },
  now: Date = new Date(),
): JobTimestampUpdate {
  const isTerminal = status === 'done' || status === 'failed' || status === 'skipped'
  const update: JobTimestampUpdate = {}
  if (current.claimed_at == null) update.claimed_at = now
  if (current.started_at == null && (status === 'running' || isTerminal)) {
    update.started_at = now
  }
  if (isTerminal) update.finished_at = now
  return update
}

// M17 E2E-bevinding #7 (2026-07-06): de auto-merge-gate is LEVEL-triggered.
// Bewust géén "story werd zojuist DONE"-input: de agent zet binnen de job
// vaak zelf de taak op done (update_task_status), waardoor de story-DONE-edge
// al verbruikt is vóórdat update_job_status draait. De story-status zelf
// (DONE?) checkt de handler apart via de storyCtx-query; dubbel vuren bij
// out-of-order siblings is veilig (DB-harde deploy-dedup; tweede
// auto-merge-enable is een no-op).
export function isStoryAutoMergeCandidate(input: {
  actualStatus: string
  prUrl: string | null | undefined
  headSha: string | null | undefined
  kind: string
  source: string
  taskId: string | null
}): boolean {
  return (
    input.actualStatus === 'done' &&
    !!input.prUrl &&
    !!input.headSha &&
    input.kind === 'TASK_IMPLEMENTATION' &&
    input.source !== 'MANUAL' &&
    !!input.taskId
  )
}

// M17 E2E-bevinding #5 (2026-07-06): sibling-PR's alleen hergebruiken zolang
// ze OPEN staan. Story-/sprint-siblings delen bewust één branch+PR, maar na
// een merge/close van die PR moet een latere taak een níeuwe PR openen —
// anders landt de commit onzichtbaar op een dichte PR en stopt de
// auto-review→auto-merge→deploy-keten (T-1382: commit gestrand op gemergde
// #105). Neemt de EERSTE open kandidaat zodat opvolgende taken blijven
// stapelen op de lopende PR i.p.v. per taak een nieuwe te openen. Bij een
// lookup-fout hergebruiken we op het oude gedrag (liever een mogelijk-dichte
// PR dan PR-spam bij een haperende Forgejo).
export async function firstOpenPrUrl(
  urls: Array<string | null | undefined>,
): Promise<string | null> {
  const seen = new Set<string>()
  for (const url of urls) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    const info = await getPullRequestState({ prUrl: url })
    if ('error' in info) {
      console.warn(
        `[update_job_status] PR-state-lookup faalde voor ${url}; hergebruik op oud gedrag: ${info.error}`,
      )
      return url
    }
    if (info.state === 'OPEN') return url
  }
  return null
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
    select: { auto_pr: true, repo_url: true },
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
      repo_url: true,
      story: { select: { id: true, code: true, title: true } },
    },
  })
  if (!task) return null

  // Cross-repo sprints: een sprint kan taken hebben die via task.repo_url een
  // ander repo targeten. PRs en branches zijn per-repo, dus een sibling-PR mag
  // alleen hergebruikt worden als die sibling hetzelfde repo targette. null/leeg
  // repo_url = het product-repo; twee taken zitten in dezelfde repo-bucket als
  // hun repoBucketKey (M21: één gedeelde normalisatie die null/leeg én de
  // expliciete product-url ± .git op dezelfde product-bucket=null mapt) gelijk is.
  const thisRepoKey = repoBucketKey(task.repo_url, product.repo_url)

  // PBI-46 SPRINT-mode: hergebruik 1 draft-PR voor de hele SprintRun (per repo).
  // Mens zet 'm ready-for-review zodra de SprintRun DONE is.
  if (job?.sprint_run && job.sprint_run.pr_strategy === 'SPRINT') {
    const sprintSiblings = await prisma.claudeJob.findMany({
      where: {
        sprint_run_id: job.sprint_run_id,
        pr_url: { not: null },
        id: { not: jobId },
      },
      select: { pr_url: true, task: { select: { repo_url: true } } },
      orderBy: { created_at: 'asc' },
    })
    const sprintReuse = await firstOpenPrUrl(
      sprintSiblings
        .filter((s) => repoBucketKey(s.task?.repo_url, product.repo_url) === thisRepoKey)
        .map((s) => s.pr_url),
    )
    if (sprintReuse) return sprintReuse

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

  // STORY-mode (default of legacy): branch-per-story, sibling-tasks delen PR
  // — maar alleen siblings die hetzelfde repo targeten (zie thisRepoKey).
  const storySiblings = await prisma.claudeJob.findMany({
    where: {
      task: { story_id: task.story.id },
      pr_url: { not: null },
      id: { not: jobId },
    },
    select: { pr_url: true, task: { select: { repo_url: true } } },
    orderBy: { created_at: 'asc' },
  })
  const storyReuse = await firstOpenPrUrl(
    storySiblings
      .filter((s) => repoBucketKey(s.task?.repo_url, product.repo_url) === thisRepoKey)
      .map((s) => s.pr_url),
  )
  if (storyReuse) return storyReuse

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
    const prevReuse = await firstOpenPrUrl([prevPr?.pr_url])
    if (prevReuse) return prevReuse
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

// M17 (spec §3): DEPLOY-skips zijn machine-leesbaar — alleen deze twee redenen.
export function checkDeploySkipReason(
  error: string | undefined,
): { allowed: true } | { allowed: false; error: string } {
  const reason = (error ?? '').trim()
  // PREFIX-match (geen `$`-anchor): staarten zoals ': 77199ba al live' zijn toegestaan.
  if (/^(doc_only_merge|merge_sha_already_deployed)\b/.test(reason)) return { allowed: true }
  return {
    allowed: false,
    error: "DEPLOY 'skipped' vereist reden 'doc_only_merge' of 'merge_sha_already_deployed' in error",
  }
}

export type DeployTerminalInput = {
  jobId: string
  productId: string
  status: 'done' | 'failed' | 'skipped'
  summary?: string | null
  error?: string | null
}

// M17 (spec §3/§6): het terminale statuspunt van een DEPLOY en de bijbehorende
// queue-mutaties zijn één product-locked kritieke sectie:
// lock → terminale claudeJob.update → (failed: bulk-cancel QUEUED) /
// (done: resolved_at-lift). SSE/web-push doet de aanroeper ná commit.
export async function applyDeployTerminalUpdate(input: DeployTerminalInput): Promise<{
  updated: { id: string; status: string; summary: string | null; error: string | null; pr_url: string | null }
  cancelledIds: string[]
}> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('deploy'), hashtext(${input.productId}))`
    const updated = await tx.claudeJob.update({
      where: { id: input.jobId },
      data: {
        status: input.status === 'done' ? 'DONE' : input.status === 'failed' ? 'FAILED' : 'SKIPPED',
        summary: input.summary ?? undefined,
        error: input.error ?? undefined,
        finished_at: new Date(),
      },
      select: { id: true, status: true, summary: true, error: true, pr_url: true },
    })
    if (input.status === 'failed') {
      const queued = await tx.claudeJob.findMany({
        where: { product_id: input.productId, kind: 'DEPLOY', status: 'QUEUED' },
        select: { id: true },
      })
      if (queued.length > 0) {
        await tx.claudeJob.updateMany({
          where: { id: { in: queued.map((q) => q.id) } },
          data: {
            status: 'CANCELLED',
            error: `superseded: deploy voor product faalde (job ${input.jobId})`,
            finished_at: new Date(),
          },
        })
      }
      return { updated, cancelledIds: queued.map((q) => q.id) }
    }
    if (input.status === 'done') {
      await tx.claudeJob.updateMany({
        where: {
          product_id: input.productId,
          kind: 'DEPLOY',
          status: 'FAILED',
          resolved_at: null,
          id: { not: input.jobId },
        },
        data: { resolved_at: new Date() },
      })
    }
    return { updated, cancelledIds: [] }
  })
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
        'Stamps started_at on running and finished_at on done/failed/skipped, and backfills ' +
        'claimed_at/started_at when missing so claimed_at ≤ started_at ≤ finished_at always holds. ' +
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
            claimed_at: true,
            started_at: true,
            claimed_by_token_id: true,
            user_id: true,
            product_id: true,
            task_id: true,
            idea_id: true,
            sprint_run_id: true,
            kind: true,
            runtime: true,
            source: true,
            verify_result: true,
            created_at: true,
            chat_cutoff_message_id: true,
            chat_cutoff_at: true,
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
        // M17: DEPLOY heeft een eigen, strakkere skipped-reden-validatie
        // (spec §3: alleen doc_only_merge | merge_sha_already_deployed).
        if (status === 'skipped') {
          if (job.kind === 'DEPLOY') {
            const check = checkDeploySkipReason(error)
            if (!check.allowed) return toolError(check.error)
          } else if (job.kind !== 'TASK_IMPLEMENTATION') {
            return toolError(
              `'skipped' is alleen toegestaan voor TASK_IMPLEMENTATION of DEPLOY (kind=${job.kind})`,
            )
          } else if (!error || error.trim().length < 10) {
            return toolError(
              "'skipped' vereist non-empty error met reden (≥10 chars), bv. 'no_op_changes_already_in_main'",
            )
          }
        }

        const isSystemPlanChat =
          job.kind === 'PLAN_CHAT' &&
          job.source === 'SYSTEM' &&
          !!job.idea_id
        const planChatAnswer = summary?.trim()
        if (status === 'done' && isSystemPlanChat && !planChatAnswer) {
          return toolError(
            "PLAN_CHAT done vereist een non-empty summary; deze summary wordt als antwoord aan de gebruiker getoond.",
          )
        }

        // M17 idea-chat: chat-beurten sluiten af met de summary als
        // ASSISTANT-bericht in het kanaal (spec §4.4).
        const isSystemIdeaChat =
          job.kind === 'IDEA_CHAT' &&
          job.source === 'SYSTEM' &&
          !!job.idea_id
        const ideaChatAnswer = summary?.trim()
        if (status === 'done' && isSystemIdeaChat && !ideaChatAnswer) {
          return toolError(
            'IDEA_CHAT done vereist een non-empty summary; die wordt letterlijk het chatbericht in het idee-kanaal.',
          )
        }

        // For DONE: push first, adjust DB status based on result
        let actualStatus = status
        let pushedAt: Date | undefined
        let branchToWrite = branch
        let errorToWrite = error
        let skipWorktreeCleanup = false
        let headShaToWrite: string | undefined

        // M17: DEPLOY heeft nooit een worktree — geldt voor done, failed én
        // skipped (anders maakt de markWorktreeCleanupPending-call verderop
        // nodeloos een cleanup-marker aan).
        if (job.kind === 'DEPLOY') skipWorktreeCleanup = true

        if (status === 'done') {
          if (job.source === 'MANUAL') {
            actualStatus = 'done'
            skipWorktreeCleanup = true
          } else if (
            job.source === 'ORCHESTRATOR' &&
            job.kind === 'PLAN_CHAT' &&
            !job.task_id &&
            !job.idea_id &&
            !job.sprint_run_id
          ) {
            actualStatus = 'done'
            skipWorktreeCleanup = true
          } else if (isSystemPlanChat) {
            actualStatus = 'done'
            skipWorktreeCleanup = true
          } else if (isSystemIdeaChat) {
            // M17 idea-chat: geen worktree/verify/push — de beurt sluit via de
            // dedicated transactie hieronder (message-write + coalescing).
            actualStatus = 'done'
            skipWorktreeCleanup = true
          } else if (
            job.kind === 'IDEA_GRILL' ||
            job.kind === 'IDEA_MAKE_PLAN' ||
            (job.source !== 'ORCHESTRATOR' &&
              (job.kind === 'IDEA_REVIEW_PLAN' ||
                job.kind === 'PR_REVIEW' ||
                job.kind === 'SPEC_REVIEW' ||
                job.kind === 'TASK_REVIEW'))
          ) {
            // idea-jobs AND review-jobs have no task/worktree/verify_result/branch — they complete
            // via their own sink (idea: update_idea_*; reviews: submit_review/post_pr_review/
            // update_idea_plan_reviewed). So skip the verify-gate + git-push (prepareDoneUpdate)
            // for them, regardless of source. MANUAL-source jobs are already handled by the
            // earlier branch. ORCHESTRATOR-source review jobs fall through to the generic
            // verify-gate (the else branch below) — they may carry a real verify pipeline.
            actualStatus = 'done'
            // pushedAt blijft undefined, branch/error overrides ook
            skipWorktreeCleanup = true
          } else if (job.kind === 'DEPLOY') {
            // M17 (spec §3): DEPLOY rapporteert een server-side effect — DB-only
            // terminale update. Geen verify-gate (verify_result blijft null),
            // geen prepareDoneUpdate/push, geen auto-PR, geen propagatie.
            actualStatus = 'done'
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
          job.source !== 'MANUAL' &&
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
        const jobUpdateData = {
          status: dbStatus,
          ...resolveJobTimestamps(
            actualStatus,
            { claimed_at: job.claimed_at, started_at: job.started_at },
            now,
          ),
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
        }
        const jobUpdateSelect = {
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
        } as const

        let updated: {
          id: string
          status: string
          branch: string | null
          pushed_at: Date | null
          pr_url: string | null
          verify_result: string | null
          summary: string | null
          error: string | null
          started_at: Date | null
          finished_at: Date | null
          head_sha: string | null
        }
        let ideaChatFollowUpId: string | null = null
        let deployCancelledIds: string[] = []

        if (
          job.kind === 'DEPLOY' &&
          (actualStatus === 'done' || actualStatus === 'failed' || actualStatus === 'skipped')
        ) {
          // M17 (spec §3/§6): DB-only terminale transitie — lock + terminale
          // update + bulk-cancel (failed) / resolved_at-lift (done) in één
          // product-locked tx. Geen prepareDoneUpdate/push/auto-PR/propagatie.
          // ('running' valt door naar de generieke update hieronder — DEPLOY
          // heeft daar geen eigen lifecycle-logica voor nodig.)
          const deployResult = await applyDeployTerminalUpdate({
            jobId: job_id,
            productId: job.product_id,
            status: actualStatus,
            summary,
            error: errorToWrite,
          })
          updated = {
            ...deployResult.updated,
            branch: null,
            pushed_at: null,
            verify_result: null,
            started_at: job.started_at,
            finished_at: now,
            head_sha: null,
          }
          deployCancelledIds = deployResult.cancelledIds
        } else if (isSystemIdeaChat && (actualStatus === 'done' || actualStatus === 'failed')) {
          // M17 idea-chat (spec §4.5): status-flip + assistant-write +
          // coalescing-check atomair onder dezelfde per-idea lock als
          // sendIdeaChatMessage (web). Zo kan geen bericht tussen wal en schip
          // vallen (lost wakeup) en ontstaat nooit een dubbele actieve job.
          const txResult = await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM ideas WHERE id = ${job.idea_id} FOR UPDATE`

            const u = await tx.claudeJob.update({
              where: { id: job_id },
              data: jobUpdateData,
              select: jobUpdateSelect,
            })

            if (actualStatus === 'done' && ideaChatAnswer) {
              await tx.ideaChatMessage.create({
                data: {
                  idea_id: job.idea_id!,
                  role: 'ASSISTANT',
                  kind: 'TEXT',
                  content: ideaChatAnswer,
                  job_id,
                },
              })
            }
            if (actualStatus === 'failed') {
              // Spec §4.7: FAILED → IdeaLog JOB_EVENT (audit, projectie in het
              // kanaal); géén Idea.status-mutatie — IDEA_CHAT is status-neutraal.
              await tx.ideaLog.create({
                data: {
                  idea_id: job.idea_id!,
                  type: 'JOB_EVENT',
                  content: 'IDEA_CHAT failed',
                  metadata: { job_id, error: errorToWrite ?? null },
                },
              })
            }

            // Coalescing: USER-berichten ná de gepersisteerde cutoff → precies
            // één vervolg-job. Elke (ook mislukte) job schuift de cutoff bij
            // zíjn claim op, dus een failure-loop is uitgesloten.
            const cutoffAt = job.chat_cutoff_at ?? job.created_at
            const cutoffId = job.chat_cutoff_message_id ?? ''
            const newer = await tx.ideaChatMessage.findFirst({
              where: {
                idea_id: job.idea_id!,
                role: 'USER',
                OR: [
                  { created_at: { gt: cutoffAt } },
                  { created_at: cutoffAt, id: { gt: cutoffId } },
                ],
              },
              select: { id: true },
            })
            if (!newer) return { updated: u, followUpId: null as string | null }
            const followUp = await tx.claudeJob.create({
              data: {
                user_id: job.user_id,
                product_id: job.product_id,
                idea_id: job.idea_id!,
                kind: 'IDEA_CHAT',
                status: 'QUEUED',
              },
              select: { id: true },
            })
            return { updated: u, followUpId: followUp.id }
          })
          updated = txResult.updated
          ideaChatFollowUpId = txResult.followUpId
        } else {
          updated = await prisma.claudeJob.update({
            where: { id: job_id },
            data: jobUpdateData,
            select: jobUpdateSelect,
          })
        }

        if (ideaChatFollowUpId) {
          // Buiten de tx (pas ná commit melden); wekt wachtende
          // wait_for_job-LISTENers — anders duurt het tot de volgende poll.
          await notifyJobEnqueued({
            job_id: ideaChatFollowUpId,
            user_id: job.user_id,
            product_id: job.product_id,
            kind: 'IDEA_CHAT',
            idea_id: job.idea_id!,
          })
        }

        if (actualStatus === 'done' && isSystemPlanChat && planChatAnswer) {
          const pendingQuestion = await prisma.userQuestion.findFirst({
            where: { idea_id: job.idea_id!, status: 'pending' },
            orderBy: { created_at: 'desc' },
            select: { id: true },
          })
          if (pendingQuestion) {
            await prisma.userQuestion.updateMany({
              where: { id: pendingQuestion.id, status: 'pending' },
              data: { status: 'answered', answer: planChatAnswer },
            })
          }
        }

        // PBI-46 sprint-flow: propageer Task → Story → PBI → Sprint → SprintRun
        // bij elke task-statusovergang (DONE of FAILED). De helper handelt ook
        // sibling-cancel binnen dezelfde SprintRun af bij FAILED.
        // Idea-jobs hebben geen task_id en worden hier overgeslagen.
        let sprintRunBecameDone = false
        if (
          (actualStatus === 'done' || actualStatus === 'failed') &&
          job.kind === 'TASK_IMPLEMENTATION' &&
          job.source !== 'MANUAL' &&
          job.task_id
        ) {
          try {
            const propagation = await propagateStatusUpwards(
              job.task_id,
              actualStatus === 'done' ? 'DONE' : 'FAILED',
            )
            sprintRunBecameDone = actualStatus === 'done' && propagation.sprintRunChanged
          } catch (err) {
            console.warn(
              `[update_job_status] propagateStatusUpwards error for task ${job.task_id}:`,
              err,
            )
          }
        }

        // PBI-47 (P0): STORY-mode auto-merge timing fix.
        // Only enable auto-merge for the *last* task of a STORY (story DONE)
        // and pr_strategy === STORY. The pr-flow transition emits
        // ENABLE_AUTO_MERGE with the head_sha guard.
        //
        // M17 E2E-bevinding #7 (2026-07-06): LEVEL-triggered, niet
        // edge-triggered. De agent zet binnen de job vaak zelf de taak op done
        // (update_task_status), waardoor de story al DONE is vóórdat déze
        // update_job_status-call draait — propagateStatusUpwards ziet dan geen
        // transitie meer (storyChanged=false) en de edge is "verbruikt"
        // (T-1387: story DONE om 17:29:33, job-DONE om 17:29:40 → blok
        // geskipt, geen auto-merge, geen DEPLOY-enqueue). De beslissende check
        // is de storyCtx-query hieronder (story.status === 'DONE'); dubbel
        // vuren bij out-of-order siblings is veilig: de DEPLOY-enqueue is
        // DB-hard gededupt op orchestration_key en een tweede
        // auto-merge-enable op een al-geschedulede/gemergde PR is een no-op
        // die hooguit een warn logt.
        if (
          // Truthiness eerst (TS-narrowing voor updated.pr_url/headShaToWrite
          // verderop in het blok); de helper is de semantische gate.
          updated.pr_url &&
          headShaToWrite &&
          isStoryAutoMergeCandidate({
            actualStatus,
            prUrl: updated.pr_url,
            headSha: headShaToWrite,
            kind: job.kind,
            source: job.source,
            taskId: job.task_id,
          })
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
              // M17 (spec §3): geslaagd auto-merge-enable ⇒ DEPLOY-job enqueuen.
              if (o.effect === 'ENABLE_AUTO_MERGE' && o.ok && updated.pr_url && headShaToWrite) {
                await maybeEnqueueDeployJob({
                  parentJobId: job_id,
                  userId: job.user_id,
                  productId: job.product_id,
                  prUrl: updated.pr_url,
                  headSha: headShaToWrite,
                }).catch((err) => {
                  // Persistent signaal (codex plan-r1 #8): een merge zonder
                  // deploy mag niet onzichtbaar zijn — push naast de log.
                  console.error('[deploy-enqueue]', err)
                  void triggerPush(job.user_id, {
                    title: 'Deploy-enqueue mislukt',
                    body: (err instanceof Error ? err.message : String(err)).slice(0, 120),
                    url: '/jobs',
                    tag: `deploy-enqueue-${job_id}`,
                  })
                })
              }
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
            // M21: opt-in auto-deploy voor de sprint-batch (ná ready-maken).
            await maybeAutoDeploySprintBatchPr({
              jobId: job_id,
              userId: job.user_id,
              productId: job.product_id,
              sprintRunId: ctx.sprint_run_id,
            }).catch((err) => {
              console.warn('[update_job_status] sprint-batch auto-deploy error:', err)
            })
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
            type: 'claude_job_status_changed',
            job_id: updated.id,
            user_id: job.user_id,
            product_id: job.product_id,
            kind: job.kind,
            status: updated.status,
            runtime: job.runtime ?? 'CLAUDE',
            source: job.source ?? 'SYSTEM',
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
          }
          await pg.query(`SELECT pg_notify('scrum4me_changes', $1)`, [JSON.stringify(notifyPayload)])

          // M17 (spec §6): per gecancelde QUEUED DEPLOY-sibling (failed-branch
          // bulk-cancel) een eigen SSE-notify — web-push blijft alleen op de
          // job zelf (triggerPush hieronder), niet per cancelledId.
          for (const cancelledId of deployCancelledIds) {
            await pg.query(`SELECT pg_notify('scrum4me_changes', $1)`, [
              JSON.stringify({
                type: 'claude_job_status_changed',
                job_id: cancelledId,
                user_id: job.user_id,
                product_id: job.product_id,
                kind: 'DEPLOY',
                status: 'cancelled',
              }),
            ])
          }

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

        // Worktree cleanup on terminal transitions (skip if push failed — worktree preserved).
        // DEFER the actual removal: the PostToolUse usage-capture hook is spawned by
        // Claude Code with cwd = this worktree and fires after update_job_status returns;
        // removing the worktree inline would make the hook spawn fail (ENOENT) and token
        // usage would never be persisted. We mark cleanup pending here; the worker runner
        // (run-one-job) calls runDeferredWorktreeCleanup() once the agent process exits.
        if (
          (actualStatus === 'done' || actualStatus === 'failed' || actualStatus === 'skipped') &&
          !skipWorktreeCleanup
        ) {
          await markWorktreeCleanupPending(job_id)
        }

        // PBI fail-cascade: when a TASK_IMPLEMENTATION job ends in FAILED,
        // cancel all queued/claimed/running siblings under the same PBI and
        // undo any pushed commits (close open PRs / open revert-PRs for
        // already-merged ones). Idempotent + non-blocking — never throws.
        // PBI-50: SPRINT_IMPLEMENTATION SKIPS this — cascade naar tasks/stories/
        // PBIs is al gebeurd via per-task update_task_status('failed')-calls
        // van de worker. Sprint-job heeft geen task_id; cancelPbi-flow past niet.
        if (
          actualStatus === 'failed' &&
          job.kind === 'TASK_IMPLEMENTATION' &&
          job.source !== 'MANUAL' &&
          job.task_id
        ) {
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
              // M21: opt-in auto-deploy voor de single-session sprint-batch.
              await maybeAutoDeploySprintBatchPr({
                jobId: job_id,
                userId: job.user_id,
                productId: job.product_id,
                sprintRunId: job.sprint_run_id,
              }).catch((err) => {
                console.warn('[update_job_status] sprint-batch auto-deploy error:', err)
              })
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
