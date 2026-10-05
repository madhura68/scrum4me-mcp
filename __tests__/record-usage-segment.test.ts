import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn().mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' }),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/access.js', () => ({
  userCanAccessProduct: vi.fn().mockResolvedValue(true),
}))
vi.mock('../src/prisma.js', () => ({
  prisma: {
    usageSegment: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    usageLine: { deleteMany: vi.fn(), createMany: vi.fn() },
    task: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}))

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { prisma } from '../src/prisma.js'
import { userCanAccessProduct } from '../src/access.js'
import { handleRecordUsageSegment, registerRecordUsageSegmentTool } from '../src/tools/record-usage-segment.js'
import { toolText } from './helpers/tool-result.js'

const mockPrisma = prisma as unknown as {
  usageSegment: Record<'findUnique' | 'create' | 'updateMany', ReturnType<typeof vi.fn>>
  usageLine: Record<'deleteMany' | 'createMany', ReturnType<typeof vi.fn>>
  task: { findUnique: ReturnType<typeof vi.fn> }
  $transaction: ReturnType<typeof vi.fn>
}

const ID = '7d5c0a52-8a33-4c8e-9a0e-2f3b1c4d5e6f'
const header = {
  id: ID, task_id: 'task-1', anchor_task_id: 'task-1', session_id: 'session-1',
  started_at: '2026-10-05T10:00:00.000Z', mod_version: '0.2.0',
}
const line = {
  agent_key: 'main', agent_label: 'main', model_id: 'claude-opus-5-5',
  input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40, requests: 2,
}
const closing = {
  ...header, ended_at: '2026-10-05T10:30:00.000Z', ended_reason: 'done' as const, active_ms: 600_000,
  cost_start_usd: 1.25, cost_end_usd: 3.5, lines: [line],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(userCanAccessProduct).mockResolvedValue(true)
  mockPrisma.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma))
  mockPrisma.usageSegment.findUnique.mockResolvedValue(null)
  mockPrisma.task.findUnique.mockResolvedValue({ product_id: 'prod-1', sprint_id: 'sprint-1' })
  mockPrisma.usageSegment.updateMany.mockResolvedValue({ count: 1 })
})

describe('record_usage_segment validation', () => {
  it.each([
    ['a task segment whose anchor differs', { ...header, anchor_task_id: 'task-2' }],
    ['ended_at without ended_reason', { ...header, ended_at: '2026-10-05T10:30:00.000Z' }],
    ['ended_reason without ended_at', { ...header, ended_reason: 'done' as const }],
    ['ended_at before started_at', { ...closing, ended_at: '2026-10-05T09:00:00.000Z' }],
    ['two lines for one agent and model', { ...closing, lines: [line, line] }],
  ])('rejects %s permanently', async (_name, input) => {
    const result = await handleRecordUsageSegment(input)
    expect(toolText(result)).toMatch(/^USAGE_SEGMENT_REJECTED: /)
    expect(mockPrisma.usageSegment.create).not.toHaveBeenCalled()
  })
})

// Through a real MCP client: the SDK must not reject invalid input before the handler, or the
// error would lack the REJECTED prefix and the mod's outbox would retry it forever.
describe('record_usage_segment over MCP tools/call', () => {
  const call = async (args: Record<string, unknown>) => {
    const server = new McpServer({ name: 'test', version: '0' })
    registerRecordUsageSegmentTool(server)
    const client = new Client({ name: 'test-client', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      return (await client.callTool({ name: 'record_usage_segment', arguments: args })) as CallToolResult
    } finally {
      await client.close()
    }
  }

  it.each([
    ['a negative active_ms', { ...closing, active_ms: -1 }],
    ['an id that is not a uuid', { ...header, id: 'not-a-uuid' }],
    ['a missing mod_version', { ...header, mod_version: undefined }],
    ['an unknown ended_reason', { ...closing, ended_reason: 'in_progress' }],
    ['more than 50 lines', { ...closing, lines: Array.from({ length: 51 }, (_, i) => ({ ...line, agent_key: `a${i}` })) }],
  ])('rejects %s permanently', async (_name, args) => {
    const result = await call(args as Record<string, unknown>)
    expect(result.isError).toBe(true)
    expect(toolText(result)).toMatch(/^USAGE_SEGMENT_REJECTED: /)
    expect(mockPrisma.usageSegment.create).not.toHaveBeenCalled()
  })

  it('stores a valid header', async () => {
    const result = await call(header)
    expect(result.isError).not.toBe(true)
    expect(JSON.parse(toolText(result))).toEqual({ id: ID, state: 'open', effect: 'created' })
  })
})

describe('record_usage_segment new segment', () => {
  it('fixes owner, product and sprint from the anchor', async () => {
    const result = await handleRecordUsageSegment(header)
    expect(JSON.parse(toolText(result))).toEqual({ id: ID, state: 'open', effect: 'created' })
    expect(mockPrisma.usageSegment.create.mock.calls[0][0].data).toEqual({
      id: ID, user_id: 'user-1', product_id: 'prod-1', sprint_id: 'sprint-1', task_id: 'task-1',
      anchor_task_id: 'task-1', session_id: 'session-1', started_at: new Date(header.started_at), mod_version: '0.2.0',
    })
  })

  it('maps ended_reason to the DB spelling and computes the reported cost from the two readings', async () => {
    const reasons = { done: 'DONE', todo: 'TO_DO', review: 'REVIEW', failed: 'FAILED', excluded: 'EXCLUDED', switched: 'SWITCHED', session_end: 'SESSION_END', untracked: 'UNTRACKED' } as const
    for (const [api, db] of Object.entries(reasons)) {
      mockPrisma.usageSegment.create.mockClear()
      await handleRecordUsageSegment({ ...closing, ended_reason: api as keyof typeof reasons })
      const data = mockPrisma.usageSegment.create.mock.calls[0][0].data
      expect(data.ended_reason).toBe(db)
      expect(data.reported_cost_usd).toBe('2.2500')
      expect(data.lines).toEqual({ create: [line] })
    }
  })

  it('leaves the reported cost empty when a reading is missing', async () => {
    await handleRecordUsageSegment({ ...closing, cost_start_usd: null })
    expect(mockPrisma.usageSegment.create.mock.calls[0][0].data.reported_cost_usd).toBeNull()
  })

  it('rejects an anchor without sprint, an unknown anchor and an inaccessible one', async () => {
    mockPrisma.task.findUnique.mockResolvedValueOnce({ product_id: 'prod-1', sprint_id: null })
    expect(toolText(await handleRecordUsageSegment(header))).toMatch(/^USAGE_SEGMENT_REJECTED: .*no sprint/)
    mockPrisma.task.findUnique.mockResolvedValueOnce(null)
    expect(toolText(await handleRecordUsageSegment(header))).toMatch(/^USAGE_SEGMENT_REJECTED: .*not found/)
    vi.mocked(userCanAccessProduct).mockResolvedValueOnce(false)
    expect(toolText(await handleRecordUsageSegment(header))).toMatch(/^USAGE_SEGMENT_REJECTED: /)
    expect(mockPrisma.usageSegment.create).not.toHaveBeenCalled()
  })

  it('handles a concurrent create of the same id as an existing segment', async () => {
    mockPrisma.usageSegment.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
    mockPrisma.usageSegment.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ user_id: 'user-1', product_id: 'prod-1', started_at: new Date(header.started_at), ended_at: null })
    const result = await handleRecordUsageSegment(closing)
    expect(JSON.parse(toolText(result))).toEqual({ id: ID, state: 'closed', effect: 'closed' })
    expect(mockPrisma.usageSegment.updateMany).toHaveBeenCalledTimes(1)
  })
})

describe('record_usage_segment existing segment', () => {
  it('rejects another user before looking at the lifecycle, also on a closed segment (RR4-6)', async () => {
    mockPrisma.usageSegment.findUnique.mockResolvedValue({ user_id: 'user-2', product_id: 'prod-1', started_at: new Date(header.started_at), ended_at: new Date() })
    const result = await handleRecordUsageSegment(closing)
    expect(toolText(result)).toMatch(/^USAGE_SEGMENT_REJECTED: /)
    expect(mockPrisma.usageSegment.updateMany).not.toHaveBeenCalled()
  })

  it('a header on an existing segment has no effect', async () => {
    mockPrisma.usageSegment.findUnique.mockResolvedValue({ user_id: 'user-1', product_id: 'prod-1', started_at: new Date(header.started_at), ended_at: null })
    expect(JSON.parse(toolText(await handleRecordUsageSegment(header)))).toEqual({ id: ID, state: 'open', effect: 'none' })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('any message on a closed segment succeeds without effect', async () => {
    mockPrisma.usageSegment.findUnique.mockResolvedValue({ user_id: 'user-1', product_id: 'prod-1', started_at: new Date(header.started_at), ended_at: new Date() })
    expect(JSON.parse(toolText(await handleRecordUsageSegment(closing)))).toEqual({ id: ID, state: 'closed', effect: 'none' })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('closes an open segment and replaces its lines in one transaction, without touching the anchor task', async () => {
    mockPrisma.usageSegment.findUnique.mockResolvedValue({ user_id: 'user-1', product_id: 'prod-1', started_at: new Date(header.started_at), ended_at: null })
    const result = await handleRecordUsageSegment(closing)
    expect(JSON.parse(toolText(result))).toEqual({ id: ID, state: 'closed', effect: 'closed' })
    expect(mockPrisma.usageSegment.updateMany).toHaveBeenCalledWith({
      where: { id: ID, ended_at: null },
      data: { ended_at: new Date(closing.ended_at), ended_reason: 'DONE', active_ms: 600_000, reported_cost_usd: '2.2500' },
    })
    expect(mockPrisma.usageLine.createMany).toHaveBeenCalledWith({ data: [{ ...line, segment_id: ID }] })
    expect(mockPrisma.task.findUnique).not.toHaveBeenCalled()
  })

  it('rejects a closing that ends before the stored start, whatever start the message carries', async () => {
    mockPrisma.usageSegment.findUnique.mockResolvedValue({
      user_id: 'user-1', product_id: 'prod-1', started_at: new Date('2026-10-05T10:00:00.000Z'), ended_at: null,
    })
    const early = { ...closing, started_at: '2026-10-05T08:00:00.000Z', ended_at: '2026-10-05T09:00:00.000Z' }
    expect(toolText(await handleRecordUsageSegment(early))).toMatch(/^USAGE_SEGMENT_REJECTED: .*stored started_at/)
    expect(mockPrisma.usageSegment.updateMany).not.toHaveBeenCalled()
  })

  it('a closing that lost the race replaces no lines', async () => {
    mockPrisma.usageSegment.findUnique.mockResolvedValue({ user_id: 'user-1', product_id: 'prod-1', started_at: new Date(header.started_at), ended_at: null })
    mockPrisma.usageSegment.updateMany.mockResolvedValue({ count: 0 })
    expect(JSON.parse(toolText(await handleRecordUsageSegment(closing)))).toEqual({ id: ID, state: 'closed', effect: 'none' })
    expect(mockPrisma.usageLine.deleteMany).not.toHaveBeenCalled()
    expect(mockPrisma.usageLine.createMany).not.toHaveBeenCalled()
  })
})
