import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const pgMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}))

vi.mock('pg', () => ({
  Client: vi.fn(function Client() {
    return {
      connect: pgMocks.connect,
      query: pgMocks.query,
      end: pgMocks.end,
    }
  }),
}))

vi.mock('../src/auth.js', async () => {
  const original = await vi.importActual<typeof import('../src/auth.js')>('../src/auth.js')
  return { ...original, requireWriteAccess: vi.fn() }
})

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeWorker: {
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}))

import { requireWriteAccess } from '../src/auth.js'
import { prisma } from '../src/prisma.js'
import { registerWorkerHeartbeatTool } from '../src/tools/worker-heartbeat.js'

const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockPrisma = prisma as unknown as {
  claudeWorker: {
    updateMany: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
  }
}

type Handler = (input: {
  last_quota_pct: number
  last_quota_check_at?: string
}) => Promise<unknown>

let handler: Handler

function registerTool() {
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: Handler) => {
      handler = fn
    }),
  }
  registerWorkerHeartbeatTool(server as unknown as McpServer)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SCRUM4ME_WORKER_INSTANCE_ID = 'instance-codex-1'
  mockAuth.mockResolvedValue({
    userId: 'user-1',
    tokenId: 'token-1',
    username: 'jan',
    isDemo: false,
  })
  mockPrisma.claudeWorker.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.claudeWorker.findFirst.mockResolvedValue({
    runtime: 'CODEX',
    instance_id: 'instance-codex-1',
  })
  pgMocks.connect.mockResolvedValue(undefined)
  pgMocks.query.mockResolvedValue({ rows: [] })
  pgMocks.end.mockResolvedValue(undefined)
  registerTool()
})

afterEach(() => {
  delete process.env.SCRUM4ME_WORKER_INSTANCE_ID
})

describe('worker_heartbeat realtime payload', () => {
  it('updates and reports the current worker instance runtime', async () => {
    await handler({
      last_quota_pct: 42,
      last_quota_check_at: '2026-05-27T10:00:00.000Z',
    })

    expect(mockPrisma.claudeWorker.updateMany).toHaveBeenCalledWith({
      where: { token_id: 'token-1', instance_id: 'instance-codex-1' },
      data: expect.objectContaining({
        last_quota_pct: 42,
        last_quota_check_at: new Date('2026-05-27T10:00:00.000Z'),
      }),
    })
    expect(mockPrisma.claudeWorker.findFirst).toHaveBeenCalledWith({
      where: { token_id: 'token-1', instance_id: 'instance-codex-1' },
      select: { runtime: true, instance_id: true },
    })

    const payload = JSON.parse(pgMocks.query.mock.calls[0][1][1])
    expect(payload).toMatchObject({
      type: 'claude_worker_heartbeat',
      worker_id: 'token-1',
      user_id: 'user-1',
      token_id: 'token-1',
      instance_id: 'instance-codex-1',
      runtime: 'CODEX',
      last_quota_pct: 42,
      last_quota_check_at: '2026-05-27T10:00:00.000Z',
    })
  })
})
