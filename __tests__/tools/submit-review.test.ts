import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/auth.js', () => ({
  requireWriteAccess: vi.fn(async () => ({ userId: 'u1' })),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    reviewLog: {
      upsert: vi.fn(async () => ({})),
    },
    sprintTaskExecution: {
      findFirst: vi.fn(async () => null),
    },
  },
}))

import { prisma } from '../../src/prisma.js'
import { handleSubmitReview } from '../../src/tools/submit-review.js'

const SPEC_JOB = {
  id: 'job-spec',
  user_id: 'u1',
  kind: 'SPEC_REVIEW',
  product_id: 'p1',
  doc_id: 'doc1',
  task_id: null,
  doc: { current_revision_id: 'rev9' },
}

const TASK_JOB = {
  id: 'job-task',
  user_id: 'u1',
  kind: 'TASK_REVIEW',
  product_id: 'p1',
  doc_id: null,
  task_id: 'task1',
  doc: null,
}

const BASE_INPUT = {
  job_id: 'job-spec',
  verdict: 'CHANGES_REQUESTED' as const,
  findings: [
    { severity: 'ERROR', ref: 'line 1', message: 'wrong' },
    { severity: 'WARN', message: 'consider this' },
  ],
  summary: 'Needs changes before approval.',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('submit_review', () => {
  it('1. job not found → error; reviewLog.upsert NOT called', async () => {
    vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue(null)
    const res = await handleSubmitReview(BASE_INPUT)
    expect(res.isError).toBe(true)
    const text = res.content?.[0]
    expect(text && 'text' in text ? text.text : '').toContain('Job not found')
    expect(prisma.reviewLog.upsert).not.toHaveBeenCalled()
  })

  it('2. job owned by another user → error; upsert NOT called', async () => {
    vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue({
      ...SPEC_JOB,
      user_id: 'someone-else',
    } as any)
    const res = await handleSubmitReview(BASE_INPUT)
    expect(res.isError).toBe(true)
    const text = res.content?.[0]
    expect(text && 'text' in text ? text.text : '').toContain('Job not found')
    expect(prisma.reviewLog.upsert).not.toHaveBeenCalled()
  })

  it('3. job.kind = PR_REVIEW → error "not a SPEC_REVIEW/TASK_REVIEW job"; no upsert', async () => {
    vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue({
      ...SPEC_JOB,
      kind: 'PR_REVIEW',
    } as any)
    const res = await handleSubmitReview(BASE_INPUT)
    expect(res.isError).toBe(true)
    const text = res.content?.[0]
    expect(text && 'text' in text ? text.text : '').toMatch(/SPEC_REVIEW.*TASK_REVIEW|TASK_REVIEW.*SPEC_REVIEW/)
    expect(prisma.reviewLog.upsert).not.toHaveBeenCalled()
  })

  it('4. SPEC_REVIEW with doc_id null → error "Job has no doc_id"; no upsert', async () => {
    vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue({
      ...SPEC_JOB,
      doc_id: null,
    } as any)
    const res = await handleSubmitReview(BASE_INPUT)
    expect(res.isError).toBe(true)
    const text = res.content?.[0]
    expect(text && 'text' in text ? text.text : '').toContain('doc_id')
    expect(prisma.reviewLog.upsert).not.toHaveBeenCalled()
  })

  it('5. TASK_REVIEW with task_id null → error "Job has no task_id"; no upsert', async () => {
    vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue({
      ...TASK_JOB,
      task_id: null,
    } as any)
    const res = await handleSubmitReview({
      ...BASE_INPUT,
      job_id: 'job-task',
    })
    expect(res.isError).toBe(true)
    const text = res.content?.[0]
    expect(text && 'text' in text ? text.text : '').toContain('task_id')
    expect(prisma.reviewLog.upsert).not.toHaveBeenCalled()
  })

  it('6. SPEC_REVIEW happy path: upsert + claudeJob.update with correct summary', async () => {
    vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue(SPEC_JOB as any)
    vi.mocked(prisma.reviewLog.upsert).mockResolvedValue({} as any)

    const res = await handleSubmitReview(BASE_INPUT)

    expect(res.isError).toBeFalsy()

    // upsert called once with review_job_id unique key
    expect(prisma.reviewLog.upsert).toHaveBeenCalledTimes(1)
    const upsertCall = vi.mocked(prisma.reviewLog.upsert).mock.calls[0][0]
    expect(upsertCall.where).toEqual({ review_job_id: 'job-spec' })
    // create should pin doc_id and doc_revision_id from job
    expect(upsertCall.create).toMatchObject({
      doc_id: 'doc1',
      doc_revision_id: 'rev9',
      task_id: null,
      kind: 'SPEC_REVIEW',
      verdict: 'CHANGES_REQUESTED',
      summary: BASE_INPUT.summary,
    })
    expect(upsertCall.create.findings).toBeDefined()

    // claudeJob.update called with summary trace
    expect(prisma.claudeJob.update).toHaveBeenCalledTimes(1)
    const updateCall = vi.mocked(prisma.claudeJob.update).mock.calls[0][0]
    expect(updateCall.where).toEqual({ id: 'job-spec' })
    expect(updateCall.data.summary).toContain('SPEC_REVIEW')
    expect(updateCall.data.summary).toContain('CHANGES_REQUESTED')
    expect(updateCall.data.summary).toContain('(2 findings)')
  })

  it('7a. TASK_REVIEW happy path: execution found → sprint_task_execution_id set', async () => {
    vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue(TASK_JOB as any)
    vi.mocked(prisma.sprintTaskExecution.findFirst).mockResolvedValue({ id: 'exec7' } as any)
    vi.mocked(prisma.reviewLog.upsert).mockResolvedValue({} as any)

    const res = await handleSubmitReview({
      ...BASE_INPUT,
      job_id: 'job-task',
    })

    expect(res.isError).toBeFalsy()
    expect(prisma.reviewLog.upsert).toHaveBeenCalledTimes(1)
    const upsertCall = vi.mocked(prisma.reviewLog.upsert).mock.calls[0][0]
    expect(upsertCall.where).toEqual({ review_job_id: 'job-task' })
    expect(upsertCall.create).toMatchObject({
      task_id: 'task1',
      sprint_task_execution_id: 'exec7',
      doc_id: null,
      kind: 'TASK_REVIEW',
    })
  })

  it('7b. TASK_REVIEW: execution not found → sprint_task_execution_id null', async () => {
    vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue(TASK_JOB as any)
    vi.mocked(prisma.sprintTaskExecution.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.reviewLog.upsert).mockResolvedValue({} as any)

    const res = await handleSubmitReview({
      ...BASE_INPUT,
      job_id: 'job-task',
    })

    expect(res.isError).toBeFalsy()
    const upsertCall = vi.mocked(prisma.reviewLog.upsert).mock.calls[0][0]
    expect(upsertCall.create).toMatchObject({
      sprint_task_execution_id: null,
    })
  })

  it('8. upsert rejects → tool returns error; claudeJob.update NOT called', async () => {
    vi.mocked(prisma.claudeJob.findUnique).mockResolvedValue(SPEC_JOB as any)
    vi.mocked(prisma.reviewLog.upsert).mockRejectedValue(new Error('DB connection lost'))

    const res = await handleSubmitReview(BASE_INPUT)

    expect(res.isError).toBe(true)
    expect(prisma.claudeJob.update).not.toHaveBeenCalled()
  })
})
