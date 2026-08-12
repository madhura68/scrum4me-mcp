import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const tx = {
  $queryRaw: vi.fn(),
  agentMessage: { updateMany: vi.fn() },
}
vi.mock('../src/prisma.js', () => ({
  prisma: { $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})

import { requireWriteAccess } from '../src/auth.js'
import { registerQueueArchiveTools } from '../src/tools/queue-archive.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
type ToolResult = { isError?: boolean; content: { text: string }[] }

function makeServer() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
  const server = {
    registerTool: vi.fn((name: string, _meta: unknown, fn: (args: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(name, fn)
    }),
    call: (name: string, args: Record<string, unknown>) =>
      handlers.get(name)!(args) as Promise<ToolResult>,
  }
  registerQueueArchiveTools(server as unknown as McpServer)
  return server
}

const ID = '11111111-1111-4111-8111-111111111111'
const CHILD = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
})
afterEach(() => vi.unstubAllEnvs())

describe('queue_archive', () => {
  it('archiveert de subtree: updateMany op alle ids waar archived_at null is', async () => {
    tx.$queryRaw.mockResolvedValue([
      { id: ID, status: 'done', archived_at: null },
      { id: CHILD, status: 'done', archived_at: null },
    ])
    tx.agentMessage.updateMany.mockResolvedValue({ count: 2 })
    const res = await makeServer().call('queue_archive', { message_id: ID })
    expect(res.isError).toBeFalsy()
    expect(tx.agentMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [ID, CHILD] }, archived_at: null },
      data: { archived_at: expect.any(Date) },
    })
    expect(JSON.parse(res.content[0].text)).toMatchObject({ total: 2, archived: 2 })
  })

  it('QUEUE_NOT_TERMINAL zodra een subtree-rij niet terminaal is', async () => {
    tx.$queryRaw.mockResolvedValue([
      { id: ID, status: 'done', archived_at: null },
      { id: CHILD, status: 'pending', archived_at: null },
    ])
    const res = await makeServer().call('queue_archive', { message_id: ID })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('QUEUE_NOT_TERMINAL')
    expect(res.content[0].text).toContain(CHILD)
    expect(tx.agentMessage.updateMany).not.toHaveBeenCalled()
  })

  it('QUEUE_NOT_FOUND bij onbekend id', async () => {
    tx.$queryRaw.mockResolvedValue([])
    const res = await makeServer().call('queue_archive', { message_id: ID })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('QUEUE_NOT_FOUND')
  })
})

describe('queue_unarchive', () => {
  it('wist archived_at op alle niet-null rijen in de subtree, zonder terminaal-check', async () => {
    tx.$queryRaw.mockResolvedValue([
      { id: ID, status: 'done', archived_at: null },
      { id: CHILD, status: 'done', archived_at: new Date() },
    ])
    tx.agentMessage.updateMany.mockResolvedValue({ count: 1 })
    const res = await makeServer().call('queue_unarchive', { message_id: ID })
    expect(res.isError).toBeFalsy()
    expect(tx.agentMessage.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [ID, CHILD] }, archived_at: { not: null } },
      data: { archived_at: null },
    })
    expect(JSON.parse(res.content[0].text)).toMatchObject({ total: 2, unarchived: 1 })
  })
})
