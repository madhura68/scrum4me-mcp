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

// M17 idea-chat: de dedicated transactie krijgt een eigen tx-mock zodat we de
// lock-volgorde en de writes ín de tx kunnen asserten.
const txMocks = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  claudeJob: { update: vi.fn(), create: vi.fn() },
  ideaChatMessage: { create: vi.fn(), findFirst: vi.fn() },
  ideaLog: { create: vi.fn() },
  idea: { update: vi.fn() },
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
    idea: { update: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMocks)),
    $executeRaw: vi.fn(),
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
  idea: { update: ReturnType<typeof vi.fn> }
  $transaction: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
}

function registerHandler() {
  let handler:
    | ((input: { job_id: string; status: 'done' | 'failed'; summary?: string; error?: string }) => Promise<unknown>)
    | null = null
  registerUpdateJobStatusTool({
    registerTool: (_name: string, _config: unknown, callback: typeof handler) => {
      handler = callback
    },
  } as never)
  return handler!
}

const CUTOFF_AT = new Date('2026-07-03T09:59:00.000Z')

const updatedRow = (status: 'DONE' | 'FAILED') => ({
  id: 'job-ideachat',
  status,
  branch: null,
  pushed_at: null,
  pr_url: null,
  verify_result: null,
  summary: status === 'DONE' ? 'Antwoord voor het kanaal.' : null,
  error: status === 'FAILED' ? 'iets mis' : null,
  started_at: new Date('2026-07-03T10:01:00.000Z'),
  finished_at: new Date('2026-07-03T10:02:00.000Z'),
  head_sha: null,
})

describe('update_job_status system IDEA_CHAT jobs', () => {
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
      id: 'job-ideachat',
      status: 'CLAIMED',
      claimed_at: new Date('2026-07-03T10:00:00.000Z'),
      started_at: null,
      claimed_by_token_id: 'token-1',
      user_id: 'user-1',
      product_id: 'prod-1',
      task_id: null,
      idea_id: 'idea-1',
      sprint_run_id: null,
      kind: 'IDEA_CHAT',
      runtime: 'CLAUDE',
      source: 'SYSTEM',
      verify_result: null,
      created_at: new Date('2026-07-03T09:58:00.000Z'),
      chat_cutoff_message_id: 'msg2',
      chat_cutoff_at: CUTOFF_AT,
      task: null,
    })
    mockPrisma.claudeJob.count.mockResolvedValue(0)
    txMocks.$queryRaw.mockResolvedValue([{ id: 'idea-1' }])
    txMocks.claudeJob.update.mockResolvedValue(updatedRow('DONE'))
    txMocks.claudeJob.create.mockResolvedValue({ id: 'job-followup' })
    txMocks.ideaChatMessage.create.mockResolvedValue({ id: 'msg-assistant' })
    txMocks.ideaChatMessage.findFirst.mockResolvedValue(null)
    txMocks.ideaLog.create.mockResolvedValue({ id: 'log-1' })
  })

  it('done: assistant-bericht + status-flip in één tx onder de per-idea lock, geen vervolg-job zonder nieuwe berichten', async () => {
    const handler = registerHandler()

    const result = await handler({
      job_id: 'job-ideachat',
      status: 'done',
      summary: 'Antwoord voor het kanaal.',
    })

    expect(result).toMatchObject({
      structuredContent: { job_id: 'job-ideachat', status: 'done' },
    })
    // Lock als eerste statement in de tx.
    expect(txMocks.$queryRaw).toHaveBeenCalled()
    const lockSql = txMocks.$queryRaw.mock.calls[0][0].join('?')
    expect(lockSql).toContain('FOR UPDATE')
    expect(lockSql).toContain('FROM ideas')
    // Flip + write ín de tx; de losse prisma.claudeJob.update wordt overgeslagen.
    expect(txMocks.claudeJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-ideachat' },
      data: expect.objectContaining({ status: 'DONE', summary: 'Antwoord voor het kanaal.' }),
    }))
    expect(mockPrisma.claudeJob.update).not.toHaveBeenCalled()
    expect(txMocks.ideaChatMessage.create).toHaveBeenCalledWith({
      data: {
        idea_id: 'idea-1',
        role: 'ASSISTANT',
        kind: 'TEXT',
        content: 'Antwoord voor het kanaal.',
        job_id: 'job-ideachat',
      },
    })
    // Coalescing gecheckt op de gepersisteerde cutoff, geen nieuwe berichten →
    // geen vervolg-job en geen enqueue-notify.
    expect(txMocks.ideaChatMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        idea_id: 'idea-1',
        role: 'USER',
        OR: [
          { created_at: { gt: CUTOFF_AT } },
          { created_at: CUTOFF_AT, id: { gt: 'msg2' } },
        ],
      }),
    }))
    expect(txMocks.claudeJob.create).not.toHaveBeenCalled()
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
  })

  it('done + USER-bericht ná de cutoff → precies één vervolg-job + enqueue-notify', async () => {
    txMocks.ideaChatMessage.findFirst.mockResolvedValue({ id: 'msg-nieuw' })
    const handler = registerHandler()

    await handler({
      job_id: 'job-ideachat',
      status: 'done',
      summary: 'Antwoord voor het kanaal.',
    })

    expect(txMocks.claudeJob.create).toHaveBeenCalledTimes(1)
    expect(txMocks.claudeJob.create).toHaveBeenCalledWith({
      data: {
        user_id: 'user-1',
        product_id: 'prod-1',
        idea_id: 'idea-1',
        kind: 'IDEA_CHAT',
        status: 'QUEUED',
      },
      select: { id: true },
    })
    // notifyJobEnqueued draait buiten de tx via prisma.$executeRaw.
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1)
  })

  it('failed: IdeaLog JOB_EVENT zonder Idea.status-mutatie, coalescing draait wél', async () => {
    txMocks.claudeJob.update.mockResolvedValue(updatedRow('FAILED'))
    txMocks.ideaChatMessage.findFirst.mockResolvedValue({ id: 'msg-nieuw' })
    const handler = registerHandler()

    const result = await handler({
      job_id: 'job-ideachat',
      status: 'failed',
      error: 'iets mis',
    })

    expect(result).toMatchObject({
      structuredContent: { job_id: 'job-ideachat', status: 'failed' },
    })
    expect(txMocks.ideaLog.create).toHaveBeenCalledWith({
      data: {
        idea_id: 'idea-1',
        type: 'JOB_EVENT',
        content: 'IDEA_CHAT failed',
        metadata: { job_id: 'job-ideachat', error: 'iets mis' },
      },
    })
    // Status-neutraal: geen Idea.status-mutatie, in of buiten de tx.
    expect(txMocks.idea.update).not.toHaveBeenCalled()
    expect(mockPrisma.idea.update).not.toHaveBeenCalled()
    expect(txMocks.ideaChatMessage.create).not.toHaveBeenCalled()
    // Coalescing ook bij failed (spec §4.5) → vervolg-job.
    expect(txMocks.claudeJob.create).toHaveBeenCalledTimes(1)
  })

  it('done met lege summary wordt geweigerd zonder writes', async () => {
    const handler = registerHandler()

    const result = await handler({
      job_id: 'job-ideachat',
      status: 'done',
      summary: '   ',
    })

    expect(result).toMatchObject({ isError: true })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(txMocks.claudeJob.update).not.toHaveBeenCalled()
    expect(txMocks.ideaChatMessage.create).not.toHaveBeenCalled()
  })
})
