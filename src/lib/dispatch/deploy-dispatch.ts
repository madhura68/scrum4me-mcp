// M17: handmatige DEPLOY via MCP dispatch_job = "deploy huidige main".
// Zelfde guards als de web-action deployNowAction: deploy_flow verplicht
// (gelezen BINNEN de locked tx, codex plan-r1 #5), active-job-guard,
// product-lock (spec §6). ACTIVE_JOB_STATUSES: gedeeld uit idea-jobs.ts
// i.p.v. inline dupliceren (DRY, kwaliteitsreview-afspraak).
// Bewust géén requested_*-snapshot (fase 5, PR #91: minimale enqueue-rijen;
// config resolvet DB-leading op claim-tijd) — zelfde lijn als de web-action.
import { prisma } from '../../prisma.js'
import { DispatchError } from './errors.js'
import { notifyJobEnqueued } from './notify.js'
import { ACTIVE_JOB_STATUSES } from './idea-jobs.js'

// Bewuste divergentie t.o.v. maybeEnqueueDeployJob (./deploy-job.ts, het
// auto-enqueue-pad): dit is een directe RPC-stijl dispatch → DispatchError
// i.p.v. outcome-union, en GEEN orchestration_key/dedup — er is geen
// pr_url/head_sha om op te dedupen; de active-job-guard + sha-guard dekken
// handmatige dubbelen. Niet gelijktrekken.
export async function dispatchDeploy(opts: { productId: string; userId: string }): Promise<{ job_id: string }> {
  const job = await prisma.$transaction(async (tx) => {
    // Lock éérst, dan pas de config-beslissing lezen (codex plan-r1 #5):
    // deploy_flow/active-job-guard binnen dezelfde tx als de create.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('deploy'), hashtext(${opts.productId}))`
    const product = await tx.product.findUnique({
      where: { id: opts.productId },
      select: { deploy_flow: true },
    })
    if (!product?.deploy_flow) throw new DispatchError('Product heeft geen deploy_flow geconfigureerd.')
    const active = await tx.claudeJob.findFirst({
      where: { product_id: opts.productId, kind: 'DEPLOY', status: { in: [...ACTIVE_JOB_STATUSES] } },
      select: { id: true },
    })
    if (active) throw new DispatchError(`Er loopt al een deploy voor dit product (${active.id}).`)
    return tx.claudeJob.create({
      data: {
        user_id: opts.userId,
        product_id: opts.productId,
        kind: 'DEPLOY',
        status: 'QUEUED',
        runtime: 'CLAUDE',
        source: 'MANUAL',
        required_capability: 'deploy',
        // Bewust géén orchestration_key: de sha-guard (spec §3) dekt
        // handmatige dubbelen in de job zelf.
      },
      select: { id: true },
    })
  })
  await notifyJobEnqueued({ job_id: job.id, user_id: opts.userId, product_id: opts.productId, kind: 'DEPLOY' })
  return { job_id: job.id }
}
