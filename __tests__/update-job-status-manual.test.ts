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
  triggerPush: vi.fn(),
}))

vi.mock('../src/auth.js', () => authMocks)
vi.mock('../src/git/job-locks.js', () => jobLockMocks)
vi.mock('../src/lib/push-trigger.js', () => pushMocks)
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
}

describe('update_job_status manual jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMocks.requireWriteAccess.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' })
    pgMocks.connect.mockResolvedValue(undefined)
    pgMocks.query.mockResolvedValue({ rows: [] })
    pgMocks.end.mockResolvedValue(undefined)
    jobLockMocks.releaseLocksOnTerminal.mockResolvedValue(undefined)
    pushMocks.triggerPush.mockResolvedValue(undefined)
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      id: 'job-manual',
      status: 'CLAIMED',
      claimed_at: new Date('2026-05-27T10:00:00.000Z'),
      started_at: null,
      claimed_by_token_id: 'token-1',
      user_id: 'user-1',
      product_id: 'prod-1',
      task_id: null,
      idea_id: null,
      sprint_run_id: null,
      kind: 'PLAN_CHAT',
      runtime: 'CLAUDE',
      source: 'MANUAL',
      verify_result: null,
      task: null,
    })
    mockPrisma.claudeJob.update.mockResolvedValue({
      id: 'job-manual',
      status: 'DONE',
      branch: null,
      pushed_at: null,
      pr_url: null,
      verify_result: null,
      summary: 'Manual job finished.',
      error: null,
      started_at: new Date('2026-05-27T10:01:00.000Z'),
      finished_at: new Date('2026-05-27T10:02:00.000Z'),
      head_sha: null,
    })
    mockPrisma.claudeJob.count.mockResolvedValue(0)
  })

  it('marks a manual job done without task verify or git push', async () => {
    let handler: ((input: { job_id: string; status: 'done'; summary: string }) => Promise<unknown>) | null = null
    registerUpdateJobStatusTool({
      registerTool: (_name: string, _config: unknown, callback: typeof handler) => {
        handler = callback
      },
    } as never)

    const result = await handler!({
      job_id: 'job-manual',
      status: 'done',
      summary: 'Manual job finished.',
    })

    expect(result).toMatchObject({
      structuredContent: {
        job_id: 'job-manual',
        status: 'done',
        summary: 'Manual job finished.',
      },
    })
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-manual' },
      data: expect.objectContaining({ status: 'DONE', summary: 'Manual job finished.' }),
    }))
    expect(jobLockMocks.releaseLocksOnTerminal).toHaveBeenCalledWith('job-manual')
  })
})
