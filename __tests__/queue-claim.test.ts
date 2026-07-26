import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const txMock = vi.hoisted(() => ({ $queryRaw: vi.fn(), $executeRaw: vi.fn() }))

vi.mock('../src/prisma.js', () => ({
  prisma: { $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)) },
}))

import {
  DEFAULT_RECLAIM_AFTER, claimNextReply, claimNextRequest, reclaimInterval, rollbackQueueClaim,
} from '../src/queue/claim.js'

const claimedRow = {
  id: 'msg-1',
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
  previous_status: 'pending',
}

function sqlOf(call: unknown[]): string {
  return (call[0] as readonly string[]).join(' ')
}

beforeEach(() => {
  vi.clearAllMocks()
  txMock.$queryRaw.mockResolvedValue([])
  txMock.$executeRaw.mockResolvedValue(1)
})
afterEach(() => vi.unstubAllEnvs())

describe('reclaimInterval — CLI-pariteit (s4m-queue/src/config.ts)', () => {
  it('default 4 hours', () => {
    expect(reclaimInterval()).toBe(DEFAULT_RECLAIM_AFTER)
  })

  it('respecteert S4M_RECLAIM_DEFAULT', () => {
    vi.stubEnv('S4M_RECLAIM_DEFAULT', '30 minutes')
    expect(reclaimInterval()).toBe('30 minutes')
  })

  it('valt terug op de default bij een onveilige interval-string', () => {
    vi.stubEnv('S4M_RECLAIM_DEFAULT', "1'; DROP TABLE agent_message; --")
    expect(reclaimInterval()).toBe(DEFAULT_RECLAIM_AFTER)
  })
})

describe('claimNextRequest — FIFO-claim met FOR UPDATE SKIP LOCKED (§5.3)', () => {
  it('geeft null zonder claimbare rij en emit dan géén NOTIFY', async () => {
    const result = await claimNextRequest({ server: 'mac', model: 'claude', claimedBy: 'mcp:i:t' })
    expect(result).toBeNull()
    expect(txMock.$executeRaw).not.toHaveBeenCalled()
  })

  it('claimt atomair en emit een claimed-envelope in dezelfde transactie', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([claimedRow])
    const result = await claimNextRequest({ server: 'mac', model: 'claude', claimedBy: 'mcp:inst:tok' })
    expect(result?.id).toBe('msg-1')
    const sql = sqlOf(txMock.$queryRaw.mock.calls[0])
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain("status = 'pending'")
    expect(sql).toContain("status = 'claimed' AND claimed_at < now()")
    expect(sql).toContain('ORDER BY created_at, id')
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(txMock.$executeRaw.mock.calls[0][2] as string)
    expect(payload).toEqual({
      id: 'msg-1',
      type: 'task',
      from_server: 'max2',
      from_model: 'codex',
      to_server: 'mac',
      to_model: 'claude',
      in_reply_to: null,
      status: 'claimed',
      previous_status: 'pending',
    })
  })

  it('vraagt om verzoek-types, niet om antwoord-types', async () => {
    // Zonder deze assertie mag QUEUE_REQUEST_TYPES vervangen worden door
    // QUEUE_RESPONSE_TYPES: queue_next claimt dan antwoorden in plaats van
    // verzoeken en alle negen tests blijven groen, want de mock geeft de
    // fixture terug ongeacht de query.
    txMock.$queryRaw.mockResolvedValueOnce([claimedRow])
    await claimNextRequest({ server: 'mac', model: 'claude', claimedBy: 'mcp:i:t' })
    expect(txMock.$queryRaw.mock.calls[0][3]).toEqual(['task', 'info', 'review_request'])
  })

  it('geeft het berekende reclaim-interval door aan de query', async () => {
    // reclaimInterval() had eigen tests, maar niets bewees dat de uitkomst de
    // SQL ook bereikt: een hardgecodeerde DEFAULT_RECLAIM_AFTER in de template
    // maakt de env-override stil dood.
    vi.stubEnv('S4M_RECLAIM_DEFAULT', '30 minutes')
    txMock.$queryRaw.mockResolvedValueOnce([claimedRow])
    await claimNextRequest({ server: 'mac', model: 'claude', claimedBy: 'mcp:i:t' })
    expect(txMock.$queryRaw.mock.calls[0][4]).toBe('30 minutes')
  })

  it('zet de claim-timestamps en leest previous_status uit de pre-update rij', async () => {
    // started_at ontbrak volledig in de asserties, en previous_status mocht uit
    // updated.status komen in plaats van target.status -- dan draagt elke
    // claim-envelope de nieuwe status als "vorige".
    txMock.$queryRaw.mockResolvedValueOnce([claimedRow])
    await claimNextRequest({ server: 'mac', model: 'claude', claimedBy: 'mcp:i:t' })
    const sql = sqlOf(txMock.$queryRaw.mock.calls[0])
    expect(sql).toContain('claimed_at = now()')
    expect(sql).toContain('started_at = now()')
    expect(sql).toContain('target.status AS previous_status')
  })
})

describe('claimNextReply — correlatiefilter ín de WHERE-clause + auto-ack (§5.2)', () => {
  it('filtert op in_reply_to = ANY(message_ids) en zet de rij in één transactie op done', async () => {
    const replyRow = {
      ...claimedRow, id: 'r-1', type: 'data', in_reply_to: 'msg-1',
      status: 'done', finished_at: new Date(),
    }
    txMock.$queryRaw.mockResolvedValueOnce([replyRow])
    const result = await claimNextReply({
      server: 'mac', model: 'claude', messageIds: ['msg-1'], claimedBy: 'mcp:inst',
    })
    expect(result?.id).toBe('r-1')
    const sql = sqlOf(txMock.$queryRaw.mock.calls[0])
    expect(sql).toContain('in_reply_to = ANY(')
    expect(sql).toContain("SET status = 'done'")
    expect(sql).toContain('finished_at = now()')
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1)
  })

  it('geeft null als niets claimbaar is', async () => {
    const result = await claimNextReply({
      server: 'mac', model: 'claude', messageIds: ['x'], claimedBy: 'mcp:i',
    })
    expect(result).toBeNull()
  })
})

describe('rollbackQueueClaim — MCP-cancel ná claim (§7)', () => {
  it('zet claimed → pending alleen bij exacte claimed_by-match en emit een requeue-envelope', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([{ ...claimedRow, status: 'pending', claimed_by: null }])
    await rollbackQueueClaim('msg-1', 'mcp:inst:tok')
    const sql = sqlOf(txMock.$queryRaw.mock.calls[0])
    expect(sql).toContain("SET status = 'pending'")
    expect(sql).toContain("status = 'claimed' AND claimed_by =")
    const payload = JSON.parse(txMock.$executeRaw.mock.calls[0][2] as string)
    expect(payload.status).toBe('pending')
    expect(payload.previous_status).toBe('claimed')
  })

  it('doet niets (geen NOTIFY) als de rij inmiddels van een ander is', async () => {
    await rollbackQueueClaim('msg-1', 'mcp:inst:tok')
    expect(txMock.$executeRaw).not.toHaveBeenCalled()
  })
})
