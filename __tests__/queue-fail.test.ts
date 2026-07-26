import { describe, it, expect, vi, beforeEach } from 'vitest'

const txMock = vi.hoisted(() => ({ $queryRaw: vi.fn(), $executeRaw: vi.fn() }))

vi.mock('../src/prisma.js', () => ({
  prisma: { $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)) },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})

import { requireWriteAccess } from '../src/auth.js'
import { clearLeases, getLease, registerLease } from '../src/queue/lease-register.js'
import { registerQueueFailTool } from '../src/tools/queue-fail.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

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
  registerQueueFailTool(server as unknown as McpServer)
  return server
}

const MSG_ID = 'aaaaaaaa-0000-4000-8000-000000000040'

function requestRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: MSG_ID,
    type: 'task',
    from_server: 'max2',
    from_model: 'codex',
    to_server: 'mac',
    to_model: 'claude',
    body: 'do it',
    meta: {},
    source: 'cli',
    status: 'claimed',
    in_reply_to: null,
    error: null,
    claimed_by: 'mcp:inst:tok',
    claimed_at: new Date(),
    started_at: new Date(),
    finished_at: null,
    created_at: new Date(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearLeases()
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
  txMock.$queryRaw.mockResolvedValue([])
  txMock.$executeRaw.mockResolvedValue(1)
})

describe('queue_fail — §5.5', () => {
  it('QUEUE_NOT_FOUND voor een onbekend id', async () => {
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, error: 'ging mis' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_FOUND')
  })

  it('QUEUE_ALREADY_TERMINAL op een al-failed bericht', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([requestRow({ status: 'failed' })])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, error: 'ging mis' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_ALREADY_TERMINAL')
  })

  it('claimed zonder lokale lease, mét token → QUEUE_CLAIM_EXPIRED (stap a)', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([requestRow()])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, error: 'ging mis', claim_token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_CLAIM_EXPIRED')
  })

  it('entry aanwezig maar verkeerd token → QUEUE_NOT_CLAIMER (stap b)', async () => {
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    txMock.$queryRaw.mockResolvedValueOnce([requestRow()])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, error: 'ging mis', claim_token: 'fout' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('eigen claim: status → failed met error-tekst, NOTIFY-envelope, lease released', async () => {
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    const req = requestRow()
    txMock.$queryRaw
      .mockResolvedValueOnce([req])
      .mockResolvedValueOnce([{ ...req, status: 'failed', error: 'ging mis', finished_at: new Date() }])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, error: 'ging mis', claim_token: 'tok' })
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ message_id: MSG_ID, status: 'failed' })
    const updateSql = (txMock.$queryRaw.mock.calls[1][0] as readonly string[]).join(' ')
    expect(updateSql).toContain("SET status = 'failed'")
    expect(txMock.$queryRaw.mock.calls[1][1]).toBe('ging mis')
    const payload = JSON.parse(txMock.$executeRaw.mock.calls[0][2] as string)
    expect(payload).toMatchObject({ id: MSG_ID, status: 'failed', previous_status: 'claimed' })
    expect(getLease(MSG_ID)).toBeUndefined()
  })

  it('tokenloze fail op een pending bericht is toegestaan (CLI-pariteit)', async () => {
    const req = requestRow({ status: 'pending', claimed_by: null })
    txMock.$queryRaw
      .mockResolvedValueOnce([req])
      .mockResolvedValueOnce([{ ...req, status: 'failed', error: 'kapot', finished_at: new Date() }])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, error: 'kapot' })
    expect(result.isError).toBeUndefined()
  })

  it('routeert door de gedeelde eigenaarscheck: prefix-botsing wordt geweigerd', async () => {
    // Dit bestand test de matrix bewust niet opnieuw -- die staat in taak 10.
    // Maar daardoor slaagt het nu dánkzij de deling van ownership.ts, zonder
    // die te bewijzen. Eén step-(c)-geval pint vast dat queue_fail er echt
    // doorheen loopt: forkt of inlinet iemand die logica later, dan valt dit om.
    //
    // Prefix-botsing, want dat is het geval dat een verzwakte vergelijking
    // (startsWith in plaats van !==) zou doorlaten: 'mcp:inst:tok2' begint met
    // 'mcp:inst:tok' maar is een andere claim.
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    txMock.$queryRaw.mockResolvedValueOnce([requestRow({ claimed_by: 'mcp:inst:tok2' })])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, error: 'ging mis', claim_token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('weigert een lege error-tekst', async () => {
    // z.string().min(1) was volledig ongedekt -- verwijderen bleef onzichtbaar.
    // Een mislukking zonder reden vastleggen is erger dan geen mislukking: de
    // ontvanger ziet 'failed' zonder enige aanwijzing waarom.
    //
    // server.call() roept de handler rechtstreeks aan en omzeilt daarmee de
    // inputSchema-validatie die de échte SDK's registerTool vóór de handler
    // uitvoert -- gemeten: server.call({ error: '' }) slaagt in deze harness
    // gewoon (geen isError). Daarom hier, zoals de include_terminal-default
    // -check in queue-list.test.ts, de zod-schema zelf pakken via de meta die
    // aan registerTool wordt doorgegeven, en die direct parsen.
    const server = makeServer()
    const meta = server.registerTool.mock.calls[0][1] as {
      inputSchema: { safeParse: (value: unknown) => { success: boolean } }
    }
    expect(meta.inputSchema.safeParse({ message_id: MSG_ID, error: '' }).success).toBe(false)
  })
})
