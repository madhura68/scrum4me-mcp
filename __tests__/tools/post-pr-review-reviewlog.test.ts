import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/prisma.js', () => ({
  prisma: { claudeJob: { findUnique: vi.fn(), update: vi.fn() }, reviewLog: { upsert: vi.fn() } },
}))
vi.mock('../../src/auth.js', () => ({ requireWriteAccess: vi.fn() }))
vi.mock('../../src/git/pr.js', () => ({ postPullRequestReview: vi.fn() }))

import { prisma } from '../../src/prisma.js'
import { requireWriteAccess } from '../../src/auth.js'
import { postPullRequestReview } from '../../src/git/pr.js'
import { handlePostPrReview } from '../../src/tools/post-pr-review.js'

const p = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  reviewLog: { upsert: ReturnType<typeof vi.fn> }
}
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockPost = postPullRequestReview as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'u1', tokenId: 't', username: 'a', isDemo: false })
  p.claudeJob.findUnique.mockResolvedValue({
    id: 'job-1', user_id: 'u1', pr_url: 'https://git/x/y/pulls/1', kind: 'PR_REVIEW', product_id: 'prod-1',
  })
  p.claudeJob.update.mockResolvedValue({})
  mockPost.mockResolvedValue({ reviewId: 'rev-1' })
})

describe('post_pr_review → ReviewLog', () => {
  it('APPROVED schrijft ReviewLog met verdict APPROVED + pr_commit_id', async () => {
    await handlePostPrReview({
      job_id: 'job-1', pr_url: 'https://git/x/y/pulls/1', event: 'APPROVED',
      body: 'looks good', commit_id: 'abc123', review_log: { findings: [{ severity: 'info', message: 'ok' }] },
    })
    expect(p.reviewLog.upsert).toHaveBeenCalledTimes(1)
    const arg = p.reviewLog.upsert.mock.calls[0][0]
    expect(arg.where).toEqual({ review_job_id: 'job-1' })
    expect(arg.create.verdict).toBe('APPROVED')
    expect(arg.create.kind).toBe('PR_REVIEW')
    expect(arg.create.product_id).toBe('prod-1')
    expect(arg.create.pr_commit_id).toBe('abc123')
    expect(arg.create.findings).toEqual([{ severity: 'info', message: 'ok' }])
  })

  it('REQUEST_CHANGES → verdict CHANGES_REQUESTED', async () => {
    await handlePostPrReview({ job_id: 'job-1', pr_url: 'https://git/x/y/pulls/1', event: 'REQUEST_CHANGES', body: 'fix' })
    expect(p.reviewLog.upsert.mock.calls[0][0].create.verdict).toBe('CHANGES_REQUESTED')
  })

  it('COMMENT → verdict COMMENT, mét findings en pin (was: sloeg de rij over)', async () => {
    await handlePostPrReview({
      job_id: 'job-1', pr_url: 'https://git/x/y/pulls/1', event: 'COMMENT',
      body: 'note', commit_id: 'def456',
      review_log: { findings: [{ severity: 'warning', ref: 'a.ts:1', message: 'let op' }] },
    })
    expect(p.reviewLog.upsert).toHaveBeenCalledTimes(1)
    const arg = p.reviewLog.upsert.mock.calls[0][0]
    expect(arg.where).toEqual({ review_job_id: 'job-1' })
    expect(arg.create.verdict).toBe('COMMENT')
    expect(arg.create.kind).toBe('PR_REVIEW')
    expect(arg.create.pr_commit_id).toBe('def456')
    expect(arg.create.findings).toEqual([{ severity: 'warning', ref: 'a.ts:1', message: 'let op' }])
  })

  it('COMMENT zonder review_log levert een lege findings-array, geen crash', async () => {
    await handlePostPrReview({ job_id: 'job-1', pr_url: 'https://git/x/y/pulls/1', event: 'COMMENT', body: 'note' })
    expect(p.reviewLog.upsert.mock.calls[0][0].create.findings).toEqual([])
  })

  it('een gefaalde Forgejo-post schrijft geen ReviewLog', async () => {
    mockPost.mockResolvedValue({ error: 'boom' })
    await handlePostPrReview({ job_id: 'job-1', pr_url: 'https://git/x/y/pulls/1', event: 'COMMENT', body: 'note' })
    expect(p.reviewLog.upsert).not.toHaveBeenCalled()
  })
})
