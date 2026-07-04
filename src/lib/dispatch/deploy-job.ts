// M17 DEPLOY-job (spec §3): enqueue zodra auto-merge succesvol is aangezet.
// De job zelf doet de merge-wacht. Dedup is DB-hard (partial unique index op
// orchestration_key WHERE kind='DEPLOY'); de blokkade-check en de create
// draaien onder de product-lock (spec §6, acceptatiecriterium).
import { prisma } from '../../prisma.js'
import { notifyJobEnqueued } from './notify.js'

export function buildDeployOrchestrationKey(prUrl: string, headSha: string): string {
  // auto:deploy:<owner>/<repo>#<index>@<head_sha> — sluit aan op review-dispatch.
  const m = prUrl.match(/([^/]+)\/([^/]+)\/pulls?\/(\d+)/)
  const ref = m ? `${m[1]}/${m[2]}#${m[3]}` : prUrl
  return `auto:deploy:${ref}@${headSha}`
}

export type DeployEnqueueOutcome = 'enqueued' | 'dedup' | 'blocked' | 'not_configured'

export async function maybeEnqueueDeployJob(opts: {
  parentJobId: string
  userId: string
  productId: string
  prUrl: string
  headSha: string
}): Promise<DeployEnqueueOutcome> {
  const orchestrationKey = buildDeployOrchestrationKey(opts.prUrl, opts.headSha)
  // Bewust GÉÉN requested_*-snapshot (fase 5, PR #91: enqueue schrijft
  // minimale rijen; requested_* is alléén een echte per-job override). De
  // config resolvet DB-leading op claim-tijd uit JobKindConfig. De oudere
  // mcp-dispatch-paden snapshotten nog — DEPLOY volgt de fase-5-lijn.

  const result = await prisma
    .$transaction(async (tx) => {
      // Lock éérst, dan pas de config-beslissing lezen (codex plan-r1 #5).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('deploy'), hashtext(${opts.productId}))`
      const product = await tx.product.findUnique({
        where: { id: opts.productId },
        select: { auto_deploy: true, deploy_flow: true },
      })
      if (!product?.auto_deploy || !product.deploy_flow) return 'not_configured' as const
      // Blokkade na falen (spec §6): geen auto-enqueue bij onopgeloste FAILED.
      const blocked = await tx.claudeJob.findFirst({
        where: { product_id: opts.productId, kind: 'DEPLOY', status: 'FAILED', resolved_at: null },
        select: { id: true },
      })
      if (blocked) return 'blocked' as const
      const job = await tx.claudeJob.create({
        data: {
          user_id: opts.userId,
          product_id: opts.productId,
          kind: 'DEPLOY',
          status: 'QUEUED',
          runtime: 'CLAUDE',
          source: 'SYSTEM',
          required_capability: 'deploy',
          created_by_job_id: opts.parentJobId,
          orchestration_key: orchestrationKey,
          pr_url: opts.prUrl,
          head_sha: opts.headSha,
        },
        select: { id: true },
      })
      return { jobId: job.id }
    })
    .catch((err: unknown) => {
      // Unique-conflict op de partial index ⇒ dedup (P2002 of raw 23505).
      const code = (err as { code?: string })?.code
      const msg = String(err)
      if (code === 'P2002' || msg.includes('23505') || msg.includes('claude_jobs_deploy_orchestration_key')) {
        return 'dedup' as const
      }
      throw err
    })

  if (result === 'blocked' || result === 'dedup' || result === 'not_configured') return result
  await notifyJobEnqueued({
    job_id: result.jobId,
    user_id: opts.userId,
    product_id: opts.productId,
    kind: 'DEPLOY',
  })
  return 'enqueued'
}
