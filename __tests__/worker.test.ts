import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeWorker: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

import { prisma } from '../src/prisma.js'
import { registerWorker, unregisterWorker } from '../src/presence/worker.js'

const mockPrisma = prisma as unknown as {
  claudeWorker: { upsert: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.claudeWorker.upsert.mockResolvedValue({})
  mockPrisma.claudeWorker.deleteMany.mockResolvedValue({ count: 1 })
})

describe('registerWorker', () => {
  it('upserts a ClaudeWorker record for the given token', async () => {
    await registerWorker({ userId: 'u1', tokenId: 't1' })

    expect(mockPrisma.claudeWorker.upsert).toHaveBeenCalledWith({
      where: { token_id: 't1' },
      create: { user_id: 'u1', token_id: 't1', product_id: null },
      update: { last_seen_at: expect.any(Date), product_id: null },
    })
  })

  it('passes product_id to upsert when provided', async () => {
    await registerWorker({ userId: 'u1', tokenId: 't1', productId: 'p1' })

    expect(mockPrisma.claudeWorker.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ product_id: 'p1' }),
        update: expect.objectContaining({ product_id: 'p1' }),
      }),
    )
  })

  it('sends pg_notify worker_connected with correct payload', async () => {
    const mockNotify = vi.fn().mockResolvedValue(undefined)

    await registerWorker({ userId: 'u1', tokenId: 't1', productId: 'p1', notify: mockNotify })

    expect(mockNotify).toHaveBeenCalledWith({
      type: 'worker_connected',
      user_id: 'u1',
      token_id: 't1',
      product_id: 'p1',
    })
  })

  it('does not throw when notify fails', async () => {
    const mockNotify = vi.fn().mockRejectedValue(new Error('pg down'))

    await expect(
      registerWorker({ userId: 'u1', tokenId: 't1', notify: mockNotify }),
    ).resolves.toBeUndefined()
    expect(mockPrisma.claudeWorker.upsert).toHaveBeenCalled()
  })
})

describe('unregisterWorker', () => {
  it('deletes the ClaudeWorker record for the token', async () => {
    await unregisterWorker({ userId: 'u1', tokenId: 't1' })

    expect(mockPrisma.claudeWorker.deleteMany).toHaveBeenCalledWith({ where: { token_id: 't1' } })
  })

  it('sends pg_notify worker_disconnected', async () => {
    const mockNotify = vi.fn().mockResolvedValue(undefined)

    await unregisterWorker({ userId: 'u1', tokenId: 't1', notify: mockNotify })

    expect(mockNotify).toHaveBeenCalledWith({
      type: 'worker_disconnected',
      user_id: 'u1',
      token_id: 't1',
    })
  })

  it('does not throw when notify fails during unregister', async () => {
    const mockNotify = vi.fn().mockRejectedValue(new Error('pg down'))

    await expect(
      unregisterWorker({ userId: 'u1', tokenId: 't1', notify: mockNotify }),
    ).resolves.toBeUndefined()
  })
})
