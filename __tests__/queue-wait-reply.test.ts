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

  it("accepteert as: 'kimi' — schema én eigen adres in de reply-query", async () => {
    // Zie queue-push.test.ts: de overgetypte enum weigerde 'kimi' vóór
    // resolveQueueIdentity. Schema-laag + handler-laag, want het harnas
    // roept de handler rechtstreeks aan en slaat Zod over.
    const server = makeServer()
    const meta = server.registerTool.mock.calls[0][1] as {
      inputSchema: { parse: (value: unknown) => { as?: string } }
    }
    const base = { message_ids: [REQ_A] }
    expect(meta.inputSchema.parse({ ...base, as: 'kimi' }).as).toBe('kimi')
    expect(() => meta.inputSchema.parse({ ...base, as: 'gpt' })).toThrow()

    await server.call({ ...base, wait_seconds: 0, as: 'kimi' })
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ to_server: 'mac', to_model: 'kimi' }),
      }),
    )
    expect(mockClaim).toHaveBeenCalledWith(
      expect.objectContaining({ server: 'mac', model: 'kimi' }),
    )
  })

  it('QUEUE_IDENTITY_REQUIRED zonder identiteit', async () => {
    vi.stubEnv('S4M_SERVER', '')
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A], wait_seconds: 0 })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_IDENTITY_REQUIRED')
  })

  it('gebruikt de standaard wachttijd wanneer wait_seconds ontbreekt', async () => {
    // Schema-niveau: bewijst de exacte default (300) die de MCP SDK's eigen
    // parsing in productie toepast — zelfde precedent als queue-list.test.ts.
    const server = makeServer()
    const meta = server.registerTool.mock.calls[0][1] as {
      inputSchema: { parse: (value: unknown) => { wait_seconds: number } }
    }
    expect(meta.inputSchema.parse({ message_ids: [REQ_A] }).wait_seconds).toBe(300)

    // Code-niveau: de harnas roept de handler direct aan en omzeilt Zod, dus
    // `wait_seconds ?? DEFAULT_WAIT_SECONDS` in de handler is een apart pad met
    // een eigen waarde. "Er werd een keer wakeup aangeroepen" bewijst alleen
    // dát er een werkende, niet-NaN wachttijd was — niet dat die exact 300 is;
    // elk ander getal (bijv. 999999) zou dezelfde losse waarneming opleveren.
    // Om de EXACTE waarde te dwingen: Date.now() gecontroleerd voor precies de
    // twee aanroepen die er hier toe doen — de deadline-berekening en de
    // eerste while-conditie. Bij waitSeconds===300 valt die conditie er meteen
    // uit (0 iteraties, géén wake-up). Een afwijkende fallback laat de
    // conditie waar, dus één extra iteratie. Na die twee gecontroleerde
    // aanroepen valt de spy terug op de echte klok (~1,7 biljoen ms sinds
    // epoch) — die overschrijdt sowieso elke deadline die uit base 0 plus een
    // paar honderdduizend seconden volgt, dus de lus kan hier nooit vastlopen,
    // ongeacht welke waarde een kapotte fallback zou opleveren (in
    // tegenstelling tot mutatie 1's OOM, waar niets de klok liet vorderen).
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValueOnce(0) // deadline = 0 + waitSeconds*1000
      nowSpy.mockReturnValueOnce(300_001) // eerste while-conditie
      const result = await server.call({ message_ids: [REQ_A] })
      const body = JSON.parse(result.content[0].text)
      expect(body).toEqual({ status: 'timeout', replies: [] })
      expect(mockOpen).toHaveBeenCalledTimes(1)
      expect(mockWakeup).not.toHaveBeenCalled()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('geeft de volledige id-set door aan claimNextReply, niet een deelverzameling', async () => {
    // De enige bestaande test die de aanroep-argumenten exact controleert
    // (audit-claimedBy) gebruikt één id. Bij meerdere ids zou een mutatie die
    // er stilletjes eentje laat vallen (of de volgorde omdraait) daar niet
    // door gedekt zijn — en dat maakt precies dat ene verzoek onbeantwoordbaar,
    // wat de mis-routing is die deze tool moet oplossen.
    const server = makeServer()
    await server.call({ message_ids: [REQ_A, REQ_B], wait_seconds: 0 })
    expect(mockClaim).toHaveBeenCalledWith({
      server: 'mac',
      model: 'claude',
      messageIds: [REQ_A, REQ_B],
      claimedBy: 'mcp:inst-1',
    })
  })

  it('geeft bij een verstreken deadline de timeout-vorm terug', async () => {
    // De vroege timeout-tak (wait_seconds===0 / aborted) is al gedekt; de
    // fallback ná het betreden van de bounded wait niet. De deadline echt
    // laten verstrijken via een reële wait_seconds zou de mocked (instant-
    // resolvende) waitForQueueWakeup in een ongebreidelde lus laten draaien —
    // precies het OOM-patroon van mutatie 1, alleen dan in productiecode die
    // wél klopt. Fake timers dus: de klok verspringt als bijwerking van de
    // EERSTE wake-up-aanroep ver voorbij de deadline, zodat de while-conditie
    // na precies één iteratie deterministisch faalt, zonder dat er echte tijd
    // verstrijkt of de lus ook maar één extra keer draait.
    vi.useFakeTimers()
    try {
      const base = new Date('2026-01-01T00:00:00.000Z')
      vi.setSystemTime(base)
      mockWakeup.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(base.getTime() + 10 * 60_000))
      })
      const server = makeServer()
      const result = await server.call({ message_ids: [REQ_A], wait_seconds: 30 })
      const body = JSON.parse(result.content[0].text)
      expect(body).toEqual({ status: 'timeout', replies: [] })
      expect(mockWakeup).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
