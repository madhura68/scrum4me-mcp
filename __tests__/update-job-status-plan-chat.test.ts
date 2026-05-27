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

describe('update_job_status system PLAN_CHAT jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMocks.requireWriteAccess.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' })
    pgMocks.connect.mockResolvedValue(undefined)
    pgMocks.query.mockResolvedValue({ rows: [] })
    pgMocks.end.mockResolvedValue(undefined)
    jobLockMocks.releaseLocksOnTerminal.mockResolvedValue(undefined)
    pushMocks.pushBranchForJob.mockResolvedValue({ pushed: true })
    pushMocks.triggerPush.mockResolvedValue(undefined)
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      id: 'job-chat',
      status: 'CLAIMED',
      claimed_at: new Date('2026-05-27T10:00:00.000Z'),
      started_at: null,
      claimed_by_token_id: 'token-1',
      user_id: 'user-1',
      product_id: 'prod-1',
      task_id: null,
      idea_id: 'idea-1',
      sprint_run_id: null,
      kind: 'PLAN_CHAT',
      runtime: 'CLAUDE',
      source: 'SYSTEM',
      verify_result: null,
      task: null,
    })
    mockPrisma.claudeJob.update.mockResolvedValue({
      id: 'job-chat',
      status: 'DONE',
      branch: null,
      pushed_at: null,
      pr_url: null,
      verify_result: null,
      summary: 'Dit is het antwoord op de planvraag.',
      error: null,
      started_at: new Date('2026-05-27T10:01:00.000Z'),
      finished_at: new Date('2026-05-27T10:02:00.000Z'),
      head_sha: null,
    })
    mockPrisma.claudeJob.count.mockResolvedValue(0)
    mockPrisma.userQuestion.findFirst.mockResolvedValue({ id: 'question-1' })
    mockPrisma.userQuestion.updateMany.mockResolvedValue({ count: 1 })
  })

  it('marks the latest pending question answered with summary without verify or git push', async () => {
    const handler = registerHandler()

    const result = await handler({
      job_id: 'job-chat',
      status: 'done',
      summary: 'Dit is het antwoord op de planvraag.',
    })

    expect(result).toMatchObject({
      structuredContent: {
        job_id: 'job-chat',
        status: 'done',
        summary: 'Dit is het antwoord op de planvraag.',
      },
    })
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-chat' },
      data: expect.objectContaining({
        status: 'DONE',
        summary: 'Dit is het antwoord op de planvraag.',
      }),
    }))
    expect(mockPrisma.userQuestion.findFirst).toHaveBeenCalledWith({
      where: { idea_id: 'idea-1', status: 'pending' },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    })
    expect(mockPrisma.userQuestion.updateMany).toHaveBeenCalledWith({
      where: { id: 'question-1', status: 'pending' },
      data: { status: 'answered', answer: 'Dit is het antwoord op de planvraag.' },
    })
    expect(jobLockMocks.releaseLocksOnTerminal).toHaveBeenCalledWith('job-chat')
  })

  it('rejects blank done summaries without updating the job or question', async () => {
    const handler = registerHandler()

    const result = await handler({
      job_id: 'job-chat',
      status: 'done',
      summary: '   ',
    })

    expect(result).toMatchObject({ isError: true })
    expect(mockPrisma.claudeJob.update).not.toHaveBeenCalled()
    expect(mockPrisma.userQuestion.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.userQuestion.updateMany).not.toHaveBeenCalled()
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
  })
})
