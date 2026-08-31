// PBI fail-cascade — wanneer een TASK_IMPLEMENTATION-job FAILED wordt,
// cancellen we alle queued/claimed/running siblings binnen dezelfde PBI
// en draaien we eerder gepushte commits ongedaan via PR-close of een
// auto-revert-PR. Idempotent en non-blocking: elke fout wordt gelogd in
// het error-veld van de oorspronkelijke failed-job en stopt de cascade niet.

import { prisma } from '../prisma.js'
import { resolveRepoRoot } from '../tools/wait-for-job.js'
import { removeWorktreeForJob } from '../git/worktree.js'
import {
  closePullRequest,
  createRevertPullRequest,
  getPullRequestState,
} from '../git/pr.js'
import { deleteRemoteBranch } from '../git/push.js'
import { remoteTipMergedIntoMain } from '../git/branch-safety.js'
import { releaseLocksOnTerminal } from '../git/job-locks.js'

export type CascadeOutcome = {
  cancelled_job_ids: string[]
  closed_prs: string[]
  reverted_prs: { original: string; revertPr: string }[]
  deleted_branches: string[]
  warnings: string[]
}

const EMPTY: CascadeOutcome = {
  cancelled_job_ids: [],
  closed_prs: [],
  reverted_prs: [],
  deleted_branches: [],
  warnings: [],
}

// Public entry. Always returns; never throws.
export async function cancelPbiOnFailure(failedJobId: string): Promise<CascadeOutcome> {
  try {
    return await runCascade(failedJobId)
  } catch (err) {
    console.warn(`[pbi-cascade] unexpected error for failedJob=${failedJobId}:`, err)
    return { ...EMPTY, warnings: [`unexpected: ${(err as Error).message}`] }
  }
}

async function runCascade(failedJobId: string): Promise<CascadeOutcome> {
  const failedJob = await prisma.claudeJob.findUnique({
    where: { id: failedJobId },
    select: {
      id: true,
      kind: true,
      status: true,
      product_id: true,
      task_id: true,
      branch: true,
      pr_url: true,
      task: {
        select: {
          repo_url: true,
          story: {
            select: {
              pbi: { select: { id: true, code: true } },
            },
          },
        },
      },
    },
  })

  if (!failedJob) return EMPTY
  if (failedJob.kind !== 'TASK_IMPLEMENTATION') return EMPTY
  // SKIPPED is een no-op exit (zie update_job_status). Geen cascade naar siblings.
  if (failedJob.status === 'SKIPPED') return EMPTY
  const pbi = failedJob.task?.story?.pbi
  if (!pbi) return EMPTY

  // 1. Atomic cascade: select + updateMany. Race-window between SELECT
  //    and UPDATE is harmless because the cascade is idempotent — a second
  //    invocation simply finds zero rows.
  const eligible = await prisma.claudeJob.findMany({
    where: {
      id: { not: failedJobId },
      status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] },
      task: { story: { pbi_id: pbi.id } },
    },
    select: {
      id: true,
      branch: true,
      pr_url: true,
      status: true,
      task_id: true,
      task: { select: { repo_url: true } },
    },
  })

  if (eligible.length > 0) {
    await prisma.claudeJob.updateMany({
      where: { id: { in: eligible.map((j) => j.id) } },
      data: {
        status: 'CANCELLED',
        finished_at: new Date(),
        error: 'cancelled_by_pbi_failure',
      },
    })
    // PBI-9: release product-worktree locks for cancelled jobs.
    // No-op for jobs without registered locks (TASK_IMPLEMENTATION).
    for (const j of eligible) await releaseLocksOnTerminal(j.id)
  }

  const outcome: CascadeOutcome = {
    cancelled_job_ids: eligible.map((j) => j.id),
    closed_prs: [],
    reverted_prs: [],
    deleted_branches: [],
    warnings: [],
  }

  // 2. Group affected jobs (cascade-set ∪ failed) by (repo, branch) to avoid
  //    closing the same PR twice for siblings sharing a story-branch.
  //    Spec §3.3 "Repo-resolutie per job, overal": branches zijn per repo, dus
  //    dezelfde branchnaam in twee repo's is niet dezelfde branch.
  type Bucket = { repoUrl: string | null; branch: string; prUrl: string | null }
  const buckets = new Map<string, Bucket>()
  const all = [
    ...eligible.map((j) => ({
      branch: j.branch,
      pr_url: j.pr_url,
      repo_url: j.task?.repo_url ?? null,
    })),
    {
      branch: failedJob.branch,
      pr_url: failedJob.pr_url,
      repo_url: failedJob.task?.repo_url ?? null,
    },
  ]
  for (const j of all) {
    if (!j.branch) continue
    const key = JSON.stringify([j.repo_url ?? null, j.branch])
    const existing = buckets.get(key)
    // Prefer a non-null pr_url if any sibling has one.
    if (!existing) {
      buckets.set(key, { repoUrl: j.repo_url ?? null, branch: j.branch, prUrl: j.pr_url ?? null })
    } else if (!existing.prUrl && j.pr_url) {
      existing.prUrl = j.pr_url
    }
  }

  const repoRootCache = new Map<string, string | null>()
  const rootFor = async (repoUrl: string | null): Promise<string | null> => {
    const key = repoUrl ?? ''
    if (!repoRootCache.has(key)) {
      repoRootCache.set(key, await resolveRepoRoot(failedJob.product_id, repoUrl))
    }
    return repoRootCache.get(key)!
  }
  const cascadeComment = `PBI ${pbi.code ?? pbi.id} cascaded fail — see job ${failedJobId}`

  for (const { repoUrl, branch, prUrl } of buckets.values()) {
    const repoRoot = await rootFor(repoUrl)
    if (prUrl) {
      const info = await getPullRequestState({ prUrl, cwd: repoRoot ?? undefined })
      if ('error' in info) {
        outcome.warnings.push(`PR state fetch ${prUrl}: ${info.error}`)
        continue
      }
      if (info.state === 'CLOSED') {
        // Already closed; nothing to do for the PR. Branch may still exist.
        if (repoRoot) await tryDeleteBranch(repoRoot, branch, outcome, info.headSha)
        continue
      }
      if (info.state === 'OPEN') {
        const closed = await closePullRequest({
          prUrl,
          comment: cascadeComment,
          cwd: repoRoot ?? undefined,
        })
        if ('error' in closed) {
          outcome.warnings.push(`close ${prUrl}: ${closed.error}`)
        } else {
          outcome.closed_prs.push(prUrl)
          // Forgejo REST-close (anders dan `gh pr close --delete-branch`) raakt
          // de branch niet aan — caller doet de remote delete expliciet, met
          // head-SHA guard zodat we geen latere worker-push wegvegen.
          if (repoRoot) await tryDeleteBranch(repoRoot, branch, outcome, info.headSha)
        }
        continue
      }
      if (info.state === 'MERGED') {
        if (!repoRoot) {
          outcome.warnings.push(
            `merged PR ${prUrl} not reverted: no repo root configured for product ${failedJob.product_id}`,
          )
          continue
        }
        if (!info.mergeCommit) {
          outcome.warnings.push(`merged PR ${prUrl} has no mergeCommit — skipping revert`)
          continue
        }
        const revert = await createRevertPullRequest({
          repoRoot,
          mergeSha: info.mergeCommit,
          baseRef: info.baseRefName,
          originalTitle: info.title,
          originalBranch: branch,
          jobId: failedJobId,
          pbiCode: pbi.code,
        })
        if ('error' in revert) {
          outcome.warnings.push(`revert ${prUrl}: ${revert.error}`)
        } else {
          outcome.reverted_prs.push({ original: prUrl, revertPr: revert.url })
        }
        continue
      }
    } else {
      // Branch without PR: best-effort delete on remote.
      if (repoRoot) await tryDeleteBranch(repoRoot, branch, outcome)
    }
  }

  // 3. Worktree cleanup for every cancelled job (and the failed job itself
  //    is handled elsewhere by cleanupWorktreeForTerminalStatus). For
  //    cancelled jobs we always discard the branch locally — they did not
  //    succeed.
  //    Per job de eigen repo resolven (spec §3.3); de laag-3-regel in
  //    removeWorktreeForJob (M38 T2) bewaart daar automatisch een branch
  //    waarvan origin de tip mist. Bewust géén push voor gecancelde siblings.
  for (const j of eligible) {
    const jobRoot = await rootFor(j.task?.repo_url ?? null)
    if (!jobRoot) continue
    try {
      await removeWorktreeForJob({ repoRoot: jobRoot, jobId: j.id, keepBranch: false })
    } catch (err) {
      outcome.warnings.push(`worktree cleanup for ${j.id}: ${(err as Error).message}`)
    }
  }

  // 4. Persist a trace on the failed-job's error field so the operator can
  //    follow up. Use a structured one-liner to keep the column readable.
  //    Append to the existing error (separated by '\n---\n') so the original
  //    failure reason is preserved instead of being overwritten by the trace.
  const trace = formatTrace(outcome)
  if (trace) {
    try {
      const fresh = await prisma.claudeJob.findUnique({
        where: { id: failedJobId },
        select: { error: true },
      })
      const merged = fresh?.error
        ? `${fresh.error}\n---\n${trace}`.slice(0, 1900)
        : trace.slice(0, 1900)
      await prisma.claudeJob.update({
        where: { id: failedJobId },
        data: { error: merged },
      })
    } catch (err) {
      console.warn(`[pbi-cascade] failed to persist trace for ${failedJobId}:`, err)
    }
  }

  return outcome
}

async function tryDeleteBranch(
  repoRoot: string,
  branch: string,
  outcome: CascadeOutcome,
  expectedHeadSha?: string | null,
): Promise<void> {
  // Spec §3.3 remote kant: alleen deleten wanneer de remote tip in
  // origin/main zit — niet-gemergd werk blijft als backup staan.
  if (!(await remoteTipMergedIntoMain(repoRoot, branch))) {
    outcome.warnings.push(
      `branch ${branch} niet verwijderd: tip niet in origin/main (backup bewaard)`,
    )
    return
  }
  const result = await deleteRemoteBranch({
    repoRoot,
    branch,
    expectedHeadSha: expectedHeadSha ?? undefined,
  })
  if (result.deleted) {
    outcome.deleted_branches.push(branch)
    return
  }
  if (result.reason === 'not-found') {
    // Already gone — silent no-op.
    return
  }
  outcome.warnings.push(
    `delete-branch ${branch} (${result.reason}): ${result.stderr.slice(0, 120)}`,
  )
}

function formatTrace(o: CascadeOutcome): string {
  const parts: string[] = ['cancelled_by_self']
  if (o.cancelled_job_ids.length) parts.push(`siblings_cancelled=${o.cancelled_job_ids.length}`)
  if (o.closed_prs.length) parts.push(`closed=${o.closed_prs.join(',')}`)
  if (o.reverted_prs.length) {
    parts.push(`reverted=${o.reverted_prs.map((r) => `${r.original}->${r.revertPr}`).join(';')}`)
  }
  if (o.deleted_branches.length) parts.push(`branches_deleted=${o.deleted_branches.join(',')}`)
  if (o.warnings.length) parts.push(`warnings=${o.warnings.length}`)
  return parts.join('; ')
}
