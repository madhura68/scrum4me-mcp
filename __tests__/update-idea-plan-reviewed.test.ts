import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn() },
    idea: { update: vi.fn(), findUnique: vi.fn() },
    ideaLog: { create: vi.fn() },
    reviewLog: { upsert: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(),
  PermissionDeniedError: class PermissionDeniedError extends Error {
    constructor(message = 'Demo accounts cannot perform write operations') {
      super(message)
      this.name = 'PermissionDeniedError'
    }
  },
}))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { handleUpdateIdeaPlanReviewed } from '../src/tools/update-idea-plan-reviewed.js'

const p = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
  idea: { update: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> }
  ideaLog: { create: ReturnType<typeof vi.fn> }
  reviewLog: { upsert: ReturnType<typeof vi.fn> }
  $transaction: ReturnType<typeof vi.fn>
}
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>

const IDEA_ID = 'idea-1'
const JOB_ID = 'job-1'
const USER_ID = 'user-1'
const REVIEW_LOG = { rounds: [{ score: 88 }], convergence: { stable_at_round: 2 }, approval: { status: 'approved' }, findings: [{ severity: 'major', message: 'x' }] }

beforeEach(() => {
  // M23 pin-retrofit: idea-fetch vóór de tx.
  p.idea.findUnique.mockResolvedValue({ plan_doc_id: 'pd-1', plan_doc: { current_revision_id: 'rev-9' } })
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: USER_ID, tokenId: 't', username: 'a', isDemo: false })
  p.claudeJob.findUnique.mockResolvedValue({
    id: JOB_ID, user_id: USER_ID, kind: 'IDEA_REVIEW_PLAN', idea_id: IDEA_ID, product_id: 'prod-1',
  })
  p.$transaction.mockResolvedValue([{ id: IDEA_ID, status: 'PLAN_REVIEWED', code: 'IDEA-1' }, {}])
})

describe('update_idea_plan_reviewed job-binding + ReviewLog', () => {
  it('weigert als de job niet van de user is (404-shape)', async () => {
    p.claudeJob.findUnique.mockResolvedValue({ id: JOB_ID, user_id: 'other', kind: 'IDEA_REVIEW_PLAN', idea_id: IDEA_ID, product_id: 'prod-1' })
    const res = await handleUpdateIdeaPlanReviewed({ idea_id: IDEA_ID, job_id: JOB_ID, review_log: REVIEW_LOG, approval_status: 'approved' })
    expect(JSON.stringify(res)).toContain('Job not found')
    expect(p.reviewLog.upsert).not.toHaveBeenCalled()
  })

  it('weigert bij verkeerde kind', async () => {
    p.claudeJob.findUnique.mockResolvedValue({ id: JOB_ID, user_id: USER_ID, kind: 'PR_REVIEW', idea_id: IDEA_ID, product_id: 'prod-1' })
    const res = await handleUpdateIdeaPlanReviewed({ idea_id: IDEA_ID, job_id: JOB_ID, review_log: REVIEW_LOG })
    expect(JSON.stringify(res)).toContain('not an IDEA_REVIEW_PLAN')
  })

  it('weigert bij idea_id-mismatch', async () => {
    const res = await handleUpdateIdeaPlanReviewed({ idea_id: 'other-idea', job_id: JOB_ID, review_log: REVIEW_LOG })
    expect(JSON.stringify(res)).toContain('Job not found')
  })

  it('approved → ReviewLog verdict APPROVED + idea_id + findings', async () => {
    await handleUpdateIdeaPlanReviewed({ idea_id: IDEA_ID, job_id: JOB_ID, review_log: REVIEW_LOG, approval_status: 'approved' })
    expect(p.reviewLog.upsert).toHaveBeenCalledTimes(1)
    const arg = p.reviewLog.upsert.mock.calls[0][0]
    expect(arg.where).toEqual({ review_job_id: JOB_ID })
    expect(arg.create.verdict).toBe('APPROVED')
    expect(arg.create.kind).toBe('IDEA_REVIEW_PLAN')
    expect(arg.create.idea_id).toBe(IDEA_ID)
    expect(arg.create.product_id).toBe('prod-1')
    expect(arg.create.findings).toEqual([{ severity: 'major', message: 'x' }])
  })

  it('rejected → REJECTED, omitted → CHANGES_REQUESTED', async () => {
    await handleUpdateIdeaPlanReviewed({ idea_id: IDEA_ID, job_id: JOB_ID, review_log: REVIEW_LOG, approval_status: 'rejected' })
    expect(p.reviewLog.upsert.mock.calls[0][0].create.verdict).toBe('REJECTED')
    vi.clearAllMocks()
    mockAuth.mockResolvedValue({ userId: USER_ID, tokenId: 't', username: 'a', isDemo: false })
    p.claudeJob.findUnique.mockResolvedValue({ id: JOB_ID, user_id: USER_ID, kind: 'IDEA_REVIEW_PLAN', idea_id: IDEA_ID, product_id: 'prod-1' })
    p.$transaction.mockResolvedValue([{ id: IDEA_ID, status: 'PLAN_REVIEW_FAILED', code: 'IDEA-1' }, {}])
    await handleUpdateIdeaPlanReviewed({ idea_id: IDEA_ID, job_id: JOB_ID, review_log: REVIEW_LOG })
    expect(p.reviewLog.upsert.mock.calls[0][0].create.verdict).toBe('CHANGES_REQUESTED')
  })
})

it('M23: pint doc_id + doc_revision_id (current) in de ReviewLog-pins', async () => {
  await handleUpdateIdeaPlanReviewed({ idea_id: IDEA_ID, job_id: JOB_ID, review_log: REVIEW_LOG, approval_status: 'approved' })
  const arg = p.reviewLog.upsert.mock.calls[0][0]
  expect(arg.create).toEqual(expect.objectContaining({ doc_id: 'pd-1', doc_revision_id: 'rev-9' }))
})
