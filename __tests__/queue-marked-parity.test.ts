import { beforeEach, describe, expect, it, vi } from 'vitest'

const txMock = vi.hoisted(() => ({ $queryRaw: vi.fn(), $executeRaw: vi.fn() }))
vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
  },
}))

import { claimNextReply, claimNextRequest, rollbackQueueClaim } from '../src/queue/claim.js'
import { assertLegacyQueueRow, legacyMarkerWhere } from '../src/queue/marked.js'
import { sweepStaleQueueClaims } from '../src/queue/sweep.js'

const MARKERS = [
  'ppe_protocol', 'ppe_run_id', 'ppe_operation_key', 'ppe_payload_sha256',
  'ppe_from_principal', 'ppe_to_principal', 'ppe_to_consumer_id',
  'ppe_consumer_generation', 'ppe_lease_generation',
] as const

function sqlOf(call: unknown[]): string {
  const render = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(render).join(' ')
    if (value && typeof value === 'object' && 'strings' in value) {
      return render((value as { strings: unknown }).strings)
    }
    return ''
  }
  return call.map(render).join(' ')
}

beforeEach(() => {
  vi.clearAllMocks()
  txMock.$queryRaw.mockResolvedValue([])
  txMock.$executeRaw.mockResolvedValue(1)
})

describe('legacy/marked parity fences', () => {
  it('defines one exact marker-all-null Prisma predicate', () => {
    expect(legacyMarkerWhere()).toEqual(Object.fromEntries(MARKERS.map((key) => [key, null])))
  })

  it('accepts only marker-all-null rows and fails closed for complete or partial tuples', () => {
    expect(() => assertLegacyQueueRow({ id: 'legacy' })).not.toThrow()
    expect(() => assertLegacyQueueRow({ id: 'partial', ppe_protocol: 'parallel-plan-execution/v1' }))
      .toThrow('PPE_LEGACY_ROUTE_REJECTED')
    expect(() => assertLegacyQueueRow(Object.fromEntries([
      ['id', 'complete'], ...MARKERS.map((key) => [key, key === 'ppe_lease_generation' ? 1 : 'x']),
    ]))).toThrow('PPE_LEGACY_ROUTE_REJECTED')
  })

  it('places every marker-null predicate before both request/reply candidate locks', async () => {
    await claimNextRequest({ server: 'mac', model: 'claude', claimedBy: 'mcp:i:t' })
    const requestSql = sqlOf(txMock.$queryRaw.mock.calls[0])
    txMock.$queryRaw.mockClear()
    await claimNextReply({ server: 'mac', model: 'claude', messageIds: ['m'], claimedBy: 'mcp:i' })
    const replySql = sqlOf(txMock.$queryRaw.mock.calls[0])
    for (const sql of [requestSql, replySql]) {
      for (const marker of MARKERS) expect(sql).toContain(`${marker} IS NULL`)
      expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    }
  })

  it('fences rollback and the generic stale sweep with the same marker-null predicate', async () => {
    await rollbackQueueClaim('aaaaaaaa-0000-4000-8000-000000000001', 'mcp:i:t')
    const rollbackSql = sqlOf(txMock.$queryRaw.mock.calls[0])
    txMock.$queryRaw.mockClear()
    await sweepStaleQueueClaims()
    const sweepSql = sqlOf(txMock.$queryRaw.mock.calls[0])
    for (const marker of MARKERS) {
      expect(rollbackSql).toContain(`${marker} IS NULL`)
      expect(sweepSql).toContain(`${marker} IS NULL`)
    }
  })
})
