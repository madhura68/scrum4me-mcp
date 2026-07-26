import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { agentMessage: { findMany: vi.fn() } },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})
vi.mock('../src/queue/claim.js', () => ({ claimNextReply: vi.fn() }))
vi.mock('../src/queue/listen.js', () => ({
  QUEUE_POLL_INTERVAL_MS: 5_000,
  openQueueListener: vi.fn(),
  waitForQueueWakeup: vi.fn(),
}))
vi.mock('../src/presence/instance.js', () => ({ getInstanceId: vi.fn(() => 'inst-1') }))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { claimNextReply } from '../src/queue/claim.js'
import { openQueueListener, waitForQueueWakeup } from '../src/queue/listen.js'
import { registerQueueWaitReplyTool } from '../src/tools/queue-wait-reply.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as { agentMessage: { findMany: ReturnType<typeof vi.fn> } }
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockClaim = claimNextReply as ReturnType<typeof vi.fn>
const mockOpen = openQueueListener as ReturnType<typeof vi.fn>
const mockWakeup = waitForQueueWakeup as ReturnType<typeof vi.fn>

type ToolResult = { isError?: boolean; content: { text: string }[] }
type Extra = { signal?: AbortSignal }

function makeServer() {
  let handler: (args: Record<string, unknown>, extra?: Extra) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>, extra?: Extra) => handler(args, extra) as Promise<ToolResult>,
  }
  registerQueueWaitReplyTool(server as unknown as McpServer)
  return server
}

const REQ_A = 'aaaaaaaa-0000-4000-8000-0000000000a1'
const REQ_B = 'aaaaaaaa-0000-4000-8000-0000000000b1'

function reply(id: string, inReplyTo: string) {
  return {
    id,
    type: 'data',
    from_server: 'scrum4me-server',
    from_model: 'claude',
    to_server: 'mac',
    to_model: 'claude',
    body: `antwoord op ${inReplyTo}`,
    meta: {},
    source: 'cli',
    status: 'done',
    in_reply_to: inReplyTo,
    error: null,
    claimed_by: 'mcp:inst-1',
    claimed_at: new Date(),
    started_at: new Date(),
    finished_at: new Date(),
    created_at: new Date(),
  }
}
const REPLY_A = reply('aaaaaaaa-0000-4000-8000-0000000000a2', REQ_A)
const REPLY_B = reply('aaaaaaaa-0000-4000-8000-0000000000b2', REQ_B)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('S4M_SERVER', 'mac')
  vi.stubEnv('S4M_MODEL', 'claude')
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
  mockPrisma.agentMessage.findMany.mockResolvedValue([])
  mockClaim.mockResolvedValue(null)
  mockOpen.mockResolvedValue({ end: vi.fn().mockResolvedValue(undefined) })
  mockWakeup.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllEnvs())

describe('queue_wait_reply — §5.2', () => {
  it('idempotente read: al-done replies komen direct terug, elk met in_reply_to', async () => {
    mockPrisma.agentMessage.findMany.mockResolvedValue([REPLY_A])
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A], wait_seconds: 0 })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('ok')
    expect(body.replies).toHaveLength(1)
    expect(body.replies[0].in_reply_to).toBe(REQ_A)
    expect(body.hint).toContain('Remove answered request-ids')
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith({
      where: {
        in_reply_to: { in: [REQ_A] },
        to_server: 'mac',
        to_model: 'claude',
        status: 'done',
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })
  })

  it('drain: alle nu claimbare replies in één respons (voortgangscontract)', async () => {
    mockClaim
      .mockResolvedValueOnce({ ...REPLY_A, previous_status: 'pending' })
      .mockResolvedValueOnce({ ...REPLY_B, previous_status: 'pending' })
      .mockResolvedValueOnce(null)
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A, REQ_B], wait_seconds: 0 })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('ok')
    expect(body.replies.map((r: { in_reply_to: string }) => r.in_reply_to).sort())
      .toEqual([REQ_A, REQ_B].sort())
  })

  it('dedupliceert op reply-id (idempotente read + drain overlappen nooit dubbel)', async () => {
    mockPrisma.agentMessage.findMany.mockResolvedValue([REPLY_A])
    mockClaim
      .mockResolvedValueOnce({ ...REPLY_A, previous_status: 'pending' })
      .mockResolvedValueOnce(null)
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A], wait_seconds: 0 })
    const body = JSON.parse(result.content[0].text)
    expect(body.replies).toHaveLength(1)
  })

  it('audit-claimedBy is mcp:<instance_id>', async () => {
    mockClaim.mockResolvedValueOnce({ ...REPLY_A, previous_status: 'pending' }).mockResolvedValueOnce(null)
    const server = makeServer()
    await server.call({ message_ids: [REQ_A], wait_seconds: 0 })
    expect(mockClaim).toHaveBeenCalledWith({
      server: 'mac',
      model: 'claude',
      messageIds: [REQ_A],
      claimedBy: 'mcp:inst-1',
    })
  })

  it('wait_seconds 0 zonder replies → status timeout, replies [], géén LISTEN', async () => {
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A], wait_seconds: 0 })
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ status: 'timeout', replies: [] })
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('bounded wait: LISTEN + herclaim na wake-up, listener wordt altijd gesloten', async () => {
    const end = vi.fn().mockResolvedValue(undefined)
    mockOpen.mockResolvedValue({ end })
    mockPrisma.agentMessage.findMany
      .mockResolvedValueOnce([])        // collect 1 (pre-LISTEN)
      .mockResolvedValueOnce([])        // collect 2 (direct na LISTEN)
      .mockResolvedValueOnce([REPLY_A]) // collect 3 (na wake-up)
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A], wait_seconds: 30 })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('ok')
    expect(body.replies[0].id).toBe(REPLY_A.id)
    expect(mockWakeup).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('abort vóór de wait → direct timeout zonder LISTEN', async () => {
    const ac = new AbortController()
    ac.abort()
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A], wait_seconds: 300 }, { signal: ac.signal })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('timeout')
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('QUEUE_IDENTITY_REQUIRED zonder identiteit', async () => {
    vi.stubEnv('S4M_SERVER', '')
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A], wait_seconds: 0 })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_IDENTITY_REQUIRED')
  })
})
