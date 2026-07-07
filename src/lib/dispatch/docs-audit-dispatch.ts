// M19: handmatige DOCS_AUDIT via MCP dispatch_job = "audit de docs van dit
// product nu". Spiegelt dispatchDeploy: product-advisory-lock + active-job-guard
// binnen dezelfde tx als de create, source=MANUAL, geen requested_*-snapshot.
// Bewust géén orchestration_key: handmatige dispatch mag naast de dagbatch
// bestaan; de DB active-index (claude_jobs_docs_audit_active) + deze guard dekken
// dubbelen. Convergentie maakt een extra run sowieso veilig.
import { prisma } from '../../prisma.js'
import { DispatchError } from './errors.js'
import { notifyJobEnqueued } from './notify.js'
import { ACTIVE_JOB_STATUSES } from './idea-jobs.js'

export async function dispatchDocsAudit(opts: {
  productId: string
  userId: string
}): Promise<{ job_id: string }> {
  const job = await prisma.$transaction(async (tx) => {
    // Product-lock serialiseert enqueue t.o.v. de dagbatch/andere dispatch.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('docs_audit'), hashtext(${opts.productId}))`
    const active = await tx.claudeJob.findFirst({
      where: {
        product_id: opts.productId,
        kind: 'DOCS_AUDIT',
        status: { in: [...ACTIVE_JOB_STATUSES] },
      },
      select: { id: true },
    })
    if (active) throw new DispatchError(`Er loopt al een docs-audit voor dit product (${active.id}).`)
    return tx.claudeJob.create({
      data: {
        user_id: opts.userId,
        product_id: opts.productId,
        kind: 'DOCS_AUDIT',
        status: 'QUEUED',
        runtime: 'CLAUDE',
        source: 'MANUAL',
        required_capability: 'docs_audit',
      },
      select: { id: true },
    })
  })
  await notifyJobEnqueued({
    job_id: job.id,
    user_id: opts.userId,
    product_id: opts.productId,
    kind: 'DOCS_AUDIT',
  })
  return { job_id: job.id }
}
