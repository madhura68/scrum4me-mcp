import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { agentMessage: { findMany: vi.fn() } },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { registerQueueListTool } from '../src/tools/queue-list.js'
import { QUEUE_STATUSES, QUEUE_TERMINAL_STATUSES } from '@shared/queue-identity.js'
import { legacyMarkerWhere } from '../src/queue/marked.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as {
  agentMessage: { findMany: ReturnType<typeof vi.fn> }
}
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>

type ToolResult = { isError?: boolean; content: { text: string }[] }

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>) => handler(args) as Promise<ToolResult>,
  }
  registerQueueListTool(server as unknown as McpServer)
  return server
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('S4M_SERVER', 'mac')
  vi.stubEnv('S4M_MODEL', 'claude')
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
  mockPrisma.agentMessage.findMany.mockResolvedValue([])
})
afterEach(() => vi.unstubAllEnvs())

describe('queue_list — §5.7', () => {
  it("default both + niet-terminaal: OR over eigen adres én status in ('pending','claimed')", async () => {
    const server = makeServer()
    await server.call({ direction: 'both', include_terminal: false })
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { from_server: 'mac', from_model: 'claude' },
          { to_server: 'mac', to_model: 'claude' },
        ],
        ...legacyMarkerWhere(),
        status: { in: ['pending', 'claimed'] },
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    })
  })

  it("direction 'sent' filtert alleen op afzender (verloren-handle-herstel)", async () => {
    const server = makeServer()
    await server.call({ direction: 'sent', include_terminal: false })
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ from_server: 'mac', from_model: 'claude' }),
      }),
    )
  })

  it("direction 'received' filtert alleen op geadresseerde", async () => {
    const server = makeServer()
    await server.call({ direction: 'received', include_terminal: false })
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ to_server: 'mac', to_model: 'claude' }),
      }),
    )
  })

  it('include_terminal true laat het statusfilter weg', async () => {
    const server = makeServer()
    await server.call({ direction: 'both', include_terminal: true })
    const arg = mockPrisma.agentMessage.findMany.mock.calls[0][0] as { where: Record<string, unknown> }
    expect(arg.where.status).toBeUndefined()
  })

  it('leidt het niet-terminale filter af uit het gedeelde vocabulaire', async () => {
    // Zelfde klasse als de overgetypte 'as'-enum, maar buiten het schema: de
    // lijst stond hardgecodeerd als ['pending','claimed']. Nu het complement
    // van QUEUE_TERMINAL_STATUSES, zodat een zesde niet-terminale status niet
    // stil buiten de default valt. De pariteitsgate leest inputSchema's en kan
    // dit niet zien; daarom hier, tegen het gedrag van de handler.
    const expected = QUEUE_STATUSES.filter(
      (status) => !(QUEUE_TERMINAL_STATUSES as readonly string[]).includes(status),
    )
    expect(expected).not.toHaveLength(0)
    const server = makeServer()
    await server.call({ direction: 'both', include_terminal: false })
    const arg = mockPrisma.agentMessage.findMany.mock.calls[0][0] as {
      where: { status?: { in: string[] } }
    }
    expect(new Set(arg.where.status?.in)).toEqual(new Set(expected))
  })

  it('sluit terminale berichten uit wanneer include_terminal wordt weggelaten', async () => {
    // De default was op geen van beide niveaus gedekt: elke aanroep gaf de
    // parameter expliciet mee, en de harnas roept de handler direct aan dus
    // Zod's .default(false) wordt nooit doorlopen. Deze test dekt de
    // code-fallback (?? false) door de parameter weg te laten.
    const server = makeServer()
    await server.call({ direction: 'both' })
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { from_server: 'mac', from_model: 'claude' },
          { to_server: 'mac', to_model: 'claude' },
        ],
        ...legacyMarkerWhere(),
        status: { in: ['pending', 'claimed'] },
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    })

    // Tweede, onafhankelijke laag: bewijst de default ook op schema-niveau
    // (voor de MCP SDK's eigen argument-parsing in productie), zonder de
    // tool te wijzigen — de fake server capteert `inputSchema` als
    // onderdeel van de meta die aan registerTool wordt doorgegeven.
    const meta = server.registerTool.mock.calls[0][1] as {
      inputSchema: { parse: (value: unknown) => { include_terminal: boolean } }
    }
    expect(meta.inputSchema.parse({}).include_terminal).toBe(false)
  })

  it('retourneert messageView-rijen + count', async () => {
    mockPrisma.agentMessage.findMany.mockResolvedValue([
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000020',
        type: 'task',
        from_server: 'mac', from_model: 'claude',
        to_server: 'max2', to_model: 'claude',
        body: 'b', meta: {}, source: 'mcp', status: 'pending',
        in_reply_to: null, error: null, claimed_by: null,
        claimed_at: null, started_at: null, finished_at: null, created_at: new Date(),
      },
    ])
    const server = makeServer()
    const result = await server.call({ direction: 'both', include_terminal: false })
    const body = JSON.parse(result.content[0].text)
    expect(body.count).toBe(1)
    expect(body.messages[0].from).toBe('mac:claude')
    expect(body.messages[0].to).toBe('max2:claude')
  })

  it("accepteert as: 'kimi' — schema én eigen adres in de query", async () => {
    // Zie queue-push.test.ts: de overgetypte enum weigerde 'kimi' vóór
    // resolveQueueIdentity. Schema-laag + handler-laag, want het harnas
    // roept de handler rechtstreeks aan en slaat Zod over.
    const server = makeServer()
    const meta = server.registerTool.mock.calls[0][1] as {
      inputSchema: { parse: (value: unknown) => { as?: string } }
    }
    expect(meta.inputSchema.parse({ as: 'kimi' }).as).toBe('kimi')
    expect(() => meta.inputSchema.parse({ as: 'gpt' })).toThrow()

    await server.call({ direction: 'sent', include_terminal: false, as: 'kimi' })
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ from_server: 'mac', from_model: 'kimi' }),
      }),
    )
  })

  it('QUEUE_IDENTITY_REQUIRED zonder identiteit', async () => {
    vi.stubEnv('S4M_MODEL', '')
    const server = makeServer()
    const result = await server.call({ direction: 'both', include_terminal: false })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_IDENTITY_REQUIRED')
  })
})
