import { describe, it, expect, vi, beforeEach } from 'vitest'

const { m } = vi.hoisted(() => ({
  m: {
    idea: { findUnique: vi.fn(), update: vi.fn() },
    ideaLog: { create: vi.fn() },
    claudeJob: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}))

vi.mock('../src/prisma.js', () => ({ prisma: m }))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn().mockResolvedValue({ userId: 'u1' }),
}))
vi.mock('../src/access.js', () => ({ userOwnsIdea: vi.fn().mockResolvedValue(true) }))
vi.mock('../src/lib/product-doc-write.js', () => ({
  writeProductDoc: vi.fn().mockResolvedValue({ doc_id: 'doc-1', revision_id: 'rev-1', revision: 1, noop: false }),
  ProductDocWriteError: class extends Error {},
}))
vi.mock('../src/lib/ensure-product-doc-frontmatter.js', () => ({
  ensureProductDocFrontmatter: (md: string) => md,
}))
const { mockNotify } = vi.hoisted(() => ({ mockNotify: vi.fn() }))
vi.mock('../src/lib/dispatch/notify.js', () => ({ notifyJobEnqueued: mockNotify }))

import { handleUpdateIdeaPlanMd } from '../src/tools/update-idea-plan-md.js'

const IDEA_ID = 'idea-1'
const VALID_PLAN = `---
pbi:
  title: New PBI
  priority: 2
stories:
  - title: Story A
    priority: 2
    tasks:
      - title: Task A1
        priority: 2
---

body
`

function setup(opts: {
  auto_plan_review: boolean
  makePlanJob: { id: string; orchestration_key: string | null; user_id: string; product_id: string } | null
  activeLoopJob?: { id: string; kind: string } | null
}) {
  vi.clearAllMocks()
  m.idea.findUnique.mockResolvedValue({
    id: IDEA_ID,
    code: 'IDEA-1',
    user_id: 'u1',
    product_id: 'p1',
    title: 'T',
    product: { auto_plan_review: opts.auto_plan_review },
  })
  // $transaction: callback-vorm (success-write + auto-dispatch) → geef m als tx
  m.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: typeof m) => unknown)(m)
    return arg
  })
  m.idea.update.mockResolvedValue({ id: IDEA_ID, status: 'PLAN_READY', code: 'IDEA-1' })
  m.ideaLog.create.mockResolvedValue({})
  m.$queryRaw.mockResolvedValue([])
  // claudeJob.findFirst: 1e call = makePlanJob, 2e call = findActiveLoopJob.
  // mockReset draineert de once-queue (clearAllMocks doet dat niet → lekt
  // tussen tests die niet elke once consumeren, bv. de toggle-uit-case).
  m.claudeJob.findFirst.mockReset()
  m.claudeJob.findFirst
    .mockResolvedValueOnce(opts.makePlanJob)
    .mockResolvedValueOnce(opts.activeLoopJob ?? null)
  m.claudeJob.create.mockResolvedValue({ id: 'review-job-1' })
}

describe('update_idea_plan_md — M20 auto-dispatch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dispatcht IDEA_REVIEW_PLAN (runtime CODEX + capability review + key r1) bij toggle-aan', async () => {
    setup({ auto_plan_review: true, makePlanJob: { id: 'plan-1', orchestration_key: null, user_id: 'u1', product_id: 'p1' } })
    await handleUpdateIdeaPlanMd({ idea_id: IDEA_ID, markdown: VALID_PLAN })
    const data = m.claudeJob.create.mock.calls[0][0].data
    expect(data.kind).toBe('IDEA_REVIEW_PLAN')
    expect(data.runtime).toBe('CODEX')
    expect(data.required_capability).toBe('review')
    expect(data.source).toBe('SYSTEM')
    expect(data.created_by_job_id).toBe('plan-1')
    expect(data.orchestration_key).toBe(`idea:${IDEA_ID}:plan-loop:r1`)
  })

  it('review na revisie-plan r2 krijgt key r2 (zelfde ronde als het plan)', async () => {
    setup({
      auto_plan_review: true,
      makePlanJob: { id: 'plan-2', orchestration_key: `idea:${IDEA_ID}:plan-loop:r2`, user_id: 'u1', product_id: 'p1' },
    })
    await handleUpdateIdeaPlanMd({ idea_id: IDEA_ID, markdown: VALID_PLAN })
    expect(m.claudeJob.create.mock.calls[0][0].data.orchestration_key).toBe(`idea:${IDEA_ID}:plan-loop:r2`)
  })

  it('notify krijgt de exacte payload-shape', async () => {
    setup({ auto_plan_review: true, makePlanJob: { id: 'plan-1', orchestration_key: null, user_id: 'u1', product_id: 'p1' } })
    await handleUpdateIdeaPlanMd({ idea_id: IDEA_ID, markdown: VALID_PLAN })
    expect(mockNotify).toHaveBeenCalledWith({
      job_id: 'review-job-1',
      user_id: 'u1',
      product_id: 'p1',
      kind: 'IDEA_REVIEW_PLAN',
      idea_id: IDEA_ID,
    })
  })

  it('skipt dispatch als toggle uit staat', async () => {
    setup({ auto_plan_review: false, makePlanJob: { id: 'plan-1', orchestration_key: null, user_id: 'u1', product_id: 'p1' } })
    await handleUpdateIdeaPlanMd({ idea_id: IDEA_ID, markdown: VALID_PLAN })
    expect(m.claudeJob.create).not.toHaveBeenCalled()
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('skipt dispatch zonder actieve IDEA_MAKE_PLAN-job', async () => {
    setup({ auto_plan_review: true, makePlanJob: null })
    await handleUpdateIdeaPlanMd({ idea_id: IDEA_ID, markdown: VALID_PLAN })
    expect(m.claudeJob.create).not.toHaveBeenCalled()
  })

  it('skipt dispatch als er al een actieve loop-job draait', async () => {
    setup({
      auto_plan_review: true,
      makePlanJob: { id: 'plan-1', orchestration_key: null, user_id: 'u1', product_id: 'p1' },
      activeLoopJob: { id: 'other-review', kind: 'IDEA_REVIEW_PLAN' },
    })
    await handleUpdateIdeaPlanMd({ idea_id: IDEA_ID, markdown: VALID_PLAN })
    expect(m.claudeJob.create).not.toHaveBeenCalled()
    expect(mockNotify).not.toHaveBeenCalled()
  })
})
