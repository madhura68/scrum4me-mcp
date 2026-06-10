import { prisma } from '../prisma.js'

export type LinkedPlan = {
  source: 'job' | 'pbi'
  plan_md?: string | null
  acceptance_criteria?: string | null
  plan_snapshot?: string | null
}

/**
 * Resolve het plan/acceptatie dat bij een PR hoort, voor een PR_REVIEW-job.
 * Sluit de huidige review-job uit (zelfde pr_url, self-match) en filtert op
 * implementatie-dragers; valt terug op de PBI-plan-doc (PbiDoc role=PLAN);
 * anders null → de review draait op diff + product-docs.
 */
export async function resolvePrLinkedPlan(
  job: { id: string; pr_url: string | null },
): Promise<LinkedPlan | null> {
  if (!job.pr_url) return null

  const impl = await prisma.claudeJob.findFirst({
    where: {
      pr_url: job.pr_url,
      id: { not: job.id },
      OR: [
        { kind: 'TASK_IMPLEMENTATION', task_id: { not: null } },
        { kind: 'SPRINT_IMPLEMENTATION', sprint_run_id: { not: null } },
      ],
    },
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      plan_snapshot: true,
      task: {
        select: {
          implementation_plan: true,
          story: { select: { acceptance_criteria: true } },
        },
      },
    },
  })

  if (impl) {
    const acceptance = impl.task?.story?.acceptance_criteria ?? null
    const planMd = impl.task?.implementation_plan ?? null
    if (impl.plan_snapshot || planMd || acceptance) {
      return {
        source: 'job',
        plan_snapshot: impl.plan_snapshot ?? null,
        plan_md: planMd,
        acceptance_criteria: acceptance,
      }
    }
  }

  // Pbi heeft geen plan_md-kolom; plan-content hangt via PbiDoc(role=PLAN)
  // aan een ProductDocRevision.
  const pbi = await prisma.pbi.findFirst({
    where: { pr_url: job.pr_url },
    select: {
      id: true,
      docs: {
        where: { role: 'PLAN' },
        orderBy: { created_at: 'desc' },
        take: 1,
        select: { doc_revision: { select: { content_md: true } } },
      },
    },
  })
  const pbiPlanMd = pbi?.docs[0]?.doc_revision?.content_md ?? null
  if (pbi && pbiPlanMd) {
    return { source: 'pbi', plan_md: pbiPlanMd }
  }

  return null
}
