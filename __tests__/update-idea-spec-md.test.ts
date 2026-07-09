import { describe, it, expect, vi, beforeEach } from 'vitest'

const { m } = vi.hoisted(() => ({
  m: {
    idea: { findUnique: vi.fn(), update: vi.fn() },
    ideaLog: { create: vi.fn() },
    claudeJob: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}))
vi.mock('../src/prisma.js', () => ({ prisma: m }))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn().mockResolvedValue({ userId: 'u1', tokenId: 'tok-1' }),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/access.js', () => ({ userOwnsIdea: vi.fn().mockResolvedValue(true) }))
const mockWrite = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/product-doc-write.js', () => ({
  writeProductDoc: mockWrite,
  ProductDocWriteError: class ProductDocWriteError extends Error {},
}))
const mockNotify = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/dispatch/notify.js', () => ({ notifyJobEnqueued: mockNotify }))

import { handleUpdateIdeaSpecMd } from '../src/tools/update-idea-spec-md.js'

beforeEach(() => {
  // mockReset (niet clear): wist ook once-queues zodat tests elkaars
  // gequeuede responses niet consumeren.
  for (const fn of [m.idea.findUnique, m.idea.update, m.ideaLog.create,
    m.claudeJob.findFirst, m.claudeJob.create, m.$transaction, m.$queryRaw,
    mockWrite, mockNotify]) fn.mockReset()
  m.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: typeof m) => unknown)(m) : Promise.all(arg as Promise<unknown>[]))
  mockWrite.mockResolvedValue({ doc_id: 'doc-1', revision_id: 'rev-1', revision: 1, noop: false })
  m.idea.update.mockResolvedValue({ id: 'i1', status: 'SPEC_DRAFTING', code: 'IDEA-145' })
  m.ideaLog.create.mockResolvedValue({})
  m.claudeJob.create.mockResolvedValue({ id: 'job-review-1' })
})

function setupIdea() {
  // 1e findUnique: handler-fetch; 2e: dispatch-fetch (spec_doc_id)
  m.idea.findUnique
    .mockResolvedValueOnce({ id: 'i1', code: 'IDEA-145', user_id: 'u1', product_id: 'p1', title: 'Spec, plan en exec' })
    .mockResolvedValueOnce({ spec_doc_id: 'doc-1' })
}

describe('update_idea_spec_md (M23)', () => {
  it('schrijft SPECS-doc met slug {code}-spec en zet spec_doc_id', async () => {
    setupIdea()
    m.claudeJob.findFirst.mockResolvedValue(null) // geen actieve maker → geen dispatch
    const r = await handleUpdateIdeaSpecMd({ idea_id: 'i1', markdown: '# Spec' })
    expect(mockWrite).toHaveBeenCalledWith(m, expect.objectContaining({
      folder: 'SPECS', slug: 'idea-145-spec', product_id: 'p1',
    }))
    expect(m.idea.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { spec_doc_id: 'doc-1' },
    }))
    expect(m.claudeJob.create).not.toHaveBeenCalled()
    expect(JSON.parse((r as { content: { text: string }[] }).content[0].text).ok).toBe(true)
  })

  it('dispatcht SPEC_REVIEW met idea_id, pin en source SYSTEM bij actieve maker', async () => {
    setupIdea()
    m.claudeJob.findFirst
      .mockResolvedValueOnce({ id: 'maker-1', orchestration_key: null, user_id: 'u1', product_id: 'p1' })
    m.$queryRaw.mockResolvedValue([{ id: 'i1' }])
    // findActiveSpecLoopJob → geen andere actieve job
    m.claudeJob.findFirst.mockResolvedValueOnce(null)
    await handleUpdateIdeaSpecMd({ idea_id: 'i1', markdown: '# Spec' })
    expect(m.claudeJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: 'SPEC_REVIEW',
        idea_id: 'i1',
        doc_id: 'doc-1',
        doc_revision_id: 'rev-1',
        source: 'SYSTEM', // N7: override NÁ REVIEW_JOB_FIELDS-spread
        orchestration_key: 'idea:i1:spec-loop:r1',
        created_by_job_id: 'maker-1',
      }),
    }))
    expect(m.idea.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: 'SPEC_REVIEWING' },
    }))
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'SPEC_REVIEW', idea_id: 'i1' }))
  })

  it('P2002 op de dedup-unique is een no-op', async () => {
    setupIdea()
    m.claudeJob.findFirst.mockResolvedValueOnce({ id: 'maker-1', orchestration_key: 'idea:i1:spec-loop:r2', user_id: 'u1', product_id: 'p1' })
    m.$queryRaw.mockResolvedValue([{ id: 'i1' }])
    m.claudeJob.findFirst.mockResolvedValueOnce(null)
    const { Prisma } = await import('@prisma/client')
    m.claudeJob.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    )
    const r = await handleUpdateIdeaSpecMd({ idea_id: 'i1', markdown: '# Spec' })
    expect(JSON.parse((r as { content: { text: string }[] }).content[0].text).ok).toBe(true)
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('weigert idea zonder product', async () => {
    m.idea.findUnique.mockResolvedValueOnce({ id: 'i1', code: 'IDEA-145', user_id: 'u1', product_id: null, title: 't' })
    const r = await handleUpdateIdeaSpecMd({ idea_id: 'i1', markdown: '# Spec' })
    expect((r as { isError?: boolean }).isError).toBe(true)
  })
})
