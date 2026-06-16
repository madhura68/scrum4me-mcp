import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    idea: { findFirst: vi.fn(), update: vi.fn() },
    claudeJob: { findFirst: vi.fn(), create: vi.fn() },
    claudeWorker: { count: vi.fn() },
    ideaLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('../src/lib/dispatch/snapshot.js', () => ({
  getJobConfigSnapshot: vi.fn().mockResolvedValue({ requested_model: 'sonnet', requested_thinking_budget: 6000, requested_permission_mode: 'default' }),
}))
vi.mock('../src/lib/dispatch/notify.js', () => ({ notifyJobEnqueued: vi.fn() }))
vi.mock('@shared/content-policy.js', () => ({
  parseContentPolicy: vi.fn().mockReturnValue({}),
  checkContentPolicy: vi.fn().mockReturnValue({ allowed: true }),
  ContentPolicyError: class extends Error {},
}))

import { prisma } from '../src/prisma.js'
import { dispatchIdeaJob } from '../src/lib/dispatch/idea-jobs.js'

const p = prisma as unknown as {
  idea: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  claudeJob: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
  claudeWorker: { count: ReturnType<typeof vi.fn> }
  ideaLog: { create: ReturnType<typeof vi.fn> }
  $transaction: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
  p.idea.findFirst.mockResolvedValue({
    id: 'idea-1', status: 'PLAN_READY', product_id: 'prod-1', title: 't', description: 'd',
    product: { id: 'prod-1', repo_url: 'https://git/x/y', content_policy: null },
  })
  p.claudeJob.findFirst.mockResolvedValue(null)
  p.claudeWorker.count.mockImplementation(({ where }: any) => (where.runtime === 'CODEX' ? 0 : 1))
  p.$transaction.mockImplementation(async (cb: any) =>
    cb({
      claudeJob: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
      idea: { update: vi.fn() },
      ideaLog: { create: vi.fn() },
    }),
  )
})

describe('dispatchIdeaJob routing', () => {
  it('IDEA_REVIEW_PLAN met alléén CLAUDE-worker → geen codex-review-worker', async () => {
    await expect(
      dispatchIdeaJob({ kind: 'IDEA_REVIEW_PLAN', ideaId: 'idea-1', productId: 'prod-1', userId: 'u1' }),
    ).rejects.toThrow(/codex-review-worker/)
    expect(p.claudeWorker.count.mock.calls[0][0].where.runtime).toBe('CODEX')
    expect(p.claudeWorker.count.mock.calls[0][0].where.capabilities).toEqual({ has: 'review' })
  })

  it('IDEA_GRILL met dezelfde CLAUDE-worker slaagt (ongescopete guard)', async () => {
    p.idea.findFirst.mockResolvedValue({
      id: 'idea-1', status: 'DRAFT', product_id: 'prod-1', title: 't', description: 'd',
      product: { id: 'prod-1', repo_url: 'https://git/x/y', content_policy: null },
    })
    const res = await dispatchIdeaJob({ kind: 'IDEA_GRILL', ideaId: 'idea-1', productId: 'prod-1', userId: 'u1' })
    expect(res.job_id).toBe('job-1')
    expect(p.claudeWorker.count.mock.calls[0][0].where.runtime).toBeUndefined()
  })

  it('IDEA_REVIEW_PLAN create-data bevat runtime CODEX + capability review', async () => {
    p.claudeWorker.count.mockResolvedValue(1)
    let createdData: any
    p.$transaction.mockImplementation(async (cb: any) =>
      cb({
        claudeJob: { create: vi.fn().mockImplementation((args: any) => { createdData = args.data; return { id: 'job-1' } }) },
        idea: { update: vi.fn() },
        ideaLog: { create: vi.fn() },
      }),
    )
    await dispatchIdeaJob({ kind: 'IDEA_REVIEW_PLAN', ideaId: 'idea-1', productId: 'prod-1', userId: 'u1' })
    expect(createdData.runtime).toBe('CODEX')
    expect(createdData.required_capability).toBe('review')
    expect(createdData.requested_model).toBe('codex-default')
  })
})
