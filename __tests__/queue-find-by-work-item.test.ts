import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { agentMessage: { findMany: vi.fn() } },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { registerQueueFindByWorkItemTool } from '../src/tools/queue-find-by-work-item.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AnyMock } from './helpers/mocks.js'

const mockFindMany = prisma.agentMessage.findMany as AnyMock
const mockAuth = requireWriteAccess as AnyMock
const mockAccess = userCanAccessProduct as AnyMock

type ToolResult = { isError?: boolean; content: { text: string }[] }

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>) => handler(args) as Promise<ToolResult>,
  }
  registerQueueFindByWorkItemTool(server as unknown as McpServer)
  return server
}

function msg(id: string, meta: unknown, createdAt: string, inReplyTo: string | null = null) {
  return {
    id, type: inReplyTo ? 'result' : 'task',
    from_server: 'mac', from_model: 'claude', to_server: 'max2', to_model: 'claude',
    body: `body-${id}`, meta, status: 'done', in_reply_to: inReplyTo,
    error: null, claimed_by: null, archived_at: null,
    created_at: new Date(createdAt), finished_at: null,
  }
}
const wi = (product_id: string, rest: Record<string, string> = {}) => ({ work_item: { product_id, ...rest } })

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'u1', tokenId: 't', username: 'agent', isDemo: false, scopedProducts: [] })
  mockAccess.mockResolvedValue(true)
  mockFindMany.mockResolvedValue([])
})

describe('queue_find_by_work_item', () => {
  it('weigert een aanroep zonder enig id', async () => {
    const server = makeServer()
    const result = await server.call({})
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/VALIDATION_ERROR.*minstens één/)
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('bouwt een AND-filter over jsonb-paden voor elk gegeven id + archived-default', async () => {
    const server = makeServer()
    await server.call({ story_id: 's1', sprint_id: 'sp1' })
    const where = mockFindMany.mock.calls[0][0].where
    expect(where.AND).toEqual(expect.arrayContaining([
      { meta: { path: ['work_item', 'story_id'], equals: 's1' } },
      { meta: { path: ['work_item', 'sprint_id'], equals: 'sp1' } },
    ]))
    expect(where.archived_at).toBeNull()
    expect(mockFindMany.mock.calls[0][0].take).toBe(100)
    expect(mockFindMany.mock.calls[0][0].orderBy).toEqual({ created_at: 'desc' })
  })

  it('include_archived: true laat het archived-filter weg in match- én reply-query', async () => {
    mockFindMany
      .mockResolvedValueOnce([msg('m1', wi('p1', { story_id: 's1' }), '2026-08-20T10:00:00Z')])
      .mockResolvedValueOnce([])
    const server = makeServer()
    await server.call({ story_id: 's1', include_archived: true })
    expect(mockFindMany.mock.calls[0][0].where).not.toHaveProperty('archived_at')
    expect(mockFindMany.mock.calls[1][0].where).not.toHaveProperty('archived_at')
  })

  it('productguard: ontoegankelijk product en blok zonder product_id vallen af', async () => {
    mockFindMany
      .mockResolvedValueOnce([
        msg('m-ok', wi('p-toegang', { story_id: 's1' }), '2026-08-20T10:00:00Z'),
        msg('m-dicht', wi('p-dicht', { story_id: 's1' }), '2026-08-20T09:00:00Z'),
        msg('m-kaal', { work_item: { story_id: 's1' } }, '2026-08-20T08:00:00Z'),
      ])
      .mockResolvedValueOnce([])
    mockAccess.mockImplementation(async (pid: string) => pid === 'p-toegang')
    const server = makeServer()
    const result = await server.call({ story_id: 's1' })
    const body = JSON.parse(result.content[0].text)
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(['m-ok'])
    expect(mockAccess).toHaveBeenCalledWith('p-toegang', 'u1')
    // De reply-query mag alleen ids van overlevende matches bevatten:
    expect(mockFindMany.mock.calls[1][0].where.in_reply_to).toEqual({ in: ['m-ok'] })
  })

  it('voegt directe replies bij (zonder eigen work_item) met het archived-predicaat', async () => {
    mockFindMany
      .mockResolvedValueOnce([msg('req1', wi('p1', { task_id: 't1' }), '2026-08-20T10:00:00Z')])
      .mockResolvedValueOnce([msg('rep1', {}, '2026-08-20T11:00:00Z', 'req1')])
    const server = makeServer()
    const result = await server.call({ task_id: 't1' })
    const body = JSON.parse(result.content[0].text)
    expect(body.count).toBe(2)
    // Sortering created_at desc over matches + replies samen:
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(['rep1', 'req1'])
    expect(mockFindMany.mock.calls[1][0].where.archived_at).toBeNull()
  })

  it('geen replies-query wanneer geen match overleeft', async () => {
    mockFindMany.mockResolvedValueOnce([])
    const server = makeServer()
    const result = await server.call({ task_id: 't1' })
    expect(mockFindMany).toHaveBeenCalledTimes(1)
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ count: 0, truncated: false, messages: [] })
  })

  it('truncated: true wanneer de match-query de cap van 100 raakt', async () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      msg(`m${i}`, wi('p1', { sprint_id: 'sp1' }), `2026-08-19T${String(10 + (i % 12)).padStart(2, '0')}:00:00Z`))
    mockFindMany.mockResolvedValueOnce(many).mockResolvedValueOnce([])
    const server = makeServer()
    const result = await server.call({ sprint_id: 'sp1' })
    expect(JSON.parse(result.content[0].text).truncated).toBe(true)
  })

  it('registreert read-only annotaties en noemt de retentiegrens in de description', () => {
    const server = makeServer()
    const meta = server.registerTool.mock.calls[0][1] as {
      description: string
      annotations: { readOnlyHint: boolean; idempotentHint: boolean }
    }
    expect(server.registerTool.mock.calls[0][0]).toBe('queue_find_by_work_item')
    expect(meta.annotations).toEqual({ readOnlyHint: true, idempotentHint: true })
    expect(meta.description).toContain('S4M_RETENTION_DAYS')
    expect(meta.description).toContain('60')
  })
})
