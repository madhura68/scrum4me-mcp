import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({ prisma: {} }))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})
vi.mock('../src/queue/presence.js', () => ({ readPresenceViews: vi.fn() }))

import { readPresenceViews } from '../src/queue/presence.js'
import { registerQueuePresenceTool } from '../src/tools/queue-presence.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockRead = readPresenceViews as ReturnType<typeof vi.fn>

type ToolResult = { isError?: boolean; content: { text: string }[] }

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<ToolResult>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
  }
  registerQueuePresenceTool(server as unknown as McpServer)
  return {
    server,
    call: (args: Record<string, unknown> = {}) => handler(args),
  }
}

const VIEW = {
  address: 'mac:claude',
  status: 'beschikbaar',
  watcher: { heartbeat_at: '2026-08-30T12:00:00.000Z', age_s: 7, started_at: null, pid: 1, types: [] },
  session: { announced_at: null, last_drain_at: null, signed_off_at: null, expected_by: null },
  claims: { open: 0, oldest_claimed_at: null, message_ids: [] },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('queue_presence (IDEA-194 §6.3)', () => {
  it('registreert read-only en idempotent', () => {
    const { server } = makeServer()
    const [name, meta] = server.registerTool.mock.calls[0] as unknown as [
      string,
      { annotations: Record<string, boolean>; description: string },
    ]
    expect(name).toBe('queue_presence')
    expect(meta.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true })
    // De beschrijving moet zeggen dat presence geen gate is — anders gaan
    // lezers hem als toestemming gebruiken.
    expect(meta.description).toContain('never a gate')
  })

  it('geeft de views door en filtert op server/model', async () => {
    mockRead.mockResolvedValueOnce([VIEW])
    const { call } = makeServer()
    const result = await call({ server: 'mac', model: 'claude' })
    expect(mockRead).toHaveBeenCalledWith({ server: 'mac', model: 'claude' })
    const body = JSON.parse(result.content[0].text)
    expect(body.presence).toEqual([VIEW])
  })

  it('werkt zonder filter', async () => {
    mockRead.mockResolvedValueOnce([])
    const { call } = makeServer()
    const result = await call({})
    expect(mockRead).toHaveBeenCalledWith({ server: undefined, model: undefined })
    expect(JSON.parse(result.content[0].text).presence).toEqual([])
  })
})
