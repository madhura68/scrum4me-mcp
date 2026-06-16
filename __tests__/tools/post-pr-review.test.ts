import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/auth.js', () => ({
  requireWriteAccess: vi.fn(async () => ({ userId: 'u1' })),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../../src/git/pr.js', () => ({
  postPullRequestReview: vi.fn(),
}))
vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
    reviewLog: { upsert: vi.fn(async () => ({})) },
  },
}))

import { postPullRequestReview } from '../../src/git/pr.js'
import { prisma } from '../../src/prisma.js'
import { handlePostPrReview } from '../../src/tools/post-pr-review.js'

const PR = 'https://git.jp-visser.nl/o/r/pulls/9'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue({
    id: 'job1',
    user_id: 'u1',
    pr_url: PR,
    kind: 'PR_REVIEW',
  } as any)
})

describe('post_pr_review', () => {
  it('post de review + schrijft summary-trace met findings-telling', async () => {
    vi.mocked(postPullRequestReview).mockResolvedValue({ ok: true, reviewId: 3 })
    const res = await handlePostPrReview({
      job_id: 'job1',
      pr_url: PR,
      event: 'APPROVED',
      body: 'lgtm',
      review_log: { findings: [{}, {}] },
    })
    expect(postPullRequestReview).toHaveBeenCalledWith(
      expect.objectContaining({ prUrl: PR, event: 'APPROVED', body: 'lgtm' }),
    )
    expect(prisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job1' },
        data: expect.objectContaining({ summary: expect.stringContaining('(2 findings)') }),
      }),
    )
    expect(res.isError).toBeFalsy()
  })

  it('Forgejo-fout → tool faalt (geen valse done)', async () => {
    vi.mocked(postPullRequestReview).mockResolvedValue({ error: 'boom' })
    const res = await handlePostPrReview({ job_id: 'job1', pr_url: PR, event: 'COMMENT', body: 'x' })
    expect(res.isError).toBe(true)
    expect(prisma.claudeJob.update).not.toHaveBeenCalled()
  })

  it('niet-PR_REVIEW job → error (sink is geen vrije post-API)', async () => {
    vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue({
      id: 'job1',
      user_id: 'u1',
      pr_url: PR,
      kind: 'IDEA_REVIEW_PLAN',
    } as any)
    const res = await handlePostPrReview({ job_id: 'job1', pr_url: PR, event: 'COMMENT', body: 'x' })
    expect(res.isError).toBe(true)
    expect(postPullRequestReview).not.toHaveBeenCalled()
  })

  it('PR_REVIEW-job zonder opgeslagen pr_url → error (geen post)', async () => {
    vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue({ id: 'job1', user_id: 'u1', pr_url: null, kind: 'PR_REVIEW' } as any)
    const res = await handlePostPrReview({ job_id: 'job1', pr_url: PR, event: 'COMMENT', body: 'x' })
    expect(res.isError).toBe(true)
    expect(postPullRequestReview).not.toHaveBeenCalled()
  })

  it('pr_url ≠ job.pr_url → error (geen cross-PR posting)', async () => {
    const res = await handlePostPrReview({
      job_id: 'job1',
      pr_url: 'https://git.jp-visser.nl/o/r/pulls/999',
      event: 'COMMENT',
      body: 'x',
    })
    expect(res.isError).toBe(true)
    expect(postPullRequestReview).not.toHaveBeenCalled()
  })

  it('job van andere user → error', async () => {
    vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue({
      id: 'job1',
      user_id: 'ander',
      pr_url: PR,
      kind: 'PR_REVIEW',
    } as any)
    const res = await handlePostPrReview({ job_id: 'job1', pr_url: PR, event: 'COMMENT', body: 'x' })
    expect(res.isError).toBe(true)
    expect(postPullRequestReview).not.toHaveBeenCalled()
  })
})
