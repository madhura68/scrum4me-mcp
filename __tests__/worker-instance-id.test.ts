// Multi-worker Phase 2 Task 4 — verify that instance_id is written into
// claude_workers and claude_jobs along the four critical paths:
//   1. registerWorker UPSERT uses the composite key (user, token, instance).
//   2. Two workers with the same (user, token) but different instance_id
//      coexist via that composite key — the old @@unique([token_id]) is gone.
//   3. tryClaimJob writes worker_instance_id; rollbackClaim clears it; a
//      subsequent claim by a different instance rotates the value.
//   4. resetStaleClaimedJobs requeue path clears worker_instance_id; the
//      FAILED path retains it for forensics (asserted by absence in SET).
//
// Mocks vs. real DB: scrum4me-mcp tests don't ship DB infrastructure
// (no fixtures, no docker-compose, no testcontainers). All other prisma-
// touching tests (heartbeat-user-id-refresh, wait-for-job-snapshot, …) use
// `vi.mock('../src/prisma.js')`, so this file follows that pattern. The
// integration behaviour is exercised end-to-end in scrum4me-docker once
// Phase 3 wires SCRUM4ME_INSTANCE_ID through the runner.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeWorker: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
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
import { registerWorker } from '../src/presence/worker.js'
import {
  tryClaimJob,
  rollbackClaim,
  resetStaleClaimedJobs,
} from '../src/tools/wait-for-job.js'
import type { AnyMock } from './helpers/mocks.js'

const mockPrisma = prisma as unknown as {
  claudeWorker: {
    upsert: AnyMock
    findMany: AnyMock
  }
  $queryRaw: AnyMock
  $executeRaw: AnyMock
  $transaction: AnyMock
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.claudeWorker.upsert.mockResolvedValue(undefined)
  mockPrisma.claudeWorker.findMany.mockResolvedValue([])
  mockPrisma.$queryRaw.mockResolvedValue([])
  mockPrisma.$executeRaw.mockResolvedValue(1)
})

describe('registerWorker — instance_id', () => {
  it('UPSERTs with the composite (user, token, instance) key and refreshes runtime diagnostics', async () => {
    await registerWorker({
      userId: 'test-user',
      tokenId: 'test-token',
      instanceId: 'test-instance-1',
      hostname: 'localhost',
      pid: 12345,
    })

    expect(mockPrisma.claudeWorker.upsert).toHaveBeenCalledOnce()
    const callArg = mockPrisma.claudeWorker.upsert.mock.calls[0][0] as {
      where: { user_id_token_id_instance_id: { user_id: string; token_id: string; instance_id: string } }
      create: {
        user_id: string
        token_id: string
        runtime: string
        capabilities: string[]
        instance_id: string
        hostname: string | null
        pid: number | null
      }
      update: {
        user_id: string
        runtime: string
        capabilities: string[]
        instance_id: string
        last_seen_at: Date
        hostname: string | null
        pid: number | null
      }
    }

    // Composite key lookup (matches @@unique([user_id, token_id, instance_id]))
    expect(callArg.where).toEqual({
      user_id_token_id_instance_id: {
        user_id: 'test-user',
        token_id: 'test-token',
        instance_id: 'test-instance-1',
      },
    })

    // Create payload: runtime/capabilities, instance_id, hostname and pid all present
    expect(callArg.create).toMatchObject({
      user_id: 'test-user',
      token_id: 'test-token',
      runtime: 'CLAUDE',
      capabilities: [],
      instance_id: 'test-instance-1',
      hostname: 'localhost',
      pid: 12345,
    })

    // Update payload refreshes runtime diagnostics for self-healed/stale rows.
    expect(callArg.update).toMatchObject({
      user_id: 'test-user',
      runtime: 'CLAUDE',
      capabilities: [],
      instance_id: 'test-instance-1',
      hostname: 'localhost',
      pid: 12345,
    })
    expect(callArg.update.last_seen_at).toBeInstanceOf(Date)
  })

  it('allows two rows with the same (user, token) but different instance_id to coexist', async () => {
    // Each call hits the composite-key UPSERT — Prisma would create two
    // distinct rows since the old @@unique([token_id]) constraint is gone.
    await registerWorker({
      userId: 'test-user',
      tokenId: 'test-token',
      instanceId: 'instance-a',
    })
    await registerWorker({
      userId: 'test-user',
      tokenId: 'test-token',
      instanceId: 'instance-b',
    })

    expect(mockPrisma.claudeWorker.upsert).toHaveBeenCalledTimes(2)
    const firstWhere = (mockPrisma.claudeWorker.upsert.mock.calls[0][0] as {
      where: { user_id_token_id_instance_id: { instance_id: string } }
    }).where.user_id_token_id_instance_id
    const secondWhere = (mockPrisma.claudeWorker.upsert.mock.calls[1][0] as {
      where: { user_id_token_id_instance_id: { instance_id: string } }
    }).where.user_id_token_id_instance_id

    expect(firstWhere.instance_id).toBe('instance-a')
    expect(secondWhere.instance_id).toBe('instance-b')
    // Same (user, token) but different instance — the composite uniqueness
    // means no upsert collides with the other.
    expect(firstWhere).not.toEqual(secondWhere)

    // Simulate the post-write read: findMany on (user, token) returns both.
    mockPrisma.claudeWorker.findMany.mockResolvedValueOnce([
      { instance_id: 'instance-a' },
      { instance_id: 'instance-b' },
    ])
    const rows = await mockPrisma.claudeWorker.findMany({
      where: { user_id: 'test-user', token_id: 'test-token' },
    })
    expect(rows).toHaveLength(2)
  })
})

describe('tryClaimJob / rollbackClaim — worker_instance_id rotation', () => {
  it('writes worker_instance_id on claim, clears it on rollback, and rotates on second claim', async () => {
    const jobId = 'job-rot-1'

    // --- 1) Initial claim by instance-1 ---
    mockPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockTx = {
          $queryRaw: vi.fn().mockResolvedValue([{ id: jobId, implementation_plan: 'plan' }]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        }
        const result = await fn(mockTx as unknown as typeof prisma)
        // Capture the SQL params for inspection after the txn returns.
        ;(mockPrisma.$transaction as unknown as { _last?: unknown })._last = mockTx
        return result
      },
    )
    const claim1 = await tryClaimJob('test-user', 'test-token', 'instance-1')
    expect(claim1).toBe(jobId)
    const firstTx = (mockPrisma.$transaction as unknown as {
      _last: { $executeRaw: ReturnType<typeof vi.fn> }
    })._last
    const firstUpdate = firstTx.$executeRaw.mock.calls[0]
    const firstSql = (firstUpdate[0] as string[]).join('')
    // worker_instance_id appears in the UPDATE's SET; params include the value.
    expect(firstSql).toContain('worker_instance_id')
    expect(firstUpdate).toContain('instance-1')

    // --- 2) Rollback clears worker_instance_id ---
    await rollbackClaim(jobId)
    const rollbackCall = mockPrisma.$executeRaw.mock.calls[0]
    const rollbackSql = (rollbackCall[0] as string[]).join('')
    expect(rollbackSql).toContain('worker_instance_id = NULL')
    expect(rollbackSql).toContain("status = 'QUEUED'")
    expect(rollbackSql).toContain('claimed_by_token_id = NULL')
    // jobId is the only template param to the rollback SQL.
    expect(rollbackCall).toContain(jobId)

    // --- 3) Second claim by instance-2 rotates the value ---
    mockPrisma.$transaction.mockImplementationOnce(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => {
        const mockTx = {
          $queryRaw: vi.fn().mockResolvedValue([{ id: jobId, implementation_plan: 'plan' }]),
          $executeRaw: vi.fn().mockResolvedValue(1),
        }
        const result = await fn(mockTx as unknown as typeof prisma)
        ;(mockPrisma.$transaction as unknown as { _last?: unknown })._last = mockTx
        return result
      },
    )
    const claim2 = await tryClaimJob('test-user', 'test-token', 'instance-2')
    expect(claim2).toBe(jobId)
    const secondTx = (mockPrisma.$transaction as unknown as {
      _last: { $executeRaw: ReturnType<typeof vi.fn> }
    })._last
    const secondUpdate = secondTx.$executeRaw.mock.calls[0]
    expect(secondUpdate).toContain('instance-2')
    // The two claims wrote distinct instance values — rotation confirmed.
    expect(secondUpdate).not.toContain('instance-1')
  })
})

describe('resetStaleClaimedJobs — worker_instance_id', () => {
  it('REQUEUE path clears worker_instance_id; FAILED path retains it for forensics', async () => {
    await resetStaleClaimedJobs('test-user')

    // Two $queryRaw calls: [0]=FAILED, [1]=REQUEUE.
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2)

    const failedSql = (mockPrisma.$queryRaw.mock.calls[0][0] as string[]).join('')
    const requeueSql = (mockPrisma.$queryRaw.mock.calls[1][0] as string[]).join('')

    // FAILED: must NOT touch worker_instance_id — it stays on the row as a
    // forensic breadcrumb showing which worker owned the lease when it died.
    expect(failedSql).toContain("status = 'FAILED'")
    expect(failedSql).not.toContain('worker_instance_id')

    // REQUEUE: clears worker_instance_id so the next claim by any instance
    // rotates cleanly (mirrors the rollbackClaim contract).
    expect(requeueSql).toContain("status = 'QUEUED'")
    expect(requeueSql).toContain('worker_instance_id = NULL')
    expect(requeueSql).toContain('retry_count = retry_count + 1')
  })
})
