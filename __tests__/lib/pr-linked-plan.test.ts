import { describe, it, expect, vi, beforeEach } from 'vitest'

const findFirstJob = vi.fn()
const findFirstPbi = vi.fn()
vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findFirst: (...a: any[]) => findFirstJob(...a) },
    pbi: { findFirst: (...a: any[]) => findFirstPbi(...a) },
  },
}))

import { resolvePrLinkedPlan } from '../../src/lib/pr-linked-plan.js'

const JOB = { id: 'review-job', pr_url: 'https://git.jp-visser.nl/o/r/pulls/9' }

beforeEach(() => { vi.clearAllMocks(); findFirstJob.mockResolvedValue(null); findFirstPbi.mockResolvedValue(null) })

describe('resolvePrLinkedPlan', () => {
  it('sluit de huidige review-job uit in de query', async () => {
    await resolvePrLinkedPlan(JOB as any)
    const where = findFirstJob.mock.calls[0][0].where
    expect(where.id).toEqual({ not: 'review-job' })
    expect(where.pr_url).toBe(JOB.pr_url)
  })
  it('job-pad: task-implementatie met plan_snapshot', async () => {
    findFirstJob.mockResolvedValue({
      id: 'impl', plan_snapshot: 'PLAN',
      task: { implementation_plan: 'TP', story: { acceptance_criteria: 'AC' } },
    })
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toMatchObject({ source: 'job', plan_snapshot: 'PLAN', acceptance_criteria: 'AC' })
  })
  it('impl-job zonder bruikbare plan-context → door naar pbi-fallback', async () => {
    findFirstJob.mockResolvedValue({ id: 'impl', plan_snapshot: null, task: null })
    findFirstPbi.mockResolvedValue({ id: 'pbi1', docs: [{ doc_revision: { content_md: 'PM' } }] })
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toMatchObject({ source: 'pbi', plan_md: 'PM' })
  })
  it('pbi-fallback via PbiDoc(role=PLAN) → doc_revision.content_md', async () => {
    findFirstPbi.mockResolvedValue({ id: 'pbi1', docs: [{ doc_revision: { content_md: 'PM' } }] })
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toMatchObject({ source: 'pbi', plan_md: 'PM' })
  })
  it('pbi zonder PLAN-doc → null (geen bruikbaar plan)', async () => {
    findFirstPbi.mockResolvedValue({ id: 'pbi1', docs: [] })
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toBeNull()
  })
  it('niets matcht → null', async () => {
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toBeNull()
  })
  it('job zonder pr_url → null zonder queries', async () => {
    const out = await resolvePrLinkedPlan({ id: 'x', pr_url: null } as any)
    expect(out).toBeNull()
    expect(findFirstJob).not.toHaveBeenCalled()
  })
})
