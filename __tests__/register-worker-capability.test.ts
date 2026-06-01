import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  upsert: vi.fn().mockResolvedValue({}),
}))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeWorker: { upsert: mocks.upsert },
  },
}))

vi.mock('pg', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
  })),
}))

import { registerWorker } from '../src/presence/worker.js'

beforeEach(() => mocks.upsert.mockClear())

describe('registerWorker capability', () => {
  it('persists capability when provided', async () => {
    await registerWorker({
      userId: 'u1',
      tokenId: 't1',
      instanceId: 'i1',
      capability: 'HIGH_P',
    })
    expect(mocks.upsert).toHaveBeenCalledOnce()
    const call = mocks.upsert.mock.calls[0][0]
    expect(call.create.capability).toBe('HIGH_P')
    expect(call.update.capability).toBe('HIGH_P')
  })

  it('omits capability when undefined (legacy callers)', async () => {
    await registerWorker({
      userId: 'u1',
      tokenId: 't1',
      instanceId: 'i1',
    })
    expect(mocks.upsert).toHaveBeenCalledOnce()
    const call = mocks.upsert.mock.calls[0][0]
    expect(call.create.capability).toBeUndefined()
    expect(call.update.capability).toBeUndefined()
  })
})
