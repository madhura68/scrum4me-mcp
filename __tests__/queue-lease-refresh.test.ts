import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    agentMessage: { updateMany: vi.fn() },
  },
}))

import { prisma } from '../src/prisma.js'
import { refreshQueueLeases, startQueueLeaseRefresh } from '../src/queue/lease-refresh.js'
import { registerLease, leaseEntries, clearLeases } from '../src/queue/lease-register.js'

const mockPrisma = prisma as unknown as {
  agentMessage: { updateMany: ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearLeases()
  mockPrisma.agentMessage.updateMany.mockResolvedValue({ count: 1 })
})

describe('refreshQueueLeases — §6.1 lease-verversing', () => {
  it('ververst claimed_at uitsluitend voor exact matchende rijen (strikte gelijkheid, geen LIKE)', async () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    await refreshQueueLeases()
    expect(mockPrisma.agentMessage.updateMany).toHaveBeenCalledWith({
      where: { id: 'msg-1', status: 'claimed', claimed_by: 'mcp:inst:tok-1' },
      data: { claimed_at: expect.any(Date) },
    })
  })

  it('ververst alle geregistreerde leases per tick', async () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    registerLease('msg-2', { claimToken: 'tok-2', claimedBy: 'mcp:inst:tok-2' })
    await refreshQueueLeases()
    expect(mockPrisma.agentMessage.updateMany).toHaveBeenCalledTimes(2)
  })

  it('snoeit een entry zodra de update géén rij raakt (§8 lease-pruning: handmatige requeue + refresh-tick)', async () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    // Handmatige CLI-requeue buiten de MCP om: rij is niet langer claimed door ons.
    mockPrisma.agentMessage.updateMany.mockResolvedValueOnce({ count: 0 })
    await refreshQueueLeases()
    expect(leaseEntries()).toHaveLength(0)
    // Volgende tick ververst niets meer voor deze entry.
    await refreshQueueLeases()
    expect(mockPrisma.agentMessage.updateMany).toHaveBeenCalledTimes(1)
  })

  it('behoudt de entry bij een DB-fout (volgende tick probeert opnieuw)', async () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    mockPrisma.agentMessage.updateMany.mockRejectedValueOnce(new Error('db weg'))
    await refreshQueueLeases()
    expect(leaseEntries()).toHaveLength(1)
  })
})

describe('startQueueLeaseRefresh', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('tikt op het opgegeven interval en stopt via stop()', async () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    const { stop } = startQueueLeaseRefresh({ intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(250)
    expect(mockPrisma.agentMessage.updateMany).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(mockPrisma.agentMessage.updateMany).toHaveBeenCalledTimes(2)
  })

  it('unreft de timer zodat hij de event-loop niet openhoudt', () => {
    const unref = vi.fn()
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as never)
    startQueueLeaseRefresh({ intervalMs: 100 })
    expect(unref).toHaveBeenCalled()
    spy.mockRestore()
  })
})
