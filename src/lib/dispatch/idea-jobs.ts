// Port van Scrum4Me actions/ideas.ts startIdeaJob (IDEA-118 K2/K12).
// Triggerbare statussen identiek aan web (actions/ideas.ts:423-425).
import type { IdeaStatus, ClaudeJobKind } from '@prisma/client'
import { prisma } from '../../prisma.js'
import { getJobConfigSnapshot } from './snapshot.js'
import { notifyJobEnqueued } from './notify.js'
import { DispatchError } from './errors.js'
import { REVIEW_JOB_FIELDS } from './review-jobs.js'
import { parseContentPolicy, checkContentPolicy, ContentPolicyError } from '@shared/content-policy.js'
export { DispatchError } from './errors.js'

// Gedeeld met deploy-dispatch.ts (M17 Task 3.6, DRY-afspraak uit
// kwaliteitsreview): één bron van waarheid voor "actief" over alle
// active-job-guards heen.
export const ACTIVE_JOB_STATUSES = ['QUEUED', 'CLAIMED', 'RUNNING'] as const
const WORKER_FRESH_MS = 15_000

type IdeaJobKind = Extract<ClaudeJobKind, 'IDEA_GRILL' | 'IDEA_MAKE_PLAN' | 'IDEA_REVIEW_PLAN' | 'IDEA_MAKE_SPEC'>

const IDEA_KIND_RULES: Record<IdeaJobKind, { newStatus: IdeaStatus; allowedFrom: IdeaStatus[] }> = {
  IDEA_GRILL: {
    newStatus: 'GRILLING',
    allowedFrom: ['DRAFT', 'GRILLED', 'GRILL_FAILED', 'PLAN_READY', 'PLANNED'],
  },
  IDEA_MAKE_PLAN: {
    newStatus: 'PLANNING',
    allowedFrom: ['GRILLED', 'PLAN_FAILED', 'PLAN_READY'],
  },
  IDEA_REVIEW_PLAN: {
    newStatus: 'REVIEWING_PLAN',
    allowedFrom: ['PLAN_READY', 'PLAN_REVIEWED'],
  },
  // M23: copilot/web-startpad van de spec-pipeline. IDEA_REVISE_SPEC is bewust
  // GEEN dispatch-kind — revisies ontstaan alleen als submit_review-side-effect.
  IDEA_MAKE_SPEC: {
    newStatus: 'SPEC_DRAFTING',
    allowedFrom: ['GRILLED', 'SPEC_FAILED'],
  },
}

export async function dispatchIdeaJob(opts: {
  kind: IdeaJobKind
  ideaId: string
  productId: string
  userId: string
}): Promise<{ job_id: string }> {
  const rule = IDEA_KIND_RULES[opts.kind]

  const idea = await prisma.idea.findFirst({
    where: { id: opts.ideaId, user_id: opts.userId },
    select: {
      id: true,
      status: true,
      product_id: true,
      title: true,
      description: true,
      product: { select: { id: true, repo_url: true, content_policy: true } },
    },
  })
  // 404-semantiek: bestaat niet, niet van deze user, of niet van dít product.
  if (!idea || idea.product_id !== opts.productId) {
    throw new DispatchError(`Idea ${opts.ideaId} not found in this product`)
  }
  if (!rule.allowedFrom.includes(idea.status)) {
    throw new DispatchError(
      `${opts.kind} kan niet vanuit status ${idea.status} (toegestaan: ${rule.allowedFrom.join(', ')})`,
    )
  }
  if (!idea.product?.repo_url) {
    throw new DispatchError('Product heeft geen repo_url — koppel eerst een repo.')
  }

  // Dispatch-defense (defense-in-depth): her-check de idee-inhoud tegen de product-
  // policy, voor het geval het idee langs een ongedekt pad ontstond/wijzigde.
  // Fail-closed bij een malformed policy.
  let policy
  try {
    policy = parseContentPolicy(idea.product?.content_policy)
  } catch (err) {
    if (err instanceof ContentPolicyError) {
      throw new DispatchError(`Product content_policy is ongeldig geconfigureerd: ${err.message}`)
    }
    throw err
  }
  const verdict = checkContentPolicy(policy, `${idea.title}\n${idea.description ?? ''}`)
  if (!verdict.allowed) {
    throw new DispatchError(verdict.reason)
  }

  const existing = await prisma.claudeJob.findFirst({
    where: { idea_id: opts.ideaId, status: { in: [...ACTIVE_JOB_STATUSES] } },
    select: { id: true },
  })
  if (existing) {
    throw new DispatchError(`Er loopt al een actieve job voor dit idee (${existing.id}).`)
  }

  const isReviewKind = opts.kind === 'IDEA_REVIEW_PLAN'
  const workers = await prisma.claudeWorker.count({
    where: {
      user_id: opts.userId,
      last_seen_at: { gt: new Date(Date.now() - WORKER_FRESH_MS) },
      ...(isReviewKind ? { runtime: 'CODEX', capabilities: { has: 'review' } } : {}),
    },
  })
  if (workers === 0) {
    throw new DispatchError(
      isReviewKind
        ? 'Geen actieve codex-review-worker — de plan-review zou blijven hangen in QUEUED.'
        : 'Geen actieve worker — de job zou blijven hangen in QUEUED.',
    )
  }

  const snapshot = await getJobConfigSnapshot({ kind: opts.kind, productId: opts.productId })

  const job = await prisma.$transaction(async (tx) => {
    const j = await tx.claudeJob.create({
      data: {
        user_id: opts.userId,
        product_id: opts.productId,
        idea_id: opts.ideaId,
        kind: opts.kind,
        status: 'QUEUED',
        source: 'COPILOT',
        ...snapshot,
        ...(opts.kind === 'IDEA_REVIEW_PLAN' ? REVIEW_JOB_FIELDS : {}),
      },
      select: { id: true },
    })
    await tx.idea.update({ where: { id: opts.ideaId }, data: { status: rule.newStatus } })
    await tx.ideaLog.create({
      data: {
        idea_id: opts.ideaId,
        type: 'JOB_EVENT',
        content: `${opts.kind} queued (copilot)`,
        metadata: { job_id: j.id, kind: opts.kind, source: 'COPILOT' },
      },
    })
    return j
  })

  await notifyJobEnqueued({
    job_id: job.id,
    user_id: opts.userId,
    product_id: opts.productId,
    kind: opts.kind,
    idea_id: opts.ideaId,
  })

  return { job_id: job.id }
}
