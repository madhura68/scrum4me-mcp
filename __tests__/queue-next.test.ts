import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})
vi.mock('../src/queue/claim.js', () => ({
  claimNextRequest: vi.fn(),
  rollbackQueueClaim: vi.fn(),
}))
vi.mock('../src/queue/listen.js', () => ({
  QUEUE_POLL_INTERVAL_MS: 5_000,
  openQueueListener: vi.fn(),
  waitForQueueWakeup: vi.fn(),
}))
vi.mock('../src/presence/instance.js', () => ({ getInstanceId: vi.fn(() => 'inst-1') }))

import { requireWriteAccess } from '../src/auth.js'
import { claimNextRequest, rollbackQueueClaim } from '../src/queue/claim.js'
import { openQueueListener, waitForQueueWakeup } from '../src/queue/listen.js'
import { clearLeases, getLease, leaseEntries } from '../src/queue/lease-register.js'
import { registerQueueNextTool } from '../src/tools/queue-next.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockClaim = claimNextRequest as ReturnType<typeof vi.fn>
const mockRollback = rollbackQueueClaim as ReturnType<typeof vi.fn>
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
  registerQueueNextTool(server as unknown as McpServer)
  return server
}

const MSG_ID = 'aaaaaaaa-0000-4000-8000-000000000050'
const MSG_ID_2 = 'aaaaaaaa-0000-4000-8000-000000000051'

function claimedRow(claimedBy: string, id: string = MSG_ID) {
  return {
    id,
    type: 'task',
    from_server: 'max2',
    from_model: 'codex',
    to_server: 'mac',
    to_model: 'claude',
    body: 'do it',
    meta: { task: { cwd: '/w', repo: 'r', objective: 'o', verification: 'v', response_format: 'rf' } },
    source: 'cli',
    status: 'claimed',
    in_reply_to: null,
    error: null,
    claimed_by: claimedBy,
    claimed_at: new Date(),
    started_at: new Date(),
    finished_at: null,
    created_at: new Date(),
    previous_status: 'pending',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearLeases()
  vi.stubEnv('S4M_SERVER', 'mac')
  vi.stubEnv('S4M_MODEL', 'claude')
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
  mockClaim.mockResolvedValue(null)
  mockRollback.mockResolvedValue(undefined)
  mockOpen.mockResolvedValue({ end: vi.fn().mockResolvedValue(undefined) })
  mockWakeup.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllEnvs())

describe('queue_next — §5.3', () => {
  it('claimt FIFO met claimed_by = mcp:<instance_id>:<token> en registreert de lease', async () => {
    mockClaim.mockImplementation(async ({ claimedBy }: { claimedBy: string }) => claimedRow(claimedBy))
    const server = makeServer()
    const result = await server.call({ wait_seconds: 0 })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('claimed')
    expect(body.message.id).toBe(MSG_ID)
    expect(body.claim_token).toBeTruthy()
    expect(body.instructions).toContain('meta.task.cwd')
    expect(body.instructions).toContain('queue_fail')
    const claimedBy = mockClaim.mock.calls[0][0].claimedBy as string
    expect(claimedBy).toBe(`mcp:inst-1:${body.claim_token}`)
    expect(getLease(MSG_ID)).toEqual({ claimToken: body.claim_token, claimedBy })
  })

  it('geen bericht + wait_seconds 0 → timeout zonder LISTEN', async () => {
    const server = makeServer()
    const result = await server.call({ wait_seconds: 0 })
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ status: 'timeout', message: null })
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('bounded wait: herclaim na wake-up, listener wordt gesloten', async () => {
    const end = vi.fn().mockResolvedValue(undefined)
    mockOpen.mockResolvedValue({ end })
    mockClaim
      .mockResolvedValueOnce(null) // directe poging
      .mockResolvedValueOnce(null) // direct na LISTEN
      .mockImplementationOnce(async ({ claimedBy }: { claimedBy: string }) => claimedRow(claimedBy))
    const server = makeServer()
    const result = await server.call({ wait_seconds: 30 })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('claimed')
    expect(mockWakeup).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('cancel vóór de claim: er wordt niets geclaimd of geregistreerd', async () => {
    const ac = new AbortController()
    ac.abort()
    const server = makeServer()
    const result = await server.call({ wait_seconds: 0 }, { signal: ac.signal })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('timeout')
    expect(mockClaim).not.toHaveBeenCalled()
    expect(leaseEntries()).toEqual([])
  })

  it('cancel tijdens de wait: wait stopt, geen claim, timeout', async () => {
    const ac = new AbortController()
    mockWakeup.mockImplementation(async () => {
      ac.abort()
    })
    const server = makeServer()
    const result = await server.call({ wait_seconds: 30 }, { signal: ac.signal })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('timeout')
    expect(mockClaim).toHaveBeenCalledTimes(2) // directe poging + direct na LISTEN, niet ná abort
  })

  it('cancel direct ná de claim-transactie: rollbackClaim + lease released (§7)', async () => {
    const ac = new AbortController()
    mockClaim.mockImplementation(async ({ claimedBy }: { claimedBy: string }) => {
      ac.abort() // cancel arriveert precies tussen commit en respons
      return claimedRow(claimedBy)
    })
    const server = makeServer()
    const result = await server.call({ wait_seconds: 0 }, { signal: ac.signal })
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ status: 'cancelled', message: null })
    const claimedBy = mockClaim.mock.calls[0][0].claimedBy as string
    expect(mockRollback).toHaveBeenCalledWith(MSG_ID, claimedBy)
    expect(getLease(MSG_ID)).toBeUndefined()
  })

  it("accepteert as: 'kimi' — schema én claim-adres", async () => {
    // Zie queue-push.test.ts: de overgetypte enum weigerde 'kimi' vóór
    // resolveQueueIdentity. Schema-laag + handler-laag, want het harnas
    // roept de handler rechtstreeks aan en slaat Zod over.
    const server = makeServer()
    const meta = server.registerTool.mock.calls[0][1] as {
      inputSchema: { parse: (value: unknown) => { as?: string } }
    }
    expect(meta.inputSchema.parse({ as: 'kimi' }).as).toBe('kimi')
    expect(() => meta.inputSchema.parse({ as: 'gpt' })).toThrow()

    await server.call({ wait_seconds: 0, as: 'kimi' })
    expect(mockClaim).toHaveBeenCalledWith(
      expect.objectContaining({ server: 'mac', model: 'kimi' }),
    )
  })

  it('QUEUE_IDENTITY_REQUIRED zonder identiteit', async () => {
    vi.stubEnv('S4M_MODEL', '')
    const server = makeServer()
    const result = await server.call({ wait_seconds: 0 })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_IDENTITY_REQUIRED')
  })

  it('geeft elke claim een eigen, onvoorspelbaar token', async () => {
    // Niet cosmetisch. verifyLocalOwnership vergelijkt het meegegeven
    // claim_token met getLease(messageId).claimToken -- gesleuteld op bericht-id,
    // niet op token. Is het token een constante, dan kan elke aanroeper binnen
    // dit proces die een geclaimd bericht-id kent (zichtbaar via queue_list en
    // queue_status) dat token meegeven aan queue_done of queue_fail voor een
    // bericht dat hij nooit claimde -- en stap (b) laat hem door.
    // Twee opeenvolgende claims op verschillende berichten: de twee
    // claim_tokens moeten verschillen, en elk token moet voorkomen in de
    // claimed_by die bij díe claim is meegegeven, zodat een gedeeld token niet
    // via een omweg alsnog passeert.
    mockClaim
      .mockImplementationOnce(async ({ claimedBy }: { claimedBy: string }) => claimedRow(claimedBy, MSG_ID))
      .mockImplementationOnce(async ({ claimedBy }: { claimedBy: string }) => claimedRow(claimedBy, MSG_ID_2))
    const server = makeServer()
    const result1 = await server.call({ wait_seconds: 0 })
    const result2 = await server.call({ wait_seconds: 0 })
    const body1 = JSON.parse(result1.content[0].text)
    const body2 = JSON.parse(result2.content[0].text)
    expect(body1.claim_token).not.toBe(body2.claim_token)
    const claimedBy1 = mockClaim.mock.calls[0][0].claimedBy as string
    const claimedBy2 = mockClaim.mock.calls[1][0].claimedBy as string
    expect(claimedBy1).toBe(`mcp:inst-1:${body1.claim_token}`)
    expect(claimedBy2).toBe(`mcp:inst-1:${body2.claim_token}`)
    // Twee verschillende bericht-ids: anders overschrijft de tweede
    // registerLease de eerste en toetst dit niets over onderlinge verschillen.
    expect(getLease(MSG_ID)).toEqual({ claimToken: body1.claim_token, claimedBy: claimedBy1 })
    expect(getLease(MSG_ID_2)).toEqual({ claimToken: body2.claim_token, claimedBy: claimedBy2 })
  })

  it('wekt op verzoek-types, niet op antwoord-types', async () => {
    // De predicaat die aan waitForQueueWakeup wordt meegegeven werd nooit
    // uitgevoerd, want die functie is gemockt. Vang hem uit de mock en roep hem
    // zelf aan -- dan is het predicaat wél getoetst zonder een echte NOTIFY.
    // mockWakeup breekt de wait-loop meteen na de eerste aanroep (zelfde
    // patroon als 'cancel tijdens de wait'), zodat mock.calls[0] het predicaat
    // van de allereerste waitForQueueWakeup-aanroep bevat.
    const ac = new AbortController()
    mockWakeup.mockImplementation(async () => {
      ac.abort()
    })
    const server = makeServer()
    await server.call({ wait_seconds: 30 }, { signal: ac.signal })
    const isRelevant = mockWakeup.mock.calls[0][2] as (payload: Record<string, unknown>) => boolean
    expect(isRelevant({ type: 'task', to_server: 'mac', to_model: 'claude', status: 'pending' })).toBe(true)
    expect(isRelevant({ type: 'result', to_server: 'mac', to_model: 'claude', status: 'pending' })).toBe(false)
  })

  it('geeft de meta van het bericht mee in de respons', async () => {
    // messageView is gedeeld, dus een regressie zou elders ook opvallen -- maar
    // dit bestand bewaakte het niet, en meta.task.cwd is precies wat de
    // ontvanger nodig heeft om het werk op de juiste plek uit te voeren.
    mockClaim.mockImplementation(async ({ claimedBy }: { claimedBy: string }) => claimedRow(claimedBy))
    const server = makeServer()
    const result = await server.call({ wait_seconds: 0 })
    const body = JSON.parse(result.content[0].text)
    expect(body.message.meta).toEqual({
      task: { cwd: '/w', repo: 'r', objective: 'o', verification: 'v', response_format: 'rf' },
    })
  })
})
