// M23: pipeline-verdictpad voor SPEC_REVIEW mét idea_id (spec-fase).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { m } = vi.hoisted(() => ({
  m: {
    claudeJob: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
    reviewLog: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    idea: { update: vi.fn() },
    ideaLog: { create: vi.fn() },
    claudeQuestion: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}))
vi.mock('../src/prisma.js', () => ({ prisma: m }))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn().mockResolvedValue({ userId: 'u1', tokenId: 'tok-1' }),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
const mockNotify = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/dispatch/notify.js', () => ({ notifyJobEnqueued: mockNotify }))
const mockPush = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/push-trigger.js', () => ({ triggerPush: mockPush }))
const mockMaterialize = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/idea-materialize.js', () => ({ materializeIdeaPlan: mockMaterialize }))

import { handleSubmitReview } from '../src/tools/submit-review.js'

function setupJob(opts: {
  orchestration_key?: string | null
  job_status?: string
  claimed_by_token_id?: string
  existingReviewLog?: boolean
} = {}) {
  m.claudeJob.findUnique
    .mockResolvedValueOnce({
      id: 'rev-job-1', user_id: 'u1', kind: 'SPEC_REVIEW', product_id: 'p1',
      runtime: 'CODEX', orchestration_key: opts.orchestration_key ?? 'idea:i1:spec-loop:r1',
      status: opts.job_status ?? 'RUNNING',
      claimed_by_token_id: opts.claimed_by_token_id ?? 'tok-1',
      doc_id: 'doc-1', doc_revision_id: 'drev-1', task_id: null,
      doc: { current_revision_id: 'drev-1' },
      idea: { id: 'i1', status: 'SPEC_REVIEWING', plan_review_log: null },
      product: { auto_plan_review: true, auto_materialize_plan: false },
    })
    // in-tx her-lees (noodrem)
    .mockResolvedValueOnce({
      status: opts.job_status ?? 'RUNNING',
      claimed_by_token_id: opts.claimed_by_token_id ?? 'tok-1',
    })
  m.reviewLog.findUnique.mockResolvedValue(opts.existingReviewLog ? { id: 'rl-1' } : null)
}

const input = { job_id: 'rev-job-1', verdict: 'APPROVED' as const, findings: [], summary: 'GO' }

beforeEach(() => {
  for (const fn of [m.claudeJob.findUnique, m.claudeJob.update, m.claudeJob.create,
    m.claudeJob.findFirst, m.reviewLog.findUnique, m.reviewLog.create, m.reviewLog.upsert, m.idea.update,
    m.ideaLog.create, m.claudeQuestion.create, m.$queryRaw, m.$transaction,
    mockNotify, mockPush, mockMaterialize]) fn.mockReset()
  m.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: typeof m) => unknown)(m) : Promise.all(arg as Promise<unknown>[]))
  m.$queryRaw.mockResolvedValue([{ id: 'i1' }])
  m.claudeJob.create.mockResolvedValue({ id: 'next-job-1' })
  m.claudeJob.findFirst.mockResolvedValue(null)
  m.idea.update.mockResolvedValue({})
  m.ideaLog.create.mockResolvedValue({})
  m.reviewLog.create.mockResolvedValue({})
  m.reviewLog.upsert.mockResolvedValue({})
  m.claudeJob.update.mockResolvedValue({})
})

function parse(r: unknown) {
  return JSON.parse((r as { content: { text: string }[] }).content[0].text)
}

describe('applySpecReviewVerdict (M23)', () => {
  it('APPROVED → IDEA_MAKE_PLAN gequeued (plan-loop r1) + status PLANNING', async () => {
    setupJob()
    const r = await handleSubmitReview(input)
    expect(parse(r).outcome).toBe('plan-started')
    expect(m.claudeJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: 'IDEA_MAKE_PLAN', created_by_job_id: 'rev-job-1',
        orchestration_key: 'idea:i1:plan-loop:r1', source: 'SYSTEM',
      }),
    }))
    expect(m.idea.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'PLANNING' } }))
    expect(m.reviewLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'SPEC_REVIEW', idea_id: 'i1', doc_id: 'doc-1', doc_revision_id: 'drev-1' }),
    }))
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'IDEA_MAKE_PLAN', idea_id: 'i1' }))
  })

  it('CHANGES_REQUESTED → IDEA_REVISE_SPEC r{n+1} + status SPEC_DRAFTING', async () => {
    setupJob({ orchestration_key: 'idea:i1:spec-loop:r2' })
    const r = await handleSubmitReview({ ...input, verdict: 'CHANGES_REQUESTED' })
    expect(parse(r).outcome).toBe('revision')
    expect(m.claudeJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: 'IDEA_REVISE_SPEC', orchestration_key: 'idea:i1:spec-loop:r3',
      }),
    }))
    expect(m.idea.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SPEC_DRAFTING' } }))
  })

  // M23 E2E-1 race: het verdict kan landen terwijl de maker die deze review
  // dispatchte nog CLAIMED is (codex sneller dan de maker-afsluiting). Die maker
  // telt niet als "actieve spec-loop-job" — anders verdampt de revisie en hangt
  // het idee op SPEC_REVIEWING.
  it('CHANGES_REQUESTED sluit de dispatchende maker uit van de active-job-check', async () => {
    setupJob()
    const r = await handleSubmitReview({ ...input, verdict: 'CHANGES_REQUESTED' })
    expect(parse(r).outcome).toBe('revision')
    expect(m.claudeJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { notIn: expect.arrayContaining(['rev-job-1']) },
      }),
    }))
    expect(m.claudeJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'IDEA_REVISE_SPEC' }),
    }))
  })

  it('CHANGES_REQUESTED met een ándere actieve spec-loop-job → already-processed (geen dubbele keten)', async () => {
    setupJob()
    m.claudeJob.findFirst.mockResolvedValue({ id: 'other-job-9', kind: 'IDEA_REVISE_SPEC' })
    const r = await handleSubmitReview({ ...input, verdict: 'CHANGES_REQUESTED' })
    expect(parse(r).outcome).toBe('already-processed')
    expect(m.claudeJob.create).not.toHaveBeenCalled()
    expect(m.idea.update).not.toHaveBeenCalled()
  })

  it('REJECTED → SPEC_FAILED + escalatie-vraag met productId', async () => {
    setupJob()
    const r = await handleSubmitReview({ ...input, verdict: 'REJECTED', summary: 'fundamenteel mis' })
    expect(parse(r).outcome).toBe('rejected')
    expect(m.idea.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SPEC_FAILED' } }))
    expect(m.claudeQuestion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ idea_id: 'i1', product_id: 'p1' }),
    }))
    expect(mockPush).toHaveBeenCalled()
  })

  it('noodrem: gecancelde job → stale, géén side-effects, géén summary-stempel', async () => {
    setupJob({ job_status: 'CANCELLED' })
    const r = await handleSubmitReview(input)
    expect(parse(r).outcome).toBe('stale')
    expect(m.claudeJob.create).not.toHaveBeenCalled()
    expect(m.idea.update).not.toHaveBeenCalled()
    expect(m.claudeJob.update).not.toHaveBeenCalled()
  })

  it('create-once: bestaande ReviewLog → already-processed', async () => {
    setupJob({ existingReviewLog: true })
    const r = await handleSubmitReview(input)
    expect(parse(r).outcome).toBe('already-processed')
    expect(m.claudeJob.create).not.toHaveBeenCalled()
  })

  it('ad-hoc SPEC_REVIEW (zonder idea) volgt het bestaande upsert-pad', async () => {
    m.claudeJob.findUnique.mockResolvedValueOnce({
      id: 'rev-job-2', user_id: 'u1', kind: 'SPEC_REVIEW', product_id: 'p1',
      runtime: 'CODEX', orchestration_key: null, status: 'RUNNING',
      claimed_by_token_id: 'tok-1', doc_id: 'doc-9', doc_revision_id: null, task_id: null,
      doc: { current_revision_id: 'drev-9' }, idea: null, product: null,
    })
    const r = await handleSubmitReview(input)
    expect(parse(r).ok).toBe(true)
    // pipeline-side-effects niet aangeraakt
    expect(m.idea.update).not.toHaveBeenCalled()
    expect(m.claudeJob.create).not.toHaveBeenCalled()
  })
})
