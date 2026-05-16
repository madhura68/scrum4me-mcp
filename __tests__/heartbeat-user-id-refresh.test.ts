// Regression: an admin can re-point ApiToken.user_id via
// scripts/migrate-user.ts while a worker is running. The heartbeat must
// pick up the new user_id without requiring a worker restart. Prior to the
// fix, auth.ts cached AuthContext for the process lifetime and the
// heartbeat closure captured opts.userId, so ClaudeWorker rows kept the
// pre-migration owner.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    apiToken: { findUnique: vi.fn() },
    claudeWorker: {
      updateMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

vi.mock('pg', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
  })),
}))

import { prisma } from '../src/prisma.js'
import { startHeartbeat } from '../src/presence/heartbeat.js'

const mockPrisma = prisma as unknown as {
  apiToken: { findUnique: ReturnType<typeof vi.fn> }
  claudeWorker: {
    updateMany: ReturnType<typeof vi.fn>
    upsert: ReturnType<typeof vi.fn>
    deleteMany: ReturnType<typeof vi.fn>
  }
}

const TOKEN_ID = 'tok-1'
const INTERVAL = 100

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mockPrisma.claudeWorker.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.claudeWorker.upsert.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startHeartbeat — token user_id re-resolution', () => {
  it('picks up new ApiToken.user_id on the next tick after a user migration without restart', async () => {
    // Tick 1: token belongs to old owner
    mockPrisma.apiToken.findUnique.mockResolvedValueOnce({
      user_id: 'user-lars',
      revoked_at: null,
    })

    const { stop } = startHeartbeat({ tokenId: TOKEN_ID, intervalMs: INTERVAL })

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(mockPrisma.apiToken.findUnique).toHaveBeenCalledWith({
      where: { id: TOKEN_ID },
      select: { user_id: true, revoked_at: true },
    })
    expect(mockPrisma.claudeWorker.updateMany).toHaveBeenLastCalledWith({
      where: { token_id: TOKEN_ID },
      data: expect.objectContaining({ user_id: 'user-lars' }),
    })

    // Simulate migration: same token row, different owner.
    mockPrisma.apiToken.findUnique.mockResolvedValueOnce({
      user_id: 'user-janpeter',
      revoked_at: null,
    })

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(mockPrisma.claudeWorker.updateMany).toHaveBeenLastCalledWith({
      where: { token_id: TOKEN_ID },
      data: expect.objectContaining({ user_id: 'user-janpeter' }),
    })

    stop()
  })

  it('passes the freshly-resolved user_id to registerWorker when the row was deleted', async () => {
    // Worker row disappeared (count === 0) → heartbeat must re-register
    // using the *current* token.user_id, not a value captured at startup.
    mockPrisma.apiToken.findUnique.mockResolvedValueOnce({
      user_id: 'user-janpeter',
      revoked_at: null,
    })
    mockPrisma.claudeWorker.updateMany.mockResolvedValueOnce({ count: 0 })

    const { stop } = startHeartbeat({ tokenId: TOKEN_ID, intervalMs: INTERVAL })

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(mockPrisma.claudeWorker.upsert).toHaveBeenCalledWith({
      where: { token_id: TOKEN_ID },
      create: expect.objectContaining({
        user_id: 'user-janpeter',
        token_id: TOKEN_ID,
      }),
      update: expect.objectContaining({ user_id: 'user-janpeter' }),
    })

    stop()
  })

  it('skips the tick when the token has been revoked', async () => {
    mockPrisma.apiToken.findUnique.mockResolvedValueOnce({
      user_id: 'user-lars',
      revoked_at: new Date(),
    })

    const { stop } = startHeartbeat({ tokenId: TOKEN_ID, intervalMs: INTERVAL })

    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(mockPrisma.claudeWorker.updateMany).not.toHaveBeenCalled()
    expect(mockPrisma.claudeWorker.upsert).not.toHaveBeenCalled()

    stop()
  })
})
