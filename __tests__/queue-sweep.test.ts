import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const txMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
}))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
  },
}))

import { prisma } from '../src/prisma.js'
import {
  sweepStaleQueueClaims,
  startQueueStaleSweep,
  cliReclaimInterval,
  MCP_LEASE_STALE_INTERVAL,
  SWEEP_MIN_INTERVAL_MS,
  SWEEP_JITTER_MS,
} from '../src/queue/sweep.js'

const mockTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  txMock.$queryRaw.mockResolvedValue([])
  txMock.$executeRaw.mockResolvedValue(0)
  delete process.env.S4M_RECLAIM_DEFAULT
})

describe('cliReclaimInterval', () => {
  it('default 4 hours, env-override, en fallback bij ongeldige waarde', () => {
    expect(cliReclaimInterval({})).toBe('4 hours')
    expect(cliReclaimInterval({ S4M_RECLAIM_DEFAULT: '90 minutes' })).toBe('90 minutes')
    expect(cliReclaimInterval({ S4M_RECLAIM_DEFAULT: "4) OR (1=1" })).toBe('4 hours')
  })
})

describe('sweepStaleQueueClaims — §6.1', () => {
  it('gebruikt SKIP LOCKED en de mcp-/CLI-drempels als bind-parameters', async () => {
    await sweepStaleQueueClaims()
    const [strings, ...values] = txMock.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ]
    const sql = strings.join('$')
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain("claimed_by LIKE 'mcp:%'")
    expect(sql).toContain("status = 'claimed'")
    expect(sql).toContain("SET status = 'pending', claimed_by = NULL, claimed_at = NULL, started_at = NULL")
    expect(values).toContain(MCP_LEASE_STALE_INTERVAL)
    expect(values).toContain('4 hours')
  })

  it('emit per gerequeuede rij een byte-compatibele NotifyEnvelope op agent_queue', async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: 'msg-1',
        type: 'task',
        from_server: 'mac',
        from_model: 'claude',
        to_server: 'scrum4me-server',
        to_model: 'codex',
        in_reply_to: null,
      },
    ])
    const { requeued } = await sweepStaleQueueClaims()
    expect(requeued).toEqual(['msg-1'])
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1)
    const [, channel, payload] = txMock.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      string,
      string,
    ]
    expect(channel).toBe('agent_queue')
    expect(payload).toBe(
      JSON.stringify({
        id: 'msg-1',
        type: 'task',
        from_server: 'mac',
        from_model: 'claude',
        to_server: 'scrum4me-server',
        to_model: 'codex',
        in_reply_to: null,
        status: 'pending',
        previous_status: 'claimed',
      }),
    )
  })

  it('geen stale rijen → geen notify', async () => {
    const { requeued } = await sweepStaleQueueClaims()
    expect(requeued).toEqual([])
    expect(txMock.$executeRaw).not.toHaveBeenCalled()
  })
})

describe('startQueueStaleSweep — gerandomiseerd interval', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('draait op minimaal 8 min (random 0) en stopt via stop()', async () => {
    const { stop } = startQueueStaleSweep({ random: () => 0 })
    expect(mockTransaction).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SWEEP_MIN_INTERVAL_MS)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SWEEP_MIN_INTERVAL_MS)
    expect(mockTransaction).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(SWEEP_MIN_INTERVAL_MS * 3)
    expect(mockTransaction).toHaveBeenCalledTimes(2)
  })

  it('random () => 1 schuift de run naar min + jitter (10 min)', async () => {
    const { stop } = startQueueStaleSweep({ random: () => 1 })
    await vi.advanceTimersByTimeAsync(SWEEP_MIN_INTERVAL_MS)
    expect(mockTransaction).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SWEEP_JITTER_MS)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    stop()
  })

  it('een falende sweep breekt de loop niet', async () => {
    mockTransaction.mockRejectedValueOnce(new Error('db weg'))
    const { stop } = startQueueStaleSweep({ random: () => 0 })
    await vi.advanceTimersByTimeAsync(SWEEP_MIN_INTERVAL_MS)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SWEEP_MIN_INTERVAL_MS)
    expect(mockTransaction).toHaveBeenCalledTimes(2)
    stop()
  })

  it('unreft de timer zodat hij de event-loop niet openhoudt', () => {
    const unref = vi.fn()
    const spy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue({ unref } as never)
    startQueueStaleSweep({ random: () => 0 })
    expect(unref).toHaveBeenCalled()
    spy.mockRestore()
  })
})
