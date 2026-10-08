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
    idea: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}))

vi.mock('../src/lib/resolve-entity.js', () => ({
  resolveProductRef: vi.fn().mockResolvedValue({ id: 'prod-9' }),
}))

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { prisma } from '../src/prisma.js'
import { userCanAccessProduct } from '../src/access.js'
import { resolveProductRef } from '../src/lib/resolve-entity.js'
import { handleRecordUsageSegment, registerRecordUsageSegmentTool } from '../src/tools/record-usage-segment.js'
import { toolText } from './helpers/tool-result.js'

const mockPrisma = prisma as unknown as {
  usageSegment: Record<'findUnique' | 'create' | 'updateMany', ReturnType<typeof vi.fn>>
  usageLine: Record<'deleteMany' | 'createMany', ReturnType<typeof vi.fn>>
  task: { findUnique: ReturnType<typeof vi.fn> }
  idea: { findFirst: ReturnType<typeof vi.fn> }
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

const productHeader = {
  id: ID, task_id: null, anchor_task_id: null, product_id: 'SCRUM4ME', session_id: 'session-1',
  started_at: '2026-10-05T10:00:00.000Z', mod_version: '0.3.0',
}
const productClosing = {
  ...productHeader, ended_at: '2026-10-05T10:30:00.000Z', ended_reason: 'session_end' as const, active_ms: 90_000,
  cost_start_usd: 1, cost_end_usd: 1.5, lines: [line],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveProductRef).mockResolvedValue({ id: 'prod-9' })
  vi.mocked(userCanAccessProduct).mockResolvedValue(true)
  mockPrisma.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma))
  mockPrisma.usageSegment.findUnique.mockResolvedValue(null)
  mockPrisma.task.findUnique.mockResolvedValue({ product_id: 'prod-1', sprint_id: 'sprint-1' })
  mockPrisma.usageSegment.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.idea.findFirst.mockResolvedValue({ product_id: 'prod-7' })
})

describe('record_usage_segment validation', () => {
  it.each([
    ['a task segment whose anchor differs', { ...header, anchor_task_id: 'task-2' }],
    ['ended_at without ended_reason', { ...header, ended_at: '2026-10-05T10:30:00.000Z' }],
    ['ended_reason without ended_at', { ...header, ended_reason: 'done' as const }],
    ['ended_at before started_at', { ...closing, ended_at: '2026-10-05T09:00:00.000Z' }],
    ['two lines for one agent and model', { ...closing, lines: [line, line] }],
    ['a product segment that carries a task', { ...productHeader, task_id: 'task-1' }],
    ['a segment without anchor and without product_id', { ...productHeader, product_id: undefined }],
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

  it('rejects a segment without anchor and without product_id as REJECTED text, not an SDK error', async () => {
    const result = await call({ ...productHeader, product_id: undefined })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toMatch(/^USAGE_SEGMENT_REJECTED: /)
    expect(mockPrisma.usageSegment.create).not.toHaveBeenCalled()
  })

  it('stores a closed product segment through the registered schema', async () => {
    const result = await call(productClosing)
    expect(result.isError).not.toBe(true)
    expect(JSON.parse(toolText(result))).toEqual({ id: ID, state: 'closed', effect: 'created' })
    expect(mockPrisma.usageSegment.create.mock.calls[0][0].data.product_id).toBe('prod-9')
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

describe('record_usage_segment product segments', () => {
  it('creates a closed product segment with sprint and anchor null and the resolved product', async () => {
    const result = await handleRecordUsageSegment(productClosing)
    expect(JSON.parse(toolText(result))).toEqual({ id: ID, state: 'closed', effect: 'created' })
    expect(mockPrisma.usageSegment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sprint_id: null, anchor_task_id: null, task_id: null, product_id: 'prod-9', lines: { create: [line] } }),
    })
    expect(resolveProductRef).toHaveBeenCalledWith('SCRUM4ME', 'user-1')
    expect(mockPrisma.task.findUnique).not.toHaveBeenCalled()
  })

  it('rejects an unknown or inaccessible product', async () => {
    vi.mocked(resolveProductRef).mockResolvedValueOnce({ error: 'not found' } as never)
    expect(toolText(await handleRecordUsageSegment(productClosing))).toMatch(/^USAGE_SEGMENT_REJECTED: /)
    vi.mocked(userCanAccessProduct).mockResolvedValueOnce(false)
    expect(toolText(await handleRecordUsageSegment(productClosing))).toMatch(/^USAGE_SEGMENT_REJECTED: /)
    expect(mockPrisma.usageSegment.create).not.toHaveBeenCalled()
  })

  it('ignores product_id when an anchor is given', async () => {
    await handleRecordUsageSegment({ ...header, product_id: 'ANDER' })
    expect(mockPrisma.usageSegment.create.mock.calls[0][0].data.product_id).toBe('prod-1')
    expect(resolveProductRef).not.toHaveBeenCalled()
  })

  it('a repeated closing on an existing closed segment has no effect, also without anchor', async () => {
    mockPrisma.usageSegment.findUnique.mockResolvedValue({ user_id: 'user-1', product_id: 'prod-9', started_at: new Date(productHeader.started_at), ended_at: new Date() })
    expect(JSON.parse(toolText(await handleRecordUsageSegment(productClosing)))).toEqual({ id: ID, state: 'closed', effect: 'none' })
    expect(mockPrisma.usageSegment.create).not.toHaveBeenCalled()
  })
})

// IDEA-242 §6.3: the fourth scope, one phase of working out an idea.
const IDEA = 'cmuzkk0ta01u9o07rc391fve8'
const ideaHeader = {
  id: ID, task_id: null, anchor_task_id: null, idea_id: IDEA, idea_phase: 'spec' as const, session_id: 'session-1',
  started_at: '2026-10-08T10:00:00.000Z', mod_version: '0.5.0',
}
const ideaClosing = {
  ...ideaHeader, ended_at: '2026-10-08T10:20:00.000Z', ended_reason: 'switched' as const, active_ms: 60_000,
  cost_start_usd: 1, cost_end_usd: 1.5, lines: [line],
}
const rejected = async (input: Record<string, unknown>) => toolText(await handleRecordUsageSegment(input))

describe('record_usage_segment idea scope (IDEA-242)', () => {
  it('a header creates an idea segment: product from the idea, no sprint, task or anchor, phase in DB spelling', async () => {
    const result = await handleRecordUsageSegment(ideaHeader)
    expect(JSON.parse(toolText(result))).toEqual({ id: ID, state: 'open', effect: 'created' })
    expect(mockPrisma.idea.findFirst).toHaveBeenCalledWith({ where: { id: IDEA, user_id: 'user-1' }, select: { product_id: true } })
    expect(mockPrisma.usageSegment.create.mock.calls[0][0].data).toEqual({
      id: ID, user_id: 'user-1', product_id: 'prod-7', sprint_id: null, task_id: null, anchor_task_id: null,
      idea_id: IDEA, idea_phase: 'SPEC', session_id: 'session-1', started_at: new Date(ideaHeader.started_at), mod_version: '0.5.0',
    })
  })

  it('a full message creates a closed idea segment', async () => {
    const result = await handleRecordUsageSegment(ideaClosing)
    expect(JSON.parse(toolText(result))).toEqual({ id: ID, state: 'closed', effect: 'created' })
    const data = mockPrisma.usageSegment.create.mock.calls[0][0].data
    expect([data.ended_reason, data.idea_phase, data.reported_cost_usd]).toEqual(['SWITCHED', 'SPEC', '0.5000'])
  })

  it('product_id next to idea_id is ignored: the idea wins', async () => {
    await handleRecordUsageSegment({ ...ideaHeader, product_id: 'ander' })
    expect(mockPrisma.usageSegment.create.mock.calls[0][0].data.product_id).toBe('prod-7')
    expect(vi.mocked(resolveProductRef)).not.toHaveBeenCalled()
  })

  it.each([
    ['idea_id without idea_phase', { ...ideaHeader, idea_phase: undefined }, 'idea_id and idea_phase come together'],
    ['idea_phase without idea_id', { ...ideaHeader, idea_id: undefined }, 'idea_id and idea_phase come together'],
    ['an anchor next to idea_id', { ...ideaHeader, anchor_task_id: 'task-1' }, 'an idea segment has no task or anchor'],
    ['a task next to idea_id', { ...ideaHeader, task_id: 'task-1', anchor_task_id: 'task-1' }, 'an idea segment has no task or anchor'],
  ])('rejects %s', async (_, input, message) => {
    expect(await rejected(input)).toBe(`USAGE_SEGMENT_REJECTED: ${message}`)
    expect(mockPrisma.usageSegment.create).not.toHaveBeenCalled()
  })

  it('rejects an unknown phase through the schema, with the REJECTED prefix', async () => {
    expect(await rejected({ ...ideaHeader, idea_phase: 'review' })).toMatch(/^USAGE_SEGMENT_REJECTED: /)
    expect(mockPrisma.usageSegment.create).not.toHaveBeenCalled()
  })

  it('rejects an idea of another user, an idea without a product, and a product the user cannot reach', async () => {
    mockPrisma.idea.findFirst.mockResolvedValueOnce(null)
    expect(await rejected(ideaHeader)).toBe(`USAGE_SEGMENT_REJECTED: idea ${IDEA} not found or not accessible`)
    mockPrisma.idea.findFirst.mockResolvedValueOnce({ product_id: null })
    expect(await rejected(ideaHeader)).toBe(`USAGE_SEGMENT_REJECTED: idea ${IDEA} has no product`)
    vi.mocked(userCanAccessProduct).mockResolvedValueOnce(false)
    expect(await rejected(ideaHeader)).toBe(`USAGE_SEGMENT_REJECTED: product of idea ${IDEA} not accessible`)
    expect(mockPrisma.usageSegment.create).not.toHaveBeenCalled()
  })

  it('a closing on an existing idea segment closes it like any other', async () => {
    mockPrisma.usageSegment.findUnique.mockResolvedValueOnce({ user_id: 'user-1', product_id: 'prod-7', started_at: new Date(ideaHeader.started_at), ended_at: null })
    const result = await handleRecordUsageSegment(ideaClosing)
    expect(JSON.parse(toolText(result))).toEqual({ id: ID, state: 'closed', effect: 'closed' })
    expect(mockPrisma.idea.findFirst).not.toHaveBeenCalled()
  })
})
