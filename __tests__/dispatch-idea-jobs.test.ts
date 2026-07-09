import { describe, it, expect, vi, beforeEach } from 'vitest'

const tx = {
  claudeJob: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
  idea: { update: vi.fn() },
  ideaLog: { create: vi.fn() },
}
vi.mock('../src/prisma.js', () => ({
  prisma: {
    idea: { findFirst: vi.fn() },
    claudeJob: { findFirst: vi.fn() },
    claudeWorker: { count: vi.fn() },
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  },
}))
vi.mock('../src/lib/dispatch/snapshot.js', () => ({
  getJobConfigSnapshot: vi.fn().mockResolvedValue({}),
}))
vi.mock('../src/lib/dispatch/notify.js', () => ({
  notifyJobEnqueued: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { notifyJobEnqueued } from '../src/lib/dispatch/notify.js'
import { dispatchIdeaJob, DispatchError } from '../src/lib/dispatch/idea-jobs.js'

const mockIdea = prisma.idea.findFirst as ReturnType<typeof vi.fn>
const mockActive = prisma.claudeJob.findFirst as ReturnType<typeof vi.fn>
const mockWorkers = prisma.claudeWorker.count as ReturnType<typeof vi.fn>

const baseIdea = {
  id: 'idea-1', status: 'DRAFT', product_id: 'prod-1',
  title: 'Een net idee', description: 'beschrijving',
  product: { id: 'prod-1', repo_url: 'https://git.jp-visser.nl/janpeter/x', content_policy: null },
}

beforeEach(() => {
  vi.clearAllMocks()
  tx.claudeJob.create.mockResolvedValue({ id: 'job-1' })
  mockIdea.mockResolvedValue(baseIdea)
  mockActive.mockResolvedValue(null)
  mockWorkers.mockResolvedValue(1)
})

describe('dispatchIdeaJob', () => {
  it('maakt job met source COPILOT, flipt status en logt', async () => {
    const res = await dispatchIdeaJob({
      kind: 'IDEA_GRILL', ideaId: 'idea-1', productId: 'prod-1', userId: 'user-1',
    })
    expect(res).toEqual({ job_id: 'job-1' })
    expect(tx.claudeJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'IDEA_GRILL', source: 'COPILOT', status: 'QUEUED' }),
      }),
    )
    expect(tx.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'GRILLING' } }),
    )
    expect(tx.ideaLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'JOB_EVENT', idea_id: 'idea-1' }),
      }),
    )
    expect(notifyJobEnqueued).toHaveBeenCalledWith(
      expect.objectContaining({ job_id: 'job-1', kind: 'IDEA_GRILL' }),
    )
  })

  it('weigert idea van een ander product (404-stijl)', async () => {
    mockIdea.mockResolvedValue({ ...baseIdea, product_id: 'prod-2', product: { id: 'prod-2', repo_url: 'r' } })
    await expect(
      dispatchIdeaJob({ kind: 'IDEA_GRILL', ideaId: 'idea-1', productId: 'prod-1', userId: 'user-1' }),
    ).rejects.toThrow(DispatchError)
  })

  it('weigert verkeerde status', async () => {
    mockIdea.mockResolvedValue({ ...baseIdea, status: 'GRILLING' })
    await expect(
      dispatchIdeaJob({ kind: 'IDEA_GRILL', ideaId: 'idea-1', productId: 'prod-1', userId: 'user-1' }),
    ).rejects.toThrow(/status/)
  })

  it('weigert bij actieve job (idempotency)', async () => {
    mockActive.mockResolvedValue({ id: 'job-9' })
    await expect(
      dispatchIdeaJob({ kind: 'IDEA_GRILL', ideaId: 'idea-1', productId: 'prod-1', userId: 'user-1' }),
    ).rejects.toThrow(/actieve/)
  })

  it('weigert zonder actieve worker', async () => {
    mockWorkers.mockResolvedValue(0)
    await expect(
      dispatchIdeaJob({ kind: 'IDEA_GRILL', ideaId: 'idea-1', productId: 'prod-1', userId: 'user-1' }),
    ).rejects.toThrow(/worker/i)
  })

  it('dispatch-defense: weigert een bestaand idee dat de product-policy schendt', async () => {
    mockIdea.mockResolvedValue({
      ...baseIdea,
      title: 'Voeg bsn toe',
      product: {
        ...baseIdea.product,
        content_policy: { forbiddenFields: ['bsn'], forbiddenFeatureTerms: [], allowedFieldTerms: [] },
      },
    })
    await expect(
      dispatchIdeaJob({ kind: 'IDEA_GRILL', ideaId: 'idea-1', productId: 'prod-1', userId: 'user-1' }),
    ).rejects.toThrow(/AVG.*bsn/)
  })

  it('dispatch-defense: staat schone inhoud toe ondanks een policy', async () => {
    mockIdea.mockResolvedValue({
      ...baseIdea,
      title: 'Nette titel',
      description: 'ok',
      product: {
        ...baseIdea.product,
        content_policy: { forbiddenFields: ['bsn'], forbiddenFeatureTerms: [], allowedFieldTerms: [] },
      },
    })
    const res = await dispatchIdeaJob({ kind: 'IDEA_GRILL', ideaId: 'idea-1', productId: 'prod-1', userId: 'user-1' })
    expect(res).toEqual({ job_id: 'job-1' })
  })

  it('dispatch-defense: faalt closed bij een malformed policy', async () => {
    mockIdea.mockResolvedValue({
      ...baseIdea,
      product: { ...baseIdea.product, content_policy: { forbiddenFields: 'bsn' } },
    })
    await expect(
      dispatchIdeaJob({ kind: 'IDEA_GRILL', ideaId: 'idea-1', productId: 'prod-1', userId: 'user-1' }),
    ).rejects.toThrow(/content_policy|configuratie/i)
  })
})

describe('M23 IDEA_MAKE_SPEC dispatch', () => {
  it('IDEA_KIND_RULES: SPEC_DRAFTING vanuit GRILLED/SPEC_FAILED, en IDEA_REVISE_SPEC is géén dispatch-kind', async () => {
    const src = (await import('node:fs')).readFileSync('src/lib/dispatch/idea-jobs.ts', 'utf8')
    expect(src).toMatch(/IDEA_MAKE_SPEC: \{\s*\n\s*newStatus: 'SPEC_DRAFTING',\s*\n\s*allowedFrom: \['GRILLED', 'SPEC_FAILED'\],/)
    expect(src).not.toMatch(/IDEA_REVISE_SPEC: \{/)
  })
})
