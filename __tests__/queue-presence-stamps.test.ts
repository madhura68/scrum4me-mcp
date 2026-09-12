// Stempelgate voor de MCP-claimpaden (IDEA-194 §5.2).
//
// Wat hier bewaakt wordt is niet dát er gestempeld wordt, maar HOE VAAK en OP
// WELK ADRES. De twee fouten die het ontwerp verbiedt zijn allebei stil:
// stempelen per iteratie van een wachtlus (dan wordt de drain-stempel een
// verkapte periodieke sessie-hartslag) en stempelen op een teruggerolde of
// geaborteerde aanroep (dan liegt presence over responsiviteit).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const txMock = vi.hoisted(() => ({ $queryRaw: vi.fn(), $executeRaw: vi.fn() }))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    agentMessage: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
  },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})
vi.mock('../src/queue/claim.js', () => ({
  claimNextRequest: vi.fn(),
  claimNextReply: vi.fn(),
  rollbackQueueClaim: vi.fn(),
}))
vi.mock('../src/queue/listen.js', () => ({
  QUEUE_POLL_INTERVAL_MS: 5_000,
  openQueueListener: vi.fn(),
  waitForQueueWakeup: vi.fn(),
}))
vi.mock('../src/presence/instance.js', () => ({ getInstanceId: vi.fn(() => 'inst-1') }))
vi.mock('../src/queue/presence.js', () => ({ stampDrainPresenceBestEffort: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { claimNextReply, claimNextRequest, rollbackQueueClaim } from '../src/queue/claim.js'
import { openQueueListener, waitForQueueWakeup } from '../src/queue/listen.js'
import { stampDrainPresenceBestEffort } from '../src/queue/presence.js'
import { clearLeases, registerLease } from '../src/queue/lease-register.js'
import { registerQueueNextTool } from '../src/tools/queue-next.js'
import { registerQueueDoneTool } from '../src/tools/queue-done.js'
import { registerQueueFailTool } from '../src/tools/queue-fail.js'
import { registerQueueWaitReplyTool } from '../src/tools/queue-wait-reply.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as { agentMessage: { findMany: ReturnType<typeof vi.fn> } }
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockClaimRequest = claimNextRequest as ReturnType<typeof vi.fn>
const mockClaimReply = claimNextReply as ReturnType<typeof vi.fn>
const mockRollback = rollbackQueueClaim as ReturnType<typeof vi.fn>
const mockOpen = openQueueListener as ReturnType<typeof vi.fn>
const mockWakeup = waitForQueueWakeup as ReturnType<typeof vi.fn>
const mockStamp = stampDrainPresenceBestEffort as ReturnType<typeof vi.fn>

type ToolResult = { isError?: boolean; content: { text: string }[] }
type Extra = { signal?: AbortSignal }

function makeServer(register: (s: McpServer) => void) {
  let handler: (args: Record<string, unknown>, extra?: Extra) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>, extra?: Extra) => handler(args, extra) as Promise<ToolResult>,
  }
  register(server as unknown as McpServer)
  return server
}

const MSG_ID = 'aaaaaaaa-0000-4000-8000-000000000060'

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: MSG_ID,
    type: 'task',
    from_server: 'max2',
    from_model: 'codex',
    // Bewust een ánder adres dan de identiteit (mac:claude), zodat een test
    // die per ongeluk op de identiteit stempelt zichtbaar rood wordt.
    to_server: 'scrum4me-server',
    to_model: 'claude',
    body: 'x',
    meta: {},
    source: 'cli',
    status: 'claimed',
    in_reply_to: null,
    error: null,
    claimed_by: 'mcp:inst-1:tok',
    claimed_at: new Date(),
    started_at: new Date(),
    finished_at: null,
    created_at: new Date(),
    previous_status: 'pending',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearLeases()
  vi.stubEnv('S4M_SERVER', 'mac')
  vi.stubEnv('S4M_MODEL', 'claude')
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
  mockClaimRequest.mockResolvedValue(null)
  mockClaimReply.mockResolvedValue(null)
  mockRollback.mockResolvedValue(undefined)
  mockOpen.mockResolvedValue({ end: vi.fn().mockResolvedValue(undefined) })
  mockWakeup.mockResolvedValue(undefined)
  mockStamp.mockResolvedValue(undefined)
  mockPrisma.agentMessage.findMany.mockResolvedValue([])
})
afterEach(() => vi.unstubAllEnvs())

describe('queue_next (§5.2)', () => {
  it('stempelt op het rij-adres na een geslaagde claim, precies één keer', async () => {
    mockClaimRequest.mockResolvedValueOnce(row())
    const server = makeServer(registerQueueNextTool)
    const result = await server.call({ wait_seconds: 0 })
    expect(JSON.parse(result.content[0].text).status).toBe('claimed')
    expect(mockStamp).toHaveBeenCalledTimes(1)
    expect(mockStamp).toHaveBeenCalledWith('scrum4me-server', 'claude')
  })

  it('stempelt bij een lege poll op het identiteitsadres, precies één keer', async () => {
    const server = makeServer(registerQueueNextTool)
    const result = await server.call({ wait_seconds: 0 })
    expect(JSON.parse(result.content[0].text).status).toBe('timeout')
    expect(mockStamp).toHaveBeenCalledTimes(1)
    expect(mockStamp).toHaveBeenCalledWith('mac', 'claude')
  })

  it('stempelt niet per iteratie van de wachtlus — één stempel per aanroep', async () => {
    // Drie wake-ups die niets opleveren; de lus draait dus meerdere keren.
    let wakeups = 0
    mockWakeup.mockImplementation(async () => {
      wakeups += 1
      if (wakeups >= 3) await new Promise((r) => setTimeout(r, 60))
    })
    const server = makeServer(registerQueueNextTool)
    const result = await server.call({ wait_seconds: 0.05 })
    expect(JSON.parse(result.content[0].text).status).toBe('timeout')
    expect(wakeups).toBeGreaterThan(1)
    expect(mockStamp).toHaveBeenCalledTimes(1)
  })

  it('stempelt niet wanneer de wachtlus door een abort eindigt zonder claim', async () => {
    // Review #140 (s4m-codex-reviewer): de lus eindigt via `break` op abort en
    // valt dan door naar het lege pad — zonder guard bewijst een geannuleerde
    // aanroep alsnog responsiviteit.
    const controller = new AbortController()
    mockWakeup.mockImplementationOnce(async () => {
      controller.abort()
    })
    const server = makeServer(registerQueueNextTool)
    const result = await server.call({ wait_seconds: 5 }, { signal: controller.signal })
    expect(JSON.parse(result.content[0].text).status).toBe('timeout')
    expect(mockStamp).not.toHaveBeenCalled()
  })

  it('stempelt niet wanneer de claim wordt teruggerold (cancelled)', async () => {
    const controller = new AbortController()
    mockClaimRequest.mockImplementationOnce(async () => {
      controller.abort()
      return row()
    })
    const server = makeServer(registerQueueNextTool)
    const result = await server.call({ wait_seconds: 0 }, { signal: controller.signal })
    expect(JSON.parse(result.content[0].text).status).toBe('cancelled')
    expect(mockRollback).toHaveBeenCalled()
    expect(mockStamp).not.toHaveBeenCalled()
  })
})

describe('queue_done / queue_fail (§5.2)', () => {
  it('queue_done stempelt op het adres van de afgesloten rij', async () => {
    txMock.$queryRaw
      .mockResolvedValueOnce([row()]) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce([row({ status: 'done' })]) // UPDATE ... RETURNING
    txMock.$executeRaw.mockResolvedValue(1)
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst-1:tok' })
    const server = makeServer(registerQueueDoneTool)
    const result = await server.call({ message_id: MSG_ID, claim_token: 'tok' })
    expect(JSON.parse(result.content[0].text).status).toBe('done')
    expect(mockStamp).toHaveBeenCalledTimes(1)
    expect(mockStamp).toHaveBeenCalledWith('scrum4me-server', 'claude')
  })

  it('queue_fail stempelt op het adres van de gefaalde rij', async () => {
    txMock.$queryRaw
      .mockResolvedValueOnce([row()])
      .mockResolvedValueOnce([row({ status: 'failed' })])
    txMock.$executeRaw.mockResolvedValue(1)
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst-1:tok' })
    const server = makeServer(registerQueueFailTool)
    const result = await server.call({ message_id: MSG_ID, error: 'ging mis', claim_token: 'tok' })
    expect(JSON.parse(result.content[0].text).status).toBe('failed')
    expect(mockStamp).toHaveBeenCalledTimes(1)
    expect(mockStamp).toHaveBeenCalledWith('scrum4me-server', 'claude')
  })

  it('een terminale rij stempelt niet — er is niets gedraind', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([row({ status: 'done' })])
    const server = makeServer(registerQueueDoneTool)
    const result = await server.call({ message_id: MSG_ID })
    expect(result.isError).toBe(true)
    expect(mockStamp).not.toHaveBeenCalled()
  })
})

describe('queue_wait_reply (§5.2) — de drain van de antwoord-helft', () => {
  const replyRow = () => row({ type: 'result', in_reply_to: MSG_ID, status: 'done' })

  it('stempelt op het snelpad met een beschikbare reply, één keer, op de identiteit', async () => {
    mockClaimReply.mockResolvedValueOnce(replyRow()).mockResolvedValue(null)
    const server = makeServer(registerQueueWaitReplyTool)
    const result = await server.call({ message_ids: [MSG_ID], wait_seconds: 0 })
    expect(JSON.parse(result.content[0].text).status).toBe('ok')
    expect(mockStamp).toHaveBeenCalledTimes(1)
    // Identiteit, niet het rij-adres: deze tool draint antwoorden die aan de
    // sessie zélf geadresseerd zijn.
    expect(mockStamp).toHaveBeenCalledWith('mac', 'claude')
  })

  it('stempelt ook bij een lege niet-blokkerende check — een lege drain telt', async () => {
    const server = makeServer(registerQueueWaitReplyTool)
    const result = await server.call({ message_ids: [MSG_ID], wait_seconds: 0 })
    expect(JSON.parse(result.content[0].text).status).toBe('timeout')
    expect(mockStamp).toHaveBeenCalledTimes(1)
    expect(mockStamp).toHaveBeenCalledWith('mac', 'claude')
  })

  it('stempelt één keer op het blokkerende-wacht-succespad (return binnen de lus)', async () => {
    // Eerste twee pogingen (snelpad + setup-gap) leeg, daarna een reply in de lus.
    mockClaimReply
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(replyRow())
      .mockResolvedValue(null)
    const server = makeServer(registerQueueWaitReplyTool)
    const result = await server.call({ message_ids: [MSG_ID], wait_seconds: 5 })
    expect(JSON.parse(result.content[0].text).status).toBe('ok')
    expect(mockStamp).toHaveBeenCalledTimes(1)
  })

  it('stempelt één keer bij een timeout ná de wachtlus', async () => {
    let wakeups = 0
    mockWakeup.mockImplementation(async () => {
      wakeups += 1
      if (wakeups >= 2) await new Promise((r) => setTimeout(r, 60))
    })
    const server = makeServer(registerQueueWaitReplyTool)
    const result = await server.call({ message_ids: [MSG_ID], wait_seconds: 0.05 })
    expect(JSON.parse(result.content[0].text).status).toBe('timeout')
    expect(wakeups).toBeGreaterThan(0)
    expect(mockStamp).toHaveBeenCalledTimes(1)
  })

  it('stempelt niet wanneer de aanroep geaborteerd is', async () => {
    const controller = new AbortController()
    controller.abort()
    const server = makeServer(registerQueueWaitReplyTool)
    const result = await server.call(
      { message_ids: [MSG_ID], wait_seconds: 5 },
      { signal: controller.signal },
    )
    expect(JSON.parse(result.content[0].text).status).toBe('timeout')
    expect(mockStamp).not.toHaveBeenCalled()
  })
})
