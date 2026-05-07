import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    sprintRun: { findUnique: vi.fn() },
  },
}))

vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { registerJobHeartbeatTool } from '../src/tools/job-heartbeat.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as {
  $queryRaw: ReturnType<typeof vi.fn>
  sprintRun: { findUnique: ReturnType<typeof vi.fn> }
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
  registerJobHeartbeatTool(server as unknown as McpServer)
  return server
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

describe('job_heartbeat', () => {
  it('returns 403-style error when no row matched (token mismatch / terminal)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([])
    const server = makeServer()
    const result = (await server.call({ job_id: 'job-x' })) as {
      content: { text: string }[]
      isError?: boolean
    }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/not found|terminal|claimed_by/i)
  })

  it('non-SPRINT job returns ok + lease_until without sprint fields', async () => {
    const lease = new Date()
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'job-1',
        lease_until: lease,
        kind: 'TASK_IMPLEMENTATION',
        sprint_run_id: null,
      },
    ])
    const server = makeServer()
    const result = (await server.call({ job_id: 'job-1' })) as {
      content: { text: string }[]
    }
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({
      ok: true,
      job_id: 'job-1',
      lease_until: lease.toISOString(),
      sprint_run_status: null,
      sprint_run_pause_reason: null,
    })
    expect(mockPrisma.sprintRun.findUnique).not.toHaveBeenCalled()
  })

  it('SPRINT job returns sprint_run_status from sibling lookup', async () => {
    const lease = new Date()
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'job-2',
        lease_until: lease,
        kind: 'SPRINT_IMPLEMENTATION',
        sprint_run_id: 'sr-1',
      },
    ])
    mockPrisma.sprintRun.findUnique.mockResolvedValue({
      status: 'PAUSED',
      pause_context: { pause_reason: 'QUOTA_DEPLETED' },
    })

    const server = makeServer()
    const result = (await server.call({ job_id: 'job-2' })) as {
      content: { text: string }[]
    }
    const body = JSON.parse(result.content[0].text)
    expect(body).toMatchObject({
      ok: true,
      sprint_run_status: 'PAUSED',
      sprint_run_pause_reason: 'QUOTA_DEPLETED',
    })
  })

  it('SPRINT job tolerates missing pause_context', async () => {
    const lease = new Date()
    mockPrisma.$queryRaw.mockResolvedValue([
      {
        id: 'job-3',
        lease_until: lease,
        kind: 'SPRINT_IMPLEMENTATION',
        sprint_run_id: 'sr-2',
      },
    ])
    mockPrisma.sprintRun.findUnique.mockResolvedValue({
      status: 'RUNNING',
      pause_context: null,
    })

    const server = makeServer()
    const result = (await server.call({ job_id: 'job-3' })) as {
      content: { text: string }[]
    }
    const body = JSON.parse(result.content[0].text)
    expect(body.sprint_run_status).toBe('RUNNING')
    expect(body.sprint_run_pause_reason).toBeNull()
  })
})
