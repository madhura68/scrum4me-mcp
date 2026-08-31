import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    sprintTaskExecution: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})

vi.mock('../src/git/branch-safety.js', () => ({
  resolveWorktreeHead: vi.fn(),
  maybeBackupPush: vi.fn(),
}))

import * as path from 'node:path'
import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { resolveWorktreeHead, maybeBackupPush } from '../src/git/branch-safety.js'
import { registerUpdateTaskExecutionTool } from '../src/tools/update-task-execution.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as {
  sprintTaskExecution: {
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockResolveHead = resolveWorktreeHead as unknown as ReturnType<typeof vi.fn>
const mockBackupPush = maybeBackupPush as unknown as ReturnType<typeof vi.fn>

const TOKEN_ID = 'tok-owner'

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>) => handler(args),
  }
  registerUpdateTaskExecutionTool(server as unknown as McpServer)
  return server
}

function execRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec-1',
    sprint_job_id: 'job-1',
    sprint_job: {
      claimed_by_token_id: TOKEN_ID,
      status: 'CLAIMED',
      kind: 'SPRINT_IMPLEMENTATION',
      branch: 'feat/sprint-x',
    },
    ...overrides,
  }
}

const originalWorktreeDir = process.env.SCRUM4ME_AGENT_WORKTREE_DIR

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
  mockResolveHead.mockResolvedValue(null)
  mockBackupPush.mockResolvedValue('pushed')
  mockAuth.mockResolvedValue({
    userId: 'u-1',
    tokenId: TOKEN_ID,
    username: 'agent',
    isDemo: false,
  })
})

afterEach(() => {
  process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalWorktreeDir
})

describe('update_task_execution', () => {
  it('rejects when execution not found', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(null)
    const server = makeServer()
    const result = (await server.call({
      execution_id: 'missing',
      status: 'RUNNING',
    })) as { content: { text: string }[]; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/not found/i)
  })

  it('rejects wrong job-kind', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(
      execRecord({
        sprint_job: { claimed_by_token_id: TOKEN_ID, status: 'CLAIMED', kind: 'TASK_IMPLEMENTATION' },
      }),
    )
    const server = makeServer()
    const result = (await server.call({
      execution_id: 'exec-1',
      status: 'RUNNING',
    })) as { content: { text: string }[]; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/SPRINT_IMPLEMENTATION/)
  })

  it('rejects when token does not own the job', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(
      execRecord({
        sprint_job: { claimed_by_token_id: 'other-token', status: 'CLAIMED', kind: 'SPRINT_IMPLEMENTATION' },
      }),
    )
    const server = makeServer()
    const result = (await server.call({
      execution_id: 'exec-1',
      status: 'RUNNING',
    })) as { content: { text: string }[]; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Forbidden/)
  })

  it('rejects when job is in terminal state', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(
      execRecord({
        sprint_job: { claimed_by_token_id: TOKEN_ID, status: 'DONE', kind: 'SPRINT_IMPLEMENTATION' },
      }),
    )
    const server = makeServer()
    const result = (await server.call({
      execution_id: 'exec-1',
      status: 'DONE',
    })) as { content: { text: string }[]; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/terminal/)
  })

  it('writes started_at on RUNNING', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(execRecord())
    mockPrisma.sprintTaskExecution.update.mockResolvedValue({
      id: 'exec-1',
      status: 'RUNNING',
      base_sha: null,
      head_sha: null,
      verify_result: null,
      verify_summary: null,
      skip_reason: null,
      started_at: new Date(),
      finished_at: null,
    })

    const server = makeServer()
    await server.call({ execution_id: 'exec-1', status: 'RUNNING' })

    const updateCall = mockPrisma.sprintTaskExecution.update.mock.calls[0][0]
    expect(updateCall.data.status).toBe('RUNNING')
    expect(updateCall.data.started_at).toBeInstanceOf(Date)
    expect(updateCall.data.finished_at).toBeUndefined()
  })

  it('writes finished_at on DONE/FAILED/SKIPPED', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(execRecord())
    mockPrisma.sprintTaskExecution.update.mockResolvedValue({
      id: 'exec-1',
      status: 'DONE',
      base_sha: 'sha-base',
      head_sha: 'sha-head',
      verify_result: null,
      verify_summary: null,
      skip_reason: null,
      started_at: new Date(),
      finished_at: new Date(),
    })

    const server = makeServer()
    await server.call({
      execution_id: 'exec-1',
      status: 'DONE',
      head_sha: 'sha-head',
    })

    const updateCall = mockPrisma.sprintTaskExecution.update.mock.calls[0][0]
    expect(updateCall.data.status).toBe('DONE')
    expect(updateCall.data.finished_at).toBeInstanceOf(Date)
    expect(updateCall.data.head_sha).toBe('sha-head')
  })

  it('persists skip_reason on SKIPPED', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(execRecord())
    mockPrisma.sprintTaskExecution.update.mockResolvedValue({
      id: 'exec-1',
      status: 'SKIPPED',
      base_sha: null,
      head_sha: null,
      verify_result: null,
      verify_summary: null,
      skip_reason: 'no-op task',
      started_at: null,
      finished_at: new Date(),
    })

    const server = makeServer()
    await server.call({
      execution_id: 'exec-1',
      status: 'SKIPPED',
      skip_reason: 'no-op task',
    })

    const updateCall = mockPrisma.sprintTaskExecution.update.mock.calls[0][0]
    expect(updateCall.data.skip_reason).toBe('no-op task')
    expect(updateCall.data.finished_at).toBeInstanceOf(Date)
  })
})

// M38 T3 — spec §3.1: server-side head_sha + taakgrens-backup-push
describe('update_task_execution — taakgrens-backup (M38)', () => {
  const sprintExec = () => execRecord({ sprint_job_id: 'job-sprint-1' })

  function stubUpdate(status: string) {
    mockPrisma.sprintTaskExecution.update.mockResolvedValue({
      id: 'exec-1',
      status,
      base_sha: null,
      head_sha: null,
      verify_result: null,
      verify_summary: null,
      skip_reason: null,
      started_at: null,
      finished_at: new Date(),
    })
  }

  it('DONE zonder caller-head_sha persisteert de server-side HEAD', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(sprintExec())
    stubUpdate('DONE')
    mockResolveHead.mockResolvedValue('abc123')

    const server = makeServer()
    await server.call({ execution_id: 'exec-1', status: 'DONE' })

    expect(mockResolveHead).toHaveBeenCalledWith(path.join('/wt', 'job-sprint-1'))
    expect(mockPrisma.sprintTaskExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ head_sha: 'abc123' }) }),
    )
  })

  it('caller-head_sha wint van de server-side resolve', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(sprintExec())
    stubUpdate('DONE')

    const server = makeServer()
    await server.call({ execution_id: 'exec-1', status: 'DONE', head_sha: 'caller-sha' })

    expect(mockPrisma.sprintTaskExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ head_sha: 'caller-sha' }) }),
    )
    expect(mockResolveHead).not.toHaveBeenCalled()
  })

  it('DONE triggert de taakgrens-push met branch en worktreePath', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(sprintExec())
    stubUpdate('DONE')

    const server = makeServer()
    await server.call({ execution_id: 'exec-1', status: 'DONE' })

    expect(mockBackupPush).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: path.join('/wt', 'job-sprint-1'),
        branchName: 'feat/sprint-x',
      }),
    )
  })

  it('RUNNING pusht niet en resolvet geen HEAD', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(sprintExec())
    stubUpdate('RUNNING')

    const server = makeServer()
    await server.call({ execution_id: 'exec-1', status: 'RUNNING' })

    expect(mockBackupPush).not.toHaveBeenCalled()
    expect(mockResolveHead).not.toHaveBeenCalled()
  })

  it('pusht niet wanneer de job geen branch heeft', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(
      execRecord({
        sprint_job_id: 'job-sprint-1',
        sprint_job: {
          claimed_by_token_id: TOKEN_ID,
          status: 'CLAIMED',
          kind: 'SPRINT_IMPLEMENTATION',
          branch: null,
        },
      }),
    )
    stubUpdate('DONE')

    const server = makeServer()
    await server.call({ execution_id: 'exec-1', status: 'DONE' })

    expect(mockBackupPush).not.toHaveBeenCalled()
  })

  it('een pushfout blokkeert de statusovergang niet', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(sprintExec())
    stubUpdate('DONE')
    // defensief: maybeBackupPush hoort nooit te throwen
    mockBackupPush.mockRejectedValue(new Error('boom'))

    const server = makeServer()
    const res = (await server.call({ execution_id: 'exec-1', status: 'DONE' })) as {
      isError?: boolean
    }

    expect(res.isError).toBeFalsy()
  })
})
