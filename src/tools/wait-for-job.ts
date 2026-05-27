// wait_for_job — blokkeert tot een QUEUED ClaudeJob beschikbaar is, claimt 'm
// atomisch via FOR UPDATE SKIP LOCKED, en retourneert de volledige task-context.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from 'pg'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prisma } from '../prisma.js'

const execFileP = promisify(execFile)
import { requireWriteAccess } from '../auth.js'
import { toolJson, toolError, withToolErrors } from '../errors.js'
import { createWorktreeForJob, removeWorktreeForJob } from '../git/worktree.js'
import { getWorktreeRoot } from '../git/worktree-paths.js'
import { setupProductWorktrees, releaseLocksOnTerminal } from '../git/job-locks.js'
import { pushBranchForJob } from '../git/push.js'
import { resolveJobConfig } from '../lib/job-config.js'
import { claimLog } from '../lib/claim-log.js'
import { getInstanceId } from '../presence/instance.js'

/** Parse `https://github.com/<owner>/<name>(.git)?` → `<name>`. */
export function repoNameFromUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null
  const m = repoUrl.match(/[/:]([^/]+?)(?:\.git)?\/?$/)
  return m ? m[1] : null
}

/**
 * Resolve the repo-root path on disk for a job's worktree.
 *
 * Lookup order (first hit wins):
 *  1. `task.repo_url`-override → match against config / convention via repo-name
 *  2. env var `SCRUM4ME_REPO_ROOT_<productId>`
 *  3. `~/.scrum4me-agent-config.json` `repoRoots[productId]`
 *  4. Convention `~/Projects/<repo-name-from-product.repo_url>/.git`
 *
 * The task-level override exists for cross-repo tasks (e.g. an MCP-server
 * task tracked under the main product's PBI). Falls back to product-level
 * resolution when null. Documented in CLAUDE.md.
 */
export async function resolveRepoRoot(
  productId: string,
  taskRepoUrl?: string | null,
): Promise<string | null> {
  const resolved = (via: string, repoRoot: string): string => {
    claimLog('repoRoot.resolved', { productId, via, repoRoot })
    return repoRoot
  }
  const unresolved = (): null => {
    claimLog('repoRoot.unresolved', { productId, taskRepoUrl: taskRepoUrl ?? null })
    return null
  }

  // 1. Task-level override: match by repo-name through config/convention
  if (taskRepoUrl) {
    const taskRepoName = repoNameFromUrl(taskRepoUrl)
    if (taskRepoName) {
      const overrideEnv = `SCRUM4ME_REPO_ROOT_REPO_${taskRepoName}`
      if (process.env[overrideEnv]) return resolved('task-env', process.env[overrideEnv]!)

      const configPath = path.join(os.homedir(), '.scrum4me-agent-config.json')
      try {
        const raw = await fs.readFile(configPath, 'utf-8')
        const config = JSON.parse(raw) as { repoRoots?: Record<string, string> }
        if (config.repoRoots?.[taskRepoName]) return resolved('task-config', config.repoRoots[taskRepoName])
      } catch { /* fall through */ }

      const candidate = path.join(os.homedir(), 'Projects', taskRepoName)
      try {
        await fs.access(path.join(candidate, '.git'))
        return resolved('task-convention', candidate)
      } catch { /* fall through to product-level */ }
    }
  }

  // 2. Env var per-product
  const envKey = `SCRUM4ME_REPO_ROOT_${productId}`
  if (process.env[envKey]) return resolved('product-env', process.env[envKey]!)

  // 3. Config file per-product
  const configPath = path.join(os.homedir(), '.scrum4me-agent-config.json')
  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    const config = JSON.parse(raw) as { repoRoots?: Record<string, string> }
    if (config.repoRoots?.[productId]) return resolved('product-config', config.repoRoots[productId])
  } catch {
    // ignore — fall through
  }

  // 4. Convention via product.repo_url
  try {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { repo_url: true },
    })
    const name = repoNameFromUrl(product?.repo_url)
    if (!name) return unresolved()
    const candidate = path.join(os.homedir(), 'Projects', name)
    await fs.access(path.join(candidate, '.git'))
    return resolved('product-convention', candidate)
  } catch {
    return unresolved()
  }
}

export async function rollbackClaim(jobId: string): Promise<void> {
  // Eerst de DB-row terugzetten naar QUEUED, dan best-effort cleanen wat de
  // claim had aangemaakt zodat een volgende claim-attempt niet stuck loopt.
  //
  // Pre-2026-05-27 deed deze functie alleen de UPDATE. Gevolg: bij een
  // transient claude-fout (Anthropic 529, network blip, OOM) bleven de
  // worktree (`/home/agent/.scrum4me-agent-worktrees/<jobId>`) en — voor
  // SPRINT_IMPLEMENTATION — de zojuist gecreëerde `sprint_task_executions`
  // hangen. De retry-iteratie hit dan `Worktree path already exists` of
  // `Unique constraint failed (sprint_job_id, task_id)` → permanent stuck.
  //
  // Best-effort: cleanup-fouten mogen de rollback niet blokkeren. Een
  // verloren worktree-cleanup blijft een handmatige cleanup-task, maar de
  // rollback zelf moet altijd slagen.
  const job = (await prisma.claudeJob?.findUnique({
    where: { id: jobId },
    select: {
      kind: true,
      product_id: true,
      task: { select: { repo_url: true } },
    },
  })) ?? null

  await prisma.$executeRaw`
    UPDATE claude_jobs
    SET status = 'QUEUED',
        claimed_by_token_id = NULL,
        claimed_at = NULL,
        plan_snapshot = NULL,
        worker_instance_id = NULL,
        lease_until = NULL
    WHERE id = ${jobId}
  `

  if (!job) return

  // SPRINT-specifiek: getFullJobContext creëert sprint_task_executions rows
  // via createMany met UNIQUE(sprint_job_id, task_id). Zonder cleanup faalt
  // de tweede claim-attempt op die unique constraint.
  if (job.kind === 'SPRINT_IMPLEMENTATION') {
    try {
      await prisma.sprintTaskExecution.deleteMany({ where: { sprint_job_id: jobId } })
    } catch (err) {
      claimLog('rollback.executions_cleanup_failed', {
        jobId,
        error: (err as Error).message,
      })
    }
  }

  // Worktree cleanup voor élke kind die er één had. `removeWorktreeForJob`
  // doet `git worktree remove --force` (cleant bare-repo registratie) en
  // verwijdert de branch indien op een rollback geen werk gepushed is.
  // Best-effort: als repoRoot niet resolved (b.v. quota-probe failure vóór
  // worktree-creation), is er ook geen worktree om te cleanen.
  try {
    if (job.product_id) {
      const repoRoot = await resolveRepoRoot(job.product_id, job.task?.repo_url ?? null)
      if (repoRoot) {
        await removeWorktreeForJob({ repoRoot, jobId })
      }
    }
  } catch (err) {
    claimLog('rollback.worktree_cleanup_failed', {
      jobId,
      error: (err as Error).message,
    })
  }
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
  // Sprint-flow (PBI-46): als deze job aan een SprintRun hangt, kies de branch
  // op basis van Product.pr_strategy:
  //   SPRINT → feat/sprint-<sprint_run_id-suffix> (één branch voor hele run)
  //   STORY  → feat/story-<story_id-suffix>      (één branch per story; sibling-tasks delen 'm)
  // Voor legacy task-jobs zonder sprint_run_id valt de logica terug op het
  // bestaande feat/story-<storyId>-pad.
  const job = await prisma.claudeJob.findUnique({
    where: { id: jobId },
    select: {
      sprint_run_id: true,
      sprint_run: { select: { id: true, pr_strategy: true } },
    },
  })

  if (job?.sprint_run && job.sprint_run.pr_strategy === 'SPRINT') {
    const branchName = `feat/sprint-${job.sprint_run.id.slice(-8)}`
    const sibling = await prisma.claudeJob.findFirst({
      where: {
        sprint_run_id: job.sprint_run_id,
        branch: branchName,
        id: { not: jobId },
      },
      orderBy: { created_at: 'asc' },
      select: { branch: true },
    })
    return { branchName, reused: sibling !== null }
  }

  // STORY-mode (default) of legacy: branch per story
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
  taskRepoUrl?: string | null,
): Promise<{ worktree_path: string; branch_name: string; reused_branch: boolean } | { error: string }> {
  claimLog('attach.start', { jobId, productId })
  const repoRoot = await resolveRepoRoot(productId, taskRepoUrl)
  if (!repoRoot) {
    await rollbackClaim(jobId)
    const repoHint = taskRepoUrl
      ? `task.repo_url=${taskRepoUrl}`
      : `product ${productId}`
    return {
      error:
        `No repo root configured for ${repoHint}. ` +
        `Set env var SCRUM4ME_REPO_ROOT_${productId}, add a repoRoots entry to ~/.scrum4me-agent-config.json, ` +
        `or place a clone at ~/Projects/<repo-name>.`,
    }
  }

  const { branchName, reused } = await resolveBranchForJob(jobId, storyId)
  claimLog('attach.branch', { jobId, branchName, reused })
  try {
    const { worktreePath, branchName: actualBranch } = await createWorktreeForJob({
      repoRoot,
      jobId,
      branchName,
      reuseBranch: reused,
    })

    // PBI-47 (P0): capture base_sha so verify_task_against_plan can diff
    // against the claim-time HEAD instead of origin/main. For reused branches
    // (siblings already pushed), base_sha = SHA of the worktree HEAD now.
    // For fresh branches, base_sha = origin/main HEAD which createWorktreeForJob
    // just checked out.
    let baseSha: string | null = null
    try {
      const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
      baseSha = stdout.trim()
    } catch (err) {
      claimLog('attach.baseShaFailed', { jobId, error: String((err as Error).message).slice(0, 200) })
    }
    // Persist branch + base_sha. update_job_status (prepareDoneUpdate)
    // leest claudeJob.branch om naar de juiste ref te pushen — zonder deze
    // update valt 'ie terug op het legacy `feat/job-<8>` patroon en faalt
    // de push met "src refspec ... does not match any" voor sprint/story
    // strategy branches.
    await prisma.claudeJob.update({
      where: { id: jobId },
      data: {
        branch: actualBranch,
        ...(baseSha ? { base_sha: baseSha } : {}),
      },
    })

    claimLog('attach.done', { jobId, branchName: actualBranch, baseSha })
    return { worktree_path: worktreePath, branch_name: actualBranch, reused_branch: reused }
  } catch (err) {
    claimLog('attach.failed', { jobId, error: String((err as Error).message).slice(0, 200) })
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
  // PBI-50: lease-driven stale-detection. Jobs in CLAIMED of RUNNING met
  // verlopen lease_until (default 5 min, verlengd door job_heartbeat) worden
  // gereset. Legacy jobs zonder lease_until vallen terug op de oude
  // claimed_at + 30-min-regel.
  type StaleRow = {
    id: string
    task_id: string | null
    product_id: string
    kind: string
    sprint_run_id: string | null
    branch: string | null
  }

  const failedRows = await prisma.$queryRaw<StaleRow[]>`
    UPDATE claude_jobs
    SET status = 'FAILED',
        finished_at = NOW(),
        error = ${STALE_ERROR_MSG}
    WHERE user_id = ${userId}
      AND status IN ('CLAIMED', 'RUNNING')
      AND retry_count >= 2
      AND (
        lease_until < NOW()
        OR (lease_until IS NULL AND claimed_at < NOW() - INTERVAL '30 minutes')
      )
    RETURNING id, task_id, product_id, kind::text AS kind, sprint_run_id, branch
  `

  const requeuedRows = await prisma.$queryRaw<
    (StaleRow & { retry_count: number })[]
  >`
    UPDATE claude_jobs
    SET status = 'QUEUED',
        claimed_by_token_id = NULL,
        claimed_at = NULL,
        plan_snapshot = NULL,
        lease_until = NULL,
        worker_instance_id = NULL,
        retry_count = retry_count + 1
    WHERE user_id = ${userId}
      AND status IN ('CLAIMED', 'RUNNING')
      AND retry_count < 2
      AND (
        lease_until < NOW()
        OR (lease_until IS NULL AND claimed_at < NOW() - INTERVAL '30 minutes')
      )
    RETURNING id, task_id, product_id, kind::text AS kind, sprint_run_id, branch, retry_count
  `

  if (failedRows.length === 0 && requeuedRows.length === 0) return

  // PBI-9: release any product-worktree locks held by these stale jobs.
  for (const j of failedRows) await releaseLocksOnTerminal(j.id)
  for (const j of requeuedRows) await releaseLocksOnTerminal(j.id)

  // PBI-50: voor stale FAILED SPRINT_IMPLEMENTATION jobs — push de branch
  // zodat het werk niet verloren gaat (geen mark-ready / PR-promotie),
  // en zet SprintRun.failure_reason met een verwijzing naar de laatst
  // RUNNING execution voor diagnose.
  for (const j of failedRows.filter((r) => r.kind === 'SPRINT_IMPLEMENTATION')) {
    if (j.branch && j.product_id) {
      const repoRoot = await resolveRepoRoot(j.product_id).catch(() => null)
      if (repoRoot) {
        const worktreeDir = getWorktreeRoot()
        const worktreePath = path.join(worktreeDir, j.id)
        try {
          await pushBranchForJob({ worktreePath, branchName: j.branch })
        } catch (err) {
          console.warn(`[stale-reset] push failed for stale sprint-job ${j.id}:`, err)
        }
      }
    }
    if (j.sprint_run_id) {
      const lastRunning = await prisma.sprintTaskExecution.findFirst({
        where: { sprint_job_id: j.id, status: 'RUNNING' },
        orderBy: { order: 'desc' },
        select: { order: true, task_id: true },
      })
      const reasonSuffix = lastRunning
        ? `, last execution: order ${lastRunning.order} task ${lastRunning.task_id}`
        : ''
      await prisma.sprintRun.update({
        where: { id: j.sprint_run_id },
        data: {
          status: 'FAILED',
          failure_reason: `stale: lease verlopen${reasonSuffix}`,
        },
      })
    }
  }

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
  instanceId: string,
  productId?: string,
): Promise<string | null> {
  // Atomic claim in a single transaction — also captures plan_snapshot from task.
  //
  // PBI-50: claim-filter discrimineert via cj.kind:
  //   - IDEA_GRILL/IDEA_MAKE_PLAN/PLAN_CHAT: standalone idea-jobs.
  //   - TASK_IMPLEMENTATION/SPRINT_IMPLEMENTATION: alleen via actieve SprintRun
  //     (status QUEUED of RUNNING). Legacy task-jobs zonder sprint_run_id en
  //     jobs in PAUSED/FAILED/CANCELLED/DONE SprintRuns worden overgeslagen.
  //   Bij eerste claim van een nog QUEUED SprintRun → status RUNNING.
  //
  // PBI-50 lease: lease_until = NOW() + 5min op claim. resetStaleClaimedJobs
  // reset bij verlopen lease.
  const rows = await prisma.$transaction(async (tx) => {
    const found = productId
      ? await tx.$queryRaw<
          Array<{ id: string; implementation_plan: string | null; sprint_run_id: string | null }>
        >`
          SELECT cj.id, t.implementation_plan, cj.sprint_run_id
          FROM claude_jobs cj
          LEFT JOIN tasks t ON t.id = cj.task_id
          LEFT JOIN sprint_runs sr ON sr.id = cj.sprint_run_id
          WHERE cj.user_id = ${userId}
            AND cj.product_id = ${productId}
            AND cj.status = 'QUEUED'
            AND (
              cj.kind IN ('IDEA_GRILL', 'IDEA_MAKE_PLAN', 'PLAN_CHAT')
              OR (cj.kind IN ('TASK_IMPLEMENTATION', 'SPRINT_IMPLEMENTATION')
                  AND cj.sprint_run_id IS NOT NULL
                  AND sr.status IN ('QUEUED', 'RUNNING'))
            )
          ORDER BY cj.created_at ASC
          LIMIT 1
          FOR UPDATE OF cj SKIP LOCKED
        `
      : await tx.$queryRaw<
          Array<{ id: string; implementation_plan: string | null; sprint_run_id: string | null }>
        >`
          SELECT cj.id, t.implementation_plan, cj.sprint_run_id
          FROM claude_jobs cj
          LEFT JOIN tasks t ON t.id = cj.task_id
          LEFT JOIN sprint_runs sr ON sr.id = cj.sprint_run_id
          WHERE cj.user_id = ${userId}
            AND cj.status = 'QUEUED'
            AND (
              cj.kind IN ('IDEA_GRILL', 'IDEA_MAKE_PLAN', 'PLAN_CHAT')
              OR (cj.kind IN ('TASK_IMPLEMENTATION', 'SPRINT_IMPLEMENTATION')
                  AND cj.sprint_run_id IS NOT NULL
                  AND sr.status IN ('QUEUED', 'RUNNING'))
            )
          ORDER BY cj.created_at ASC
          LIMIT 1
          FOR UPDATE OF cj SKIP LOCKED
        `

    if (found.length === 0) return []

    const jobId = found[0].id
    const snapshot = found[0].implementation_plan ?? ''
    const sprintRunId = found[0].sprint_run_id
    await tx.$executeRaw`
      UPDATE claude_jobs
      SET status = 'CLAIMED',
          claimed_by_token_id = ${tokenId},
          claimed_at = NOW(),
          plan_snapshot = ${snapshot},
          worker_instance_id = ${instanceId},
          lease_until = NOW() + INTERVAL '5 minutes'
      WHERE id = ${jobId}
    `

    // SprintRun QUEUED → RUNNING bij eerste claim, in dezelfde tx zodat
    // concurrent claims dezelfde overgang niet dubbel doen (UPDATE skipt
    // rows die al RUNNING zijn).
    if (sprintRunId) {
      await tx.$executeRaw`
        UPDATE sprint_runs
        SET status = 'RUNNING',
            started_at = COALESCE(started_at, NOW()),
            updated_at = NOW()
        WHERE id = ${sprintRunId} AND status = 'QUEUED'
      `
    }
    return [{ id: jobId }]
  })

  return rows.length > 0 ? rows[0].id : null
}

export async function getFullJobContext(jobId: string) {
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
      idea: {
        include: {
          pbi: { select: { id: true, code: true, title: true } },
          secondary_products: {
            include: { product: { select: { id: true, repo_url: true } } },
          },
          // PBI-102: prefer ProductDoc.current_revision.content_md boven
          // de legacy Idea.{grill,plan}_md kolommen. Fallback in de
          // payload-bouw zorgt dat legacy-ideas blijven werken tot de
          // backfill (scripts/migrate-idea-md-to-product-docs.ts) is
          // gedraaid in productie.
          plan_doc: {
            select: { current_revision: { select: { content_md: true } } },
          },
          grill_doc: {
            select: { current_revision: { select: { content_md: true } } },
          },
        },
      },
      product: {
        select: {
          id: true,
          name: true,
          repo_url: true,
          definition_of_done: true,
          preferred_model: true,
          thinking_budget_default: true,
          preferred_permission_mode: true,
        },
      },
    },
  })
  if (!job) return null

  // PBI-67: model + mode-selectie. Resolved op claim-moment; override-cascade
  // task.requires_opus → job.requested_* → product.preferred_* → kind-default.
  const config = resolveJobConfig(
    {
      kind: job.kind,
      requested_model: job.requested_model,
      requested_thinking_budget: job.requested_thinking_budget,
      requested_permission_mode: job.requested_permission_mode,
    },
    {
      preferred_model: job.product.preferred_model,
      thinking_budget_default: job.product.thinking_budget_default,
      preferred_permission_mode: job.product.preferred_permission_mode,
    },
    job.task ? { requires_opus: job.task.requires_opus } : undefined,
  )

  // M12: branch on kind. Idea-jobs hebben geen task/story/pbi/sprint; ze
  // hebben in plaats daarvan idea + embedded prompt_text.
  if (job.kind === 'IDEA_GRILL' || job.kind === 'IDEA_MAKE_PLAN' || job.kind === 'IDEA_REVIEW_PLAN') {
    if (!job.idea) return null
    const { idea } = job
    const { getIdeaPromptText } = await import('../lib/kind-prompts.js')

    // Setup persistent product-worktrees for this idea-job (PBI-9).
    // Primary product is gated by repo_url via resolveRepoRoot returning null.
    // Secondary products from IdeaProduct[] need explicit repo_url filter.
    const involvedProductIds: string[] = []
    if (idea.product_id) involvedProductIds.push(idea.product_id)
    for (const ip of idea.secondary_products ?? []) {
      if (ip.product?.repo_url && !involvedProductIds.includes(ip.product_id)) {
        involvedProductIds.push(ip.product_id)
      }
    }
    // PBI-49 P1: rollback the claim if worktree setup fails so the job
    // doesn't hang in CLAIMED until the 30-min stale-reset, and any partial
    // locks are released. Mirrors attachWorktreeToJob's task-pad behaviour.
    let worktrees: Array<{ productId: string; worktreePath: string }> = []
    if (involvedProductIds.length > 0) {
      try {
        worktrees = await setupProductWorktrees(
          job.id,
          involvedProductIds,
          (pid) => resolveRepoRoot(pid),
        )
      } catch (err) {
        console.warn(
          `[wait-for-job] product-worktree setup failed for idea-job ${job.id}; rolling back claim:`,
          err,
        )
        await releaseLocksOnTerminal(job.id)
        await rollbackClaim(job.id)
        return null
      }
    }

    return {
      job_id: job.id,
      kind: job.kind,
      status: 'claimed',
      config,
      idea: {
        id: idea.id,
        code: idea.code,
        title: idea.title,
        description: idea.description,
        // PBI-102: revision-content wint; fallback naar legacy strings
        grill_md: idea.grill_doc?.current_revision?.content_md ?? idea.grill_md,
        plan_md: idea.plan_doc?.current_revision?.content_md ?? idea.plan_md,
        status: idea.status,
        product_id: idea.product_id,
      },
      product: {
        id: job.product.id,
        name: job.product.name,
        repo_url: job.product.repo_url,
        definition_of_done: job.product.definition_of_done,
      },
      pbi: idea.pbi,
      repo_url: job.product.repo_url,
      prompt_text: getIdeaPromptText(job.kind),
      branch_suggestion: `feat/idea-${idea.code.toLowerCase()}-${(() => {
        if (job.kind === 'IDEA_GRILL') return 'grill'
        if (job.kind === 'IDEA_REVIEW_PLAN') return 'review'
        return 'plan'
      })()}`,
      product_worktrees: worktrees.map((w) => ({
        product_id: w.productId,
        worktree_path: w.worktreePath,
      })),
      primary_worktree_path: worktrees[0]?.worktreePath ?? null,
    }
  }

  // PBI-50: SPRINT_IMPLEMENTATION — single-session sprint runner.
  // Eén ClaudeJob per SprintRun handelt sequentieel alle TO_DO-tasks af.
  // Bij claim: maak frozen scope-snapshot via SprintTaskExecution-rows,
  // resolve worktree (verse branch of hergebruikt via previous_run_id),
  // capture base_sha. Worker werkt uitsluitend op deze frozen snapshot.
  if (job.kind === 'SPRINT_IMPLEMENTATION') {
    if (!job.sprint_run_id) {
      await rollbackClaim(job.id)
      return null
    }
    const sprintRun = await prisma.sprintRun.findUnique({
      where: { id: job.sprint_run_id },
      include: {
        sprint: {
          include: {
            product: true,
            stories: {
              where: { status: { not: 'DONE' } },
              include: {
                pbi: {
                  select: { id: true, code: true, title: true, priority: true, sort_order: true, status: true },
                },
                tasks: {
                  where: { status: 'TO_DO' },
                  orderBy: [{ priority: 'asc' }, { sort_order: 'asc' }],
                },
              },
              orderBy: [{ priority: 'asc' }, { sort_order: 'asc' }],
            },
          },
        },
      },
    })
    if (!sprintRun) {
      await rollbackClaim(job.id)
      return null
    }

    const repoRoot = await resolveRepoRoot(sprintRun.sprint.product_id)
    if (!repoRoot) {
      await rollbackClaim(job.id)
      return null
    }

    // Branch resolution: previous_run_id + branch → reuse; anders verse.
    const isResume = !!(sprintRun.previous_run_id && sprintRun.branch)
    const branchName = isResume
      ? sprintRun.branch!
      : `feat/sprint-${job.sprint_run_id.slice(-8)}`

    let worktreePath: string
    let baseSha: string
    try {
      const wt = await createWorktreeForJob({
        repoRoot,
        jobId: job.id,
        branchName,
        reuseBranch: isResume,
      })
      worktreePath = wt.worktreePath

      const { stdout: headSha } = await execFileP('git', ['rev-parse', 'HEAD'], {
        cwd: worktreePath,
      })
      baseSha = headSha.trim()
    } catch (err) {
      console.warn(`[wait-for-job] sprint-worktree setup failed for ${job.id}:`, err)
      await rollbackClaim(job.id)
      return null
    }

    // Verzamel ordered tasks in flat list, behoud volgorde
    const orderedTasks = sprintRun.sprint.stories.flatMap((s) =>
      s.tasks.map((t) => ({ ...t, story_pbi_id: s.pbi.id })),
    )

    // Persist branch + base_sha + scope-snapshot in één transactie
    await prisma.$transaction([
      prisma.claudeJob.update({
        where: { id: job.id },
        data: { branch: branchName, base_sha: baseSha },
      }),
      prisma.sprintTaskExecution.createMany({
        data: orderedTasks.map((t, idx) => ({
          sprint_job_id: job.id,
          task_id: t.id,
          order: idx,
          plan_snapshot: t.implementation_plan ?? '',
          verify_required_snapshot: t.verify_required,
          verify_only_snapshot: t.verify_only,
          base_sha: idx === 0 ? baseSha : null,
          status: 'PENDING' as const,
        })),
      }),
      prisma.sprintRun.update({
        where: { id: job.sprint_run_id },
        data: { branch: branchName },
      }),
    ])

    // Lookup execution_ids in volgorde voor de response
    const executions = await prisma.sprintTaskExecution.findMany({
      where: { sprint_job_id: job.id },
      orderBy: { order: 'asc' },
      select: { id: true, task_id: true, order: true, base_sha: true },
    })
    const execIdByTaskId = new Map(executions.map((e) => [e.task_id, e.id]))

    // Dedupe PBIs uit de stories (één PBI kan meerdere stories hebben)
    const pbiMap = new Map<string, typeof sprintRun.sprint.stories[number]['pbi']>()
    for (const s of sprintRun.sprint.stories) pbiMap.set(s.pbi.id, s.pbi)

    return {
      job_id: job.id,
      kind: job.kind,
      status: 'claimed',
      config,
      sprint: {
        id: sprintRun.sprint.id,
        sprint_goal: sprintRun.sprint.sprint_goal,
        status: sprintRun.sprint.status,
      },
      sprint_run: {
        id: sprintRun.id,
        pr_strategy: sprintRun.pr_strategy,
        branch: branchName,
        previous_run_id: sprintRun.previous_run_id,
      },
      product: {
        id: sprintRun.sprint.product.id,
        name: sprintRun.sprint.product.name,
        repo_url: sprintRun.sprint.product.repo_url,
        definition_of_done: sprintRun.sprint.product.definition_of_done,
        auto_pr: sprintRun.sprint.product.auto_pr,
      },
      pbis: Array.from(pbiMap.values()).map((p) => ({
        id: p.id,
        code: p.code,
        title: p.title,
        priority: p.priority,
        sort_order: p.sort_order,
        status: p.status,
      })),
      stories: sprintRun.sprint.stories.map((s) => ({
        id: s.id,
        code: s.code,
        title: s.title,
        pbi_id: s.pbi_id,
        priority: s.priority,
        sort_order: s.sort_order,
        status: s.status,
      })),
      task_executions: orderedTasks.map((t, idx) => ({
        execution_id: execIdByTaskId.get(t.id)!,
        task_id: t.id,
        code: t.code,
        title: t.title,
        story_id: t.story_id,
        order: idx,
        plan_snapshot: t.implementation_plan ?? '',
        verify_required: t.verify_required,
        verify_only: t.verify_only,
        base_sha: idx === 0 ? baseSha : null,
      })),
      worktree_path: worktreePath,
      branch_name: branchName,
      repo_url: sprintRun.sprint.product.repo_url,
      base_sha: baseSha,
      heartbeat_interval_seconds: 60,
    }
  }

  // TASK_IMPLEMENTATION (default) — bestaande gedrag onaangetast.
  const { task } = job
  if (!task) return null
  const { story } = task
  const { pbi, sprint } = story

  return {
    job_id: job.id,
    kind: job.kind,
    status: 'claimed',
    config,
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      implementation_plan: task.implementation_plan,
      priority: task.priority,
      repo_url: task.repo_url,
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
        const instanceId = getInstanceId()

        // 1. Reset stale claimed jobs
        await resetStaleClaimedJobs(userId)

        // 2. Try immediate claim
        let jobId = await tryClaimJob(userId, tokenId, instanceId, product_id)
        if (jobId) {
          const ctx = await getFullJobContext(jobId)
          if (!ctx) return toolError('Job claimed but context fetch failed')
          // M12: idee-jobs hebben geen worktree nodig — de agent werkt in de
          // bestaande user-repo (geen branch/commit-flow). Alleen task-jobs
          // krijgen een worktree.
          if (ctx.kind === 'TASK_IMPLEMENTATION') {
            if (!ctx.story || !ctx.task) {
              return toolError('Task-job claimed but story/task context is incomplete')
            }
            const wt = await attachWorktreeToJob(
              ctx.product.id,
              jobId,
              ctx.story.id,
              ctx.task.repo_url,
            )
            if ('error' in wt) return toolError(wt.error)
            return toolJson({ ...ctx, worktree_path: wt.worktree_path, branch_name: wt.branch_name })
          }
          return toolJson(ctx)
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
            jobId = await tryClaimJob(userId, tokenId, instanceId, product_id)
            if (jobId) {
              const ctx = await getFullJobContext(jobId)
              if (!ctx) return toolError('Job claimed but context fetch failed')
              if (ctx.kind === 'TASK_IMPLEMENTATION') {
                if (!ctx.story || !ctx.task) {
                  return toolError('Task-job claimed but story/task context is incomplete')
                }
                const wt = await attachWorktreeToJob(
                  ctx.product.id,
                  jobId,
                  ctx.story.id,
                  ctx.task.repo_url,
                )
                if ('error' in wt) return toolError(wt.error)
                return toolJson({ ...ctx, worktree_path: wt.worktree_path, branch_name: wt.branch_name })
              }
              return toolJson(ctx)
            }
          }
        } finally {
          await listenClient.end().catch(() => {})
        }

        return toolJson({ status: 'timeout', message: 'No job available within wait window' })
      }),
  )
}
