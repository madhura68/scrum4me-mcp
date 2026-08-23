import { beforeEach, describe, expect, it, vi } from 'vitest'

const transactionMock = vi.hoisted(() => vi.fn())

vi.mock('../src/prisma.js', () => ({
  prisma: { $transaction: transactionMock },
}))

import { registerMarkedConsumer } from '../src/tools/queue-register-consumer.js'

const input = {
  run_id: '11111111-1111-4111-8111-111111111111',
  run_generation: 1,
  orchestrator_generation: 3,
  fence_sha256: 'a'.repeat(64),
  lane: 'lane-codex' as const,
  generation: 1,
  operation_key: 'register:lane-codex:1',
  config_sha256: 'b'.repeat(64),
  attestation_sha256: 'c'.repeat(64),
}

const validAuthority = {
  run_generation: 1,
  run_state: 'ACTIVE',
  principal: `orchestrator:${input.run_id}`,
  orchestrator_generation: 3,
  owner_principal: `orchestrator:${input.run_id}`,
  lease_expires_at: new Date(Date.now() + 60_000),
  fence_sha256: input.fence_sha256,
}

const replay = {
  consumer_id: '22222222-2222-4222-8222-222222222222',
  run_id: input.run_id,
  lane: input.lane,
  generation: input.generation,
  operation_key: input.operation_key,
  config_sha256: input.config_sha256,
  attestation_sha256: input.attestation_sha256,
  status: 'READY_ACK',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('queue_register_consumer replay fencing', () => {
  it('rejects a known operation-key replay when the current fence is stale', async () => {
    const queryRawUnsafe = vi.fn().mockResolvedValueOnce([
      { ...validAuthority, fence_sha256: 'd'.repeat(64) },
    ])
    transactionMock.mockImplementation(async (run) => run({ $queryRawUnsafe: queryRawUnsafe }))

    await expect(registerMarkedConsumer(input)).rejects.toThrow('PPE_FENCE_MISMATCH')
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1)
    expect(queryRawUnsafe.mock.calls[0]?.[0]).toContain('FROM ppe_run_registry')
  })

  it('returns an identical replay only after locking and validating current authority', async () => {
    const queryRawUnsafe = vi.fn()
      .mockResolvedValueOnce([validAuthority])
      .mockResolvedValueOnce([replay])
    transactionMock.mockImplementation(async (run) => run({ $queryRawUnsafe: queryRawUnsafe }))

    await expect(registerMarkedConsumer(input)).resolves.toEqual(replay)
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2)
    expect(queryRawUnsafe.mock.calls[0]?.[0]).toContain('FROM ppe_run_registry')
    expect(queryRawUnsafe.mock.calls[1]?.[0]).toContain('FROM ppe_consumer')
  })
})
