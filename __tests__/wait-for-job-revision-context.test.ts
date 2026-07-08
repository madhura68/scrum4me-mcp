import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn() },
    reviewLog: { findUnique: vi.fn() },
  },
}))

import { prisma } from '../src/prisma.js'
import { resolveReviewFeedback } from '../src/tools/wait-for-job.js'

const m = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
  reviewLog: { findUnique: ReturnType<typeof vi.fn> }
}

const IDEA_ID = 'idea-1'

describe('resolveReviewFeedback (M20 revisie-modus)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('IDEA_MAKE_PLAN met parent IDEA_REVIEW_PLAN → review_feedback', async () => {
    m.claudeJob.findUnique.mockResolvedValue({ id: 'rev-1', kind: 'IDEA_REVIEW_PLAN' })
    m.reviewLog.findUnique.mockResolvedValue({
      verdict: 'CHANGES_REQUESTED',
      findings: [{ severity: 'major', message: 'X' }],
      summary: 'NO-GO r1',
    })
    const fb = await resolveReviewFeedback({
      kind: 'IDEA_MAKE_PLAN',
      created_by_job_id: 'rev-1',
      orchestration_key: `idea:${IDEA_ID}:plan-loop:r2`,
    })
    expect(fb).toEqual({
      round: 2,
      verdict: 'CHANGES_REQUESTED',
      findings: [{ severity: 'major', message: 'X' }],
      summary: 'NO-GO r1',
    })
  })

  it('IDEA_MAKE_PLAN zonder parent → undefined', async () => {
    const fb = await resolveReviewFeedback({
      kind: 'IDEA_MAKE_PLAN',
      created_by_job_id: null,
      orchestration_key: null,
    })
    expect(fb).toBeUndefined()
    expect(m.claudeJob.findUnique).not.toHaveBeenCalled()
  })

  it('parent is geen IDEA_REVIEW_PLAN → undefined', async () => {
    m.claudeJob.findUnique.mockResolvedValue({ id: 'x', kind: 'IDEA_GRILL' })
    const fb = await resolveReviewFeedback({
      kind: 'IDEA_MAKE_PLAN',
      created_by_job_id: 'x',
      orchestration_key: `idea:${IDEA_ID}:plan-loop:r2`,
    })
    expect(fb).toBeUndefined()
    expect(m.reviewLog.findUnique).not.toHaveBeenCalled()
  })

  it('IDEA_REVIEW_PLAN zelf (geen make-plan) → undefined', async () => {
    const fb = await resolveReviewFeedback({
      kind: 'IDEA_REVIEW_PLAN',
      created_by_job_id: 'y',
      orchestration_key: `idea:${IDEA_ID}:plan-loop:r1`,
    })
    expect(fb).toBeUndefined()
  })

  it('parent zonder ReviewLog → undefined', async () => {
    m.claudeJob.findUnique.mockResolvedValue({ id: 'rev-1', kind: 'IDEA_REVIEW_PLAN' })
    m.reviewLog.findUnique.mockResolvedValue(null)
    const fb = await resolveReviewFeedback({
      kind: 'IDEA_MAKE_PLAN',
      created_by_job_id: 'rev-1',
      orchestration_key: `idea:${IDEA_ID}:plan-loop:r2`,
    })
    expect(fb).toBeUndefined()
  })
})
