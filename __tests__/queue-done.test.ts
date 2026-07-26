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
import { registerQueueDoneTool } from '../src/tools/queue-done.js'
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
  registerQueueDoneTool(server as unknown as McpServer)
  return server
}

const MSG_ID = 'aaaaaaaa-0000-4000-8000-000000000030'
const REPLY_ID = 'aaaaaaaa-0000-4000-8000-000000000031'

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

describe('queue_done — validaties (§5.4/§7)', () => {
  it('QUEUE_NOT_FOUND voor een onbekend id', async () => {
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_FOUND')
  })

  it('QUEUE_ALREADY_TERMINAL op een al-done bericht', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([requestRow({ status: 'done' })])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_ALREADY_TERMINAL')
  })

  it('mét token op een pending bericht → QUEUE_CLAIM_EXPIRED (zombie-bypass geblokkeerd)', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([requestRow({ status: 'pending', claimed_by: null })])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, claim_token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_CLAIM_EXPIRED')
  })

  it('claimed zonder lokale lease, mét token → QUEUE_CLAIM_EXPIRED (stap a)', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([requestRow()])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, claim_token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_CLAIM_EXPIRED')
  })

  it('claimed zonder lokale lease, tokenloos (CLI-claim) → QUEUE_NOT_CLAIMER', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([requestRow({ claimed_by: 'mac:12345' })])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('entry aanwezig maar verkeerd token → QUEUE_NOT_CLAIMER (stap b)', async () => {
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    txMock.$queryRaw.mockResolvedValueOnce([requestRow()])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, claim_token: 'fout' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('herclaimd door een ander ondanks lokale entry → QUEUE_NOT_CLAIMER (stap c, strikte gelijkheid)', async () => {
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    txMock.$queryRaw.mockResolvedValueOnce([requestRow({ claimed_by: 'mac:99999' })])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, claim_token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('reply op een response-type bericht → VALIDATION_ERROR (CLI-pariteit)', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([
      requestRow({ type: 'data', in_reply_to: 'ander-id', status: 'pending', claimed_by: null }),
    ])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, reply: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('VALIDATION_ERROR')
  })
})

describe('queue_done — happy paths (§5.4)', () => {
  it('eigen claim + reply: reply-rij gespiegeld, request done, beide NOTIFYs, lease released', async () => {
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    const req = requestRow()
    const replyRow = {
      ...req, id: REPLY_ID, type: 'result',
      from_server: 'mac', from_model: 'claude', to_server: 'max2', to_model: 'codex',
      body: 'klaar', in_reply_to: MSG_ID, status: 'pending', claimed_by: null, source: 'mcp',
    }
    const doneRow = { ...req, status: 'done', finished_at: new Date() }
    txMock.$queryRaw
      .mockResolvedValueOnce([req])       // SELECT ... FOR UPDATE
      .mockResolvedValueOnce([replyRow])  // INSERT reply RETURNING *
      .mockResolvedValueOnce([doneRow])   // UPDATE request RETURNING *
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, reply: 'klaar', claim_token: 'tok' })
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ message_id: MSG_ID, status: 'done', reply_id: REPLY_ID })
    // INSERT values: reply type via QUEUE_REPLY_TYPE, from/to gespiegeld, in_reply_to = request-id.
    const insertValues = txMock.$queryRaw.mock.calls[1].slice(1)
    expect(insertValues).toEqual(['result', 'mac', 'claude', 'max2', 'codex', 'klaar', MSG_ID])
    const insertSql = (txMock.$queryRaw.mock.calls[1][0] as readonly string[]).join(' ')
    expect(insertSql).toContain("'mcp'")
    // Twee envelopes: reply (pending/null) en request (done/claimed).
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(2)
    const first = JSON.parse(txMock.$executeRaw.mock.calls[0][2] as string)
    const second = JSON.parse(txMock.$executeRaw.mock.calls[1][2] as string)
    expect(first).toMatchObject({ id: REPLY_ID, status: 'pending', previous_status: null })
    expect(second).toMatchObject({ id: MSG_ID, status: 'done', previous_status: 'claimed' })
    expect(getLease(MSG_ID)).toBeUndefined()
  })

  it('eigen claim zonder reply: ack → done, één NOTIFY, lease released', async () => {
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    const req = requestRow()
    txMock.$queryRaw
      .mockResolvedValueOnce([req])
      .mockResolvedValueOnce([{ ...req, status: 'done', finished_at: new Date() }])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, claim_token: 'tok' })
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ message_id: MSG_ID, status: 'done', reply_id: null })
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1)
    expect(getLease(MSG_ID)).toBeUndefined()
  })

  it('tokenloze FIFO-bypass met reply op een pending request blijft werken', async () => {
    const req = requestRow({ status: 'pending', claimed_by: null })
    const replyRow = {
      ...req, id: REPLY_ID, type: 'result',
      from_server: 'mac', from_model: 'claude', to_server: 'max2', to_model: 'codex',
      body: 'bypass', in_reply_to: MSG_ID, source: 'mcp',
    }
    txMock.$queryRaw
      .mockResolvedValueOnce([req])
      .mockResolvedValueOnce([replyRow])
      .mockResolvedValueOnce([{ ...req, status: 'done', finished_at: new Date() }])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, reply: 'bypass' })
    expect(result.isError).toBeUndefined()
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(2)
  })
})
