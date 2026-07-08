import { describe, it, expect, vi, beforeEach } from 'vitest'

const { m } = vi.hoisted(() => ({
  m: {
    claudeJob: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
    reviewLog: { findUnique: vi.fn(), create: vi.fn() },
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
vi.mock('../src/lib/upsert-review-log.js', () => ({ upsertReviewLog: vi.fn() }))
const { mockMaterialize, mockNotify, mockPush } = vi.hoisted(() => ({
  mockMaterialize: vi.fn(),
  mockNotify: vi.fn(),
  mockPush: vi.fn(),
}))
vi.mock('../src/lib/idea-materialize.js', () => ({ materializeIdeaPlan: mockMaterialize }))
vi.mock('../src/lib/dispatch/notify.js', () => ({ notifyJobEnqueued: mockNotify }))
vi.mock('../src/lib/push-trigger.js', () => ({ triggerPush: mockPush }))

import { handleSubmitReview } from '../src/tools/submit-review.js'

const IDEA_ID = 'idea-1'
const JOB_ID = 'rev-job-1'

function setupJob(opts: {
  orchestration_key?: string | null
  runtime?: string
  auto_plan_review?: boolean
  auto_materialize_plan?: boolean
  existingReviewLog?: boolean
  job_status?: string
  claimed_by_token_id?: string | null
}) {
  vi.clearAllMocks()
  m.claudeJob.findUnique.mockResolvedValue({
    id: JOB_ID,
    user_id: 'u1',
    kind: 'IDEA_REVIEW_PLAN',
    product_id: 'p1',
    runtime: opts.runtime ?? 'CODEX',
    orchestration_key: opts.orchestration_key ?? `idea:${IDEA_ID}:plan-loop:r1`,
    status: opts.job_status ?? 'CLAIMED',
    claimed_by_token_id: opts.claimed_by_token_id === undefined ? 'tok-1' : opts.claimed_by_token_id,
    doc_id: null,
    task_id: null,
    doc: null,
    idea: { id: IDEA_ID, status: 'REVIEWING_PLAN', plan_review_log: null },
    product: {
      auto_plan_review: opts.auto_plan_review ?? true,
      auto_materialize_plan: opts.auto_materialize_plan ?? true,
    },
  })
  m.reviewLog.findUnique.mockReset()
  m.reviewLog.findUnique.mockResolvedValue(opts.existingReviewLog ? { id: 'rl-old' } : null)
  m.claudeJob.findFirst.mockReset()
  m.claudeJob.findFirst.mockResolvedValue(null) // findActiveLoopJob → geen actieve
  m.$queryRaw.mockResolvedValue([])
  m.reviewLog.create.mockResolvedValue({ id: 'rl-1' })
  m.idea.update.mockResolvedValue({})
  m.ideaLog.create.mockResolvedValue({})
  m.claudeJob.create.mockResolvedValue({ id: 'revision-job-1' })
  m.claudeJob.update.mockResolvedValue({})
  m.claudeQuestion.create.mockResolvedValue({ id: 'q-1' })
  m.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: typeof m) => unknown)(m) : Promise.all(arg as Promise<unknown>[]),
  )
}

function ideaUpdateData() {
  return m.idea.update.mock.calls[0]?.[0]?.data
}

describe('submit_review — IDEA_REVIEW_PLAN verdict-keten (M20)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('CHANGES_REQUESTED → PLANNING + revisie-job r2', async () => {
    setupJob({ orchestration_key: `idea:${IDEA_ID}:plan-loop:r1` })
    await handleSubmitReview({ job_id: JOB_ID, verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'major', message: 'X' }], summary: 'NO-GO' })
    expect(ideaUpdateData().status).toBe('PLANNING')
    const jobData = m.claudeJob.create.mock.calls[0][0].data
    expect(jobData.kind).toBe('IDEA_MAKE_PLAN')
    expect(jobData.created_by_job_id).toBe(JOB_ID)
    expect(jobData.orchestration_key).toBe(`idea:${IDEA_ID}:plan-loop:r2`)
    expect(jobData.source).toBe('SYSTEM')
    expect(mockNotify).toHaveBeenCalled()
  })

  it('APPROVED + auto_materialize → PLAN_REVIEWED en materialize aangeroepen', async () => {
    setupJob({ auto_materialize_plan: true })
    await handleSubmitReview({ job_id: JOB_ID, verdict: 'APPROVED', findings: [], summary: 'GO' })
    expect(ideaUpdateData().status).toBe('PLAN_REVIEWED')
    expect(mockMaterialize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ideaId: IDEA_ID }))
  })

  it('APPROVED zonder auto_materialize stopt bij PLAN_REVIEWED', async () => {
    setupJob({ auto_materialize_plan: false })
    await handleSubmitReview({ job_id: JOB_ID, verdict: 'APPROVED', findings: [], summary: 'GO' })
    expect(ideaUpdateData().status).toBe('PLAN_REVIEWED')
    expect(mockMaterialize).not.toHaveBeenCalled()
  })

  it('REJECTED → PLAN_REVIEW_FAILED + escalatie-vraag + push', async () => {
    setupJob({})
    await handleSubmitReview({ job_id: JOB_ID, verdict: 'REJECTED', findings: [{ severity: 'blocker', message: 'fout' }], summary: 'afgewezen' })
    expect(ideaUpdateData().status).toBe('PLAN_REVIEW_FAILED')
    expect(m.claudeQuestion.create).toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalled()
  })

  it('dual-write: plan_review_log krijgt ronde + approval; CODEX → model codex', async () => {
    setupJob({ runtime: 'CODEX' })
    await handleSubmitReview({ job_id: JOB_ID, verdict: 'APPROVED', findings: [], summary: 'GO' })
    const log = ideaUpdateData().plan_review_log
    expect(log.rounds).toHaveLength(1)
    expect(log.approval.status).toBe('approved')
    expect(log.rounds[0].model).toBe('codex')
  })

  it('ReviewLog-rij krijgt idea_id', async () => {
    setupJob({})
    await handleSubmitReview({ job_id: JOB_ID, verdict: 'APPROVED', findings: [], summary: 'GO' })
    expect(m.reviewLog.create.mock.calls[0][0].data.idea_id).toBe(IDEA_ID)
  })

  it('CHANGES_REQUESTED met auto_plan_review UIT → PLAN_REVIEW_FAILED, geen revisie-job', async () => {
    setupJob({ auto_plan_review: false })
    await handleSubmitReview({ job_id: JOB_ID, verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'major', message: 'X' }], summary: 'NO-GO' })
    expect(ideaUpdateData().status).toBe('PLAN_REVIEW_FAILED')
    expect(m.claudeJob.create).not.toHaveBeenCalled()
  })

  it('noodrem: verdict op een CANCELLED review-job landt NIET (stale)', async () => {
    // Gebruiker cancelde de review terwijl de worker nog draaide; de late
    // submit_review mag de keten niet alsnog voortzetten.
    setupJob({ job_status: 'CANCELLED', auto_plan_review: true, auto_materialize_plan: true })
    await handleSubmitReview({
      job_id: JOB_ID,
      verdict: 'CHANGES_REQUESTED',
      findings: [{ severity: 'major', message: 'X' }],
      summary: 'NO-GO',
    })
    expect(m.reviewLog.create).not.toHaveBeenCalled()
    expect(m.idea.update).not.toHaveBeenCalled()
    expect(m.claudeJob.create).not.toHaveBeenCalled() // geen revisie-job
    expect(mockMaterialize).not.toHaveBeenCalled()
    expect(m.claudeJob.update).not.toHaveBeenCalled() // geen summary-restamp op de cancelled job
    // wél een waarheidsgetrouwe IdeaLog dat het verdict verworpen is
    const logContents = m.ideaLog.create.mock.calls.map((c) => c[0]?.data?.content ?? '')
    expect(logContents.some((t: string) => /verworpen/i.test(t))).toBe(true)
  })

  it('noodrem: verdict op een APPROVED+CANCELLED job materialiseert GEEN PBI', async () => {
    setupJob({ job_status: 'CANCELLED', auto_materialize_plan: true })
    await handleSubmitReview({ job_id: JOB_ID, verdict: 'APPROVED', findings: [], summary: 'GO' })
    expect(m.reviewLog.create).not.toHaveBeenCalled()
    expect(m.idea.update).not.toHaveBeenCalled()
    expect(mockMaterialize).not.toHaveBeenCalled()
  })

  it('noodrem: cancel ná verdict-commit maar vóór materialize → GEEN PBI', async () => {
    // Race: bij de verdict-tx was de job nog CLAIMED (verdict = approved, committed),
    // maar de cancel landt in het venster vóór de post-commit materialize. De
    // materialize-hercheck moet de PBI-bouw dan overslaan.
    setupJob({ auto_materialize_plan: true })
    const full = await m.claudeJob.findUnique() // volledige job (CLAIMED) uit setupJob
    let n = 0
    m.claudeJob.findUnique.mockReset()
    m.claudeJob.findUnique.mockImplementation(async () => {
      n++
      // 1=outer, 2=in-tx guard → CLAIMED (verdict landt); 3=materialize-hercheck → CANCELLED
      return n >= 3 ? { status: 'CANCELLED', claimed_by_token_id: 'tok-1' } : full
    })
    await handleSubmitReview({ job_id: JOB_ID, verdict: 'APPROVED', findings: [], summary: 'GO' })
    expect(m.reviewLog.create).toHaveBeenCalled() // verdict WEL toegepast (job was live bij tx)
    expect(mockMaterialize).not.toHaveBeenCalled() // maar PBI NIET gebouwd
  })

  it('stale-reclaim: verdict van een job geclaimd door ander token landt NIET', async () => {
    setupJob({ job_status: 'RUNNING', claimed_by_token_id: 'ander-token' })
    await handleSubmitReview({ job_id: JOB_ID, verdict: 'APPROVED', findings: [], summary: 'GO' })
    expect(m.reviewLog.create).not.toHaveBeenCalled()
    expect(m.idea.update).not.toHaveBeenCalled()
    expect(mockMaterialize).not.toHaveBeenCalled()
  })

  it.each(['APPROVED', 'CHANGES_REQUESTED', 'REJECTED'] as const)(
    'dubbele submit_review (%s) → al verwerkt, geen side-effects',
    async (verdict) => {
      setupJob({ existingReviewLog: true })
      await handleSubmitReview({ job_id: JOB_ID, verdict, findings: [], summary: 'retry' })
      expect(m.reviewLog.create).not.toHaveBeenCalled()
      expect(m.claudeJob.create).not.toHaveBeenCalled()
      expect(mockMaterialize).not.toHaveBeenCalled()
      expect(m.idea.update).not.toHaveBeenCalled()
    },
  )

  it('retry ná gefaalde side-effect verwerkt alsnog volledig (atomaire rollback)', async () => {
    setupJob({ auto_plan_review: true })
    m.$transaction.mockImplementationOnce(async () => {
      throw new Error('side-effect boom')
    })
    // 1e poging faalt (rollback); withToolErrors vangt → isError-respons
    const first = await handleSubmitReview({ job_id: JOB_ID, verdict: 'CHANGES_REQUESTED', findings: [], summary: 'NO-GO' })
    expect(first.isError).toBe(true)
    // 2e poging: guard ziet niets (teruggerold) → verwerkt volledig
    await handleSubmitReview({ job_id: JOB_ID, verdict: 'CHANGES_REQUESTED', findings: [], summary: 'NO-GO' })
    expect(m.claudeJob.create).toHaveBeenCalledTimes(1)
  })

  it('SPEC_REVIEW blijft werken (ongewijzigd pad)', async () => {
    vi.clearAllMocks()
    m.claudeJob.findUnique.mockResolvedValue({
      id: 'spec-job', user_id: 'u1', kind: 'SPEC_REVIEW', product_id: 'p1',
      runtime: 'CODEX', orchestration_key: null, doc_id: 'doc-1', task_id: null,
      doc: { current_revision_id: 'rev-1' }, idea: null, product: null,
    })
    m.claudeJob.update.mockResolvedValue({})
    const r = await handleSubmitReview({ job_id: 'spec-job', verdict: 'APPROVED', findings: [], summary: 'ok' })
    expect(r.isError).toBeFalsy()
    expect(m.reviewLog.create).not.toHaveBeenCalled() // SPEC gaat via upsertReviewLog-mock
  })
})
