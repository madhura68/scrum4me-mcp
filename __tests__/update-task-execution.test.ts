import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { registerUpdateTaskExecutionTool } from '../src/tools/update-task-execution.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as {
  sprintTaskExecution: {
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>

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
    },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({
    userId: 'u-1',
    tokenId: TOKEN_ID,
    username: 'agent',
    isDemo: false,
  })
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
