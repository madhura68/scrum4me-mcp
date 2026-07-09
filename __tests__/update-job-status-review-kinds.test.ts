import { beforeEach, describe, expect, it, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({
  requireWriteAccess: vi.fn(),
}))

const pgMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}))

const jobLockMocks = vi.hoisted(() => ({
  releaseLocksOnTerminal: vi.fn(),
}))

const pushMocks = vi.hoisted(() => ({
  pushBranchForJob: vi.fn(),
  triggerPush: vi.fn(),
}))

vi.mock('../src/auth.js', () => authMocks)
vi.mock('../src/git/job-locks.js', () => jobLockMocks)
vi.mock('../src/git/push.js', () => ({ pushBranchForJob: pushMocks.pushBranchForJob }))
vi.mock('../src/lib/push-trigger.js', () => ({ triggerPush: pushMocks.triggerPush }))
vi.mock('pg', () => ({
  Client: vi.fn(function Client() {
    return {
      connect: pgMocks.connect,
      query: pgMocks.query,
      end: pgMocks.end,
    }
  }),
}))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: {
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    userQuestion: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))

import { prisma } from '../src/prisma.js'
import { registerUpdateJobStatusTool } from '../src/tools/update-job-status.js'

const mockPrisma = prisma as unknown as {
  claudeJob: {
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    count: ReturnType<typeof vi.fn>
  }
  userQuestion: {
    findFirst: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
}

function registerHandler() {
  let handler:
    | ((input: { job_id: string; status: 'done'; summary?: string }) => Promise<unknown>)
    | null = null
  registerUpdateJobStatusTool({
    registerTool: (_name: string, _config: unknown, callback: typeof handler) => {
      handler = callback
    },
  } as never)
  return handler!
}

function makeJob(kind: string, id: string) {
  return {
    id,
    status: 'CLAIMED',
    claimed_at: new Date('2026-06-09T10:00:00.000Z'),
    started_at: null,
    claimed_by_token_id: 'token-1',
    user_id: 'user-1',
    product_id: 'prod-1',
    task_id: kind === 'TASK_REVIEW' ? 'task-dummy-1' : null,
    idea_id: kind === 'IDEA_REVIEW_PLAN' ? 'idea-42' : null,
    sprint_run_id: null,
    kind,
    runtime: 'CLAUDE',
    source: 'COPILOT',
    verify_result: null,
    branch: null,
    task: null,
  }
}

function makeUpdatedJob(id: string) {
  return {
    id,
    status: 'DONE',
    branch: null,
    pushed_at: null,
    pr_url: null,
    verify_result: null,
    summary: 'Review completed.',
    error: null,
    started_at: new Date('2026-06-09T10:01:00.000Z'),
    finished_at: new Date('2026-06-09T10:02:00.000Z'),
    head_sha: null,
  }
}

describe('update_job_status COPILOT review jobs — done-gate exemption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMocks.requireWriteAccess.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' })
    pgMocks.connect.mockResolvedValue(undefined)
    pgMocks.query.mockResolvedValue({ rows: [] })
    pgMocks.end.mockResolvedValue(undefined)
    jobLockMocks.releaseLocksOnTerminal.mockResolvedValue(undefined)
    pushMocks.pushBranchForJob.mockResolvedValue({ pushed: true })
    pushMocks.triggerPush.mockResolvedValue(undefined)
    mockPrisma.claudeJob.count.mockResolvedValue(0)
    mockPrisma.userQuestion.findFirst.mockResolvedValue(null)
    mockPrisma.userQuestion.updateMany.mockResolvedValue({ count: 0 })
  })

  it('marks IDEA_REVIEW_PLAN (source=COPILOT) done without hitting the verify-gate', async () => {
    const jobId = 'job-idea-review-copilot'
    mockPrisma.claudeJob.findUnique.mockResolvedValue(makeJob('IDEA_REVIEW_PLAN', jobId))
    mockPrisma.claudeJob.update.mockResolvedValue(makeUpdatedJob(jobId))

    const handler = registerHandler()
    const result = await handler({ job_id: jobId, status: 'done', summary: 'Review completed.' })

    expect(result).not.toMatchObject({ isError: true })
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: jobId },
        data: expect.objectContaining({ status: 'DONE' }),
      }),
    )
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
  })

  it('marks PR_REVIEW (source=COPILOT) done without hitting the verify-gate', async () => {
    const jobId = 'job-pr-review-copilot'
    mockPrisma.claudeJob.findUnique.mockResolvedValue(makeJob('PR_REVIEW', jobId))
    mockPrisma.claudeJob.update.mockResolvedValue(makeUpdatedJob(jobId))

    const handler = registerHandler()
    const result = await handler({ job_id: jobId, status: 'done', summary: 'Review completed.' })

    expect(result).not.toMatchObject({ isError: true })
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: jobId },
        data: expect.objectContaining({ status: 'DONE' }),
      }),
    )
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
  })

  it('marks SPEC_REVIEW (source=COPILOT) done without hitting the verify-gate', async () => {
    const jobId = 'job-spec-review-copilot'
    mockPrisma.claudeJob.findUnique.mockResolvedValue(makeJob('SPEC_REVIEW', jobId))
    mockPrisma.claudeJob.update.mockResolvedValue(makeUpdatedJob(jobId))

    const handler = registerHandler()
    const result = await handler({ job_id: jobId, status: 'done', summary: 'Review completed.' })

    expect(result).not.toMatchObject({ isError: true })
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: jobId },
        data: expect.objectContaining({ status: 'DONE' }),
      }),
    )
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
  })

  it('marks TASK_REVIEW (source=COPILOT) done without hitting the verify-gate', async () => {
    const jobId = 'job-task-review-copilot'
    mockPrisma.claudeJob.findUnique.mockResolvedValue(makeJob('TASK_REVIEW', jobId))
    mockPrisma.claudeJob.update.mockResolvedValue(makeUpdatedJob(jobId))

    const handler = registerHandler()
    const result = await handler({ job_id: jobId, status: 'done', summary: 'Review completed.' })

    expect(result).not.toMatchObject({ isError: true })
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: jobId },
        data: expect.objectContaining({ status: 'DONE' }),
      }),
    )
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
  })

  // M23 E2E-1 regressie: de spec-makers completen via hun sink (update_idea_spec_md)
  // en hebben geen task/worktree/verify_result — zonder exemption zit de agent in
  // een catch-22 (done vereist verify; verify_task_against_plan is niet toegestaan
  // én niet van toepassing) en blijft de job eeuwig CLAIMED hangen.
  it('marks IDEA_MAKE_SPEC (source=COPILOT) done without hitting the verify-gate', async () => {
    const jobId = 'job-idea-make-spec-copilot'
    mockPrisma.claudeJob.findUnique.mockResolvedValue(makeJob('IDEA_MAKE_SPEC', jobId))
    mockPrisma.claudeJob.update.mockResolvedValue(makeUpdatedJob(jobId))

    const handler = registerHandler()
    const result = await handler({ job_id: jobId, status: 'done', summary: 'Spec geschreven.' })

    expect(result).not.toMatchObject({ isError: true })
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: jobId },
        data: expect.objectContaining({ status: 'DONE' }),
      }),
    )
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
  })

  it('marks IDEA_REVISE_SPEC done without hitting the verify-gate (alle sources)', async () => {
    const jobId = 'job-idea-revise-spec-system'
    mockPrisma.claudeJob.findUnique.mockResolvedValue({ ...makeJob('IDEA_REVISE_SPEC', jobId), source: 'SYSTEM' })
    mockPrisma.claudeJob.update.mockResolvedValue(makeUpdatedJob(jobId))

    const handler = registerHandler()
    const result = await handler({ job_id: jobId, status: 'done', summary: 'Spec gereviseerd.' })

    expect(result).not.toMatchObject({ isError: true })
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: jobId },
        data: expect.objectContaining({ status: 'DONE' }),
      }),
    )
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
  })

  // Regression guard: the ORCHESTRATOR exclusion applies ONLY to the review kinds.
  // IDEA_GRILL / IDEA_MAKE_PLAN stay exempt for ALL sources (incl. ORCHESTRATOR),
  // exactly as before this fix.
  it('keeps IDEA_GRILL exempt even for source=ORCHESTRATOR', async () => {
    const jobId = 'job-idea-grill-orchestrator'
    mockPrisma.claudeJob.findUnique.mockResolvedValue({ ...makeJob('IDEA_GRILL', jobId), source: 'ORCHESTRATOR' })
    mockPrisma.claudeJob.update.mockResolvedValue(makeUpdatedJob(jobId))

    const handler = registerHandler()
    const result = await handler({ job_id: jobId, status: 'done', summary: 'Grill completed.' })

    expect(result).not.toMatchObject({ isError: true })
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: jobId },
        data: expect.objectContaining({ status: 'DONE' }),
      }),
    )
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
  })
})
