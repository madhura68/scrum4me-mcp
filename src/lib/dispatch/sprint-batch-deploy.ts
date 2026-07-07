// M21 (spec §2): sprint-batch auto-deploy — eigen module zodat update-job-status
// de helper kan importeren én mocken.
import { prisma } from '../../prisma.js'
import { checkDeployEligibility, maybeEnqueueDeployJob } from './deploy-job.js'
import { executeEffects } from '../../flow/effects.js'
import { getPullRequestState } from '../../git/pr.js'
import { triggerPush } from '../push-trigger.js'

// Genormaliseerde repo-bucket-key. null/undefined/lege/whitespace-only repo_url
// EN de expliciete product-repo-url (met of zonder .git-suffix) = het
// product-repo (de "product"-bucket, gerepresenteerd als null); een andere url
// = een eigen bucket. Gedeeld door maybeCreateAutoPr en de sprint-batch-helper.
export function repoBucketKey(
  repoUrl: string | null | undefined,
  productRepoUrl: string | null | undefined,
): string | null {
  const norm = (u: string | null | undefined): string | null => {
    if (u == null || u.trim() === '') return null
    return u.trim().replace(/\.git$/, '')
  }
  const r = norm(repoUrl)
  if (r === null) return null
  if (r === norm(productRepoUrl)) return null
  return r
}

// M21 (spec §2): sprint-batch auto-deploy. Level-triggered, repo-bucket-
// gefilterd, head-sha zelf-resolvend, preflight → ENABLE_AUTO_MERGE → enqueue.
// Aangeroepen vanuit beide sprint-finalisatiepaden ná markPullRequestReady.
export async function maybeAutoDeploySprintBatchPr(opts: {
  jobId: string
  userId: string
  productId: string
  sprintRunId: string
}): Promise<void> {
  // 1. Level-check: SprintRun echt DONE (niet de sprintRunBecameDone-edge).
  const run = await prisma.sprintRun.findUnique({
    where: { id: opts.sprintRunId },
    select: { status: true },
  })
  if (run?.status !== 'DONE') return

  // 2. Resolve de product-repo-batch-PR (repo-bucket-gefilterd). productRepoUrl
  //    bepaalt welke sibling de product-bucket is (repoBucketKey === null).
  const product = await prisma.product.findUnique({
    where: { id: opts.productId },
    select: { repo_url: true },
  })
  const prJobs = await prisma.claudeJob.findMany({
    where: { sprint_run_id: opts.sprintRunId, pr_url: { not: null } },
    orderBy: { created_at: 'asc' },
    select: { pr_url: true, head_sha: true, task: { select: { repo_url: true } } },
  })
  const productPrJob = prJobs.find(
    (j) => repoBucketKey(j.task?.repo_url, product?.repo_url) === null,
  )
  const prUrl = productPrJob?.pr_url ?? null
  if (!prUrl) {
    console.warn(`[sprint-batch-deploy] geen product-repo-batch-PR voor sprint ${opts.sprintRunId}`)
    return
  }

  // 3. Head-sha zelf resolven: de head_sha van de GEKOZEN product-PR-job; als
  //    die null is → de echte PR-head via Forgejo. NOOIT een sha van een andere
  //    (cross-repo) job.
  let headSha = productPrJob?.head_sha ?? null
  if (!headSha) {
    const info = await getPullRequestState({ prUrl })
    headSha = 'headSha' in info ? info.headSha : null
  }
  if (!headSha) {
    console.warn(`[sprint-batch-deploy] geen betrouwbare head-sha voor ${prUrl}`)
    return
  }

  // 4a. Preflight-eligibility onder de product-lock.
  const eligibility = await checkDeployEligibility(opts.productId)
  if (eligibility === 'not_configured') return // opt-in-gate; PR blijft ready
  if (eligibility === 'blocked') {
    console.warn(`[sprint-batch-deploy] geblokkeerd (onopgeloste FAILED) product ${opts.productId}`)
    void triggerPush(opts.userId, {
      title: 'Sprint-batch-deploy geblokkeerd',
      body: 'Een onopgeloste FAILED deploy blokkeert; los die eerst op.',
      url: '/jobs',
      tag: `sprint-batch-deploy-blocked-${opts.sprintRunId}`,
    })
    return
  }

  // 4c. eligible → ENABLE_AUTO_MERGE-effect direct (spec §3).
  const outcomes = await executeEffects([
    { type: 'ENABLE_AUTO_MERGE', prUrl, expectedHeadSha: headSha },
  ])
  const enableOk = outcomes.some((o) => o.effect === 'ENABLE_AUTO_MERGE' && o.ok)
  if (!enableOk) {
    const failed = outcomes.find((o) => o.effect === 'ENABLE_AUTO_MERGE' && !o.ok)
    const reason = failed && 'reason' in failed ? failed.reason : 'unknown'
    console.warn(`[sprint-batch-deploy] auto-merge enable faalde voor ${prUrl}: ${reason}`)
    void triggerPush(opts.userId, {
      title: 'Sprint-batch auto-merge mislukt',
      body: 'Merge de sprint-PR handmatig en re-trigger de deploy.',
      url: '/jobs',
      tag: `sprint-batch-automerge-fail-${opts.sprintRunId}`,
    })
    return // 4e: geen enqueue ⇒ geen DEPLOY-job ⇒ geen squat/blokkade
  }

  // 4d. enable ok → enqueue.
  const outcome = await maybeEnqueueDeployJob({
    parentJobId: opts.jobId,
    userId: opts.userId,
    productId: opts.productId,
    prUrl,
    headSha,
  }).catch((err) => {
    console.error('[sprint-batch-deploy-enqueue]', err)
    void triggerPush(opts.userId, {
      title: 'Sprint-batch deploy-enqueue mislukt',
      body: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      url: '/jobs',
      tag: `sprint-batch-deploy-enqueue-${opts.sprintRunId}`,
    })
    return 'error' as const
  })

  // Tweede-check-observability: de her-check in maybeEnqueueDeployJob kan door de
  // ms-race alsnog not_configured/blocked geven ná een geslaagde enable.
  if (outcome === 'not_configured' || outcome === 'blocked') {
    console.warn(`[sprint-batch-deploy] auto-merge aan maar enqueue ${outcome} voor ${prUrl}`)
    void triggerPush(opts.userId, {
      title: 'Sprint-batch: auto-merge aan, geen deploy',
      body: `Deploy-enqueue niet uitgevoerd (${outcome}) door gewijzigde eligibility.`,
      url: '/jobs',
      tag: `sprint-batch-deploy-race-${opts.sprintRunId}`,
    })
  }
}
