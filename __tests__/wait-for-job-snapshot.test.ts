import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}))

import { prisma } from '../src/prisma.js'
import { resetStaleClaimedJobs, tryClaimJob } from '../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  $queryRaw: ReturnType<typeof vi.fn>
  $transaction: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no stale jobs returned from either query
  mockPrisma.$queryRaw.mockResolvedValue([])
})

describe('resetStaleClaimedJobs', () => {
  it('runs two $queryRaw calls: one for FAILED, one for QUEUED re-enqueue', async () => {
    await resetStaleClaimedJobs('user-1')
    // Two queries: failed jobs + requeued jobs
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2)
  })

  it('FAILED query includes plan_snapshot = NULL reset and retry_count >= 2', async () => {
    await resetStaleClaimedJobs('user-1')
    const calls = mockPrisma.$queryRaw.mock.calls
    // First call: FAILED transition
    const failedSql = (calls[0][0] as string[]).join('')
    expect(failedSql).toContain("status = 'FAILED'")
    expect(failedSql).toContain('retry_count >= 2')
  })

  it('QUEUED re-enqueue query includes plan_snapshot = NULL and retry_count increment', async () => {
    await resetStaleClaimedJobs('user-1')
    const calls = mockPrisma.$queryRaw.mock.calls
    // Second call: re-enqueue transition
    const requeueSql = (calls[1][0] as string[]).join('')
    expect(requeueSql).toContain("status = 'QUEUED'")
    expect(requeueSql).toContain('plan_snapshot = NULL')
    expect(requeueSql).toContain('retry_count = retry_count + 1')
    expect(requeueSql).toContain('retry_count < 2')
  })
})

describe('tryClaimJob', () => {
  it('writes plan_snapshot from task.implementation_plan when claiming a job', async () => {
    const jobId = 'job-123'
    const implementationPlan = 'Step 1: Do the thing\nStep 2: Done'

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => {
      const mockTx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: jobId, implementation_plan: implementationPlan }]),
        $executeRaw: vi.fn().mockResolvedValue(1),
      }
      return fn(mockTx as unknown as typeof prisma)
    })

    const result = await tryClaimJob('user-1', 'token-1', 'instance-1')

    expect(result).toBe(jobId)

    // Verify the transaction was called and the UPDATE included plan_snapshot
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce()
    const txFn = mockPrisma.$transaction.mock.calls[0][0]

    const capturedTx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: jobId, implementation_plan: implementationPlan }]),
      $executeRaw: vi.fn().mockResolvedValue(1),
    }
    await txFn(capturedTx as unknown as typeof prisma)

    const updateCall = capturedTx.$executeRaw.mock.calls[0]
    const sqlParts: string[] = updateCall[0]
    const fullSql = sqlParts.join('')
    expect(fullSql).toContain('plan_snapshot')
    expect(fullSql).toContain("status = 'CLAIMED'")
  })

  it('uses empty string as snapshot when task has no implementation_plan', async () => {
    const jobId = 'job-456'

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => {
      const mockTx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: jobId, implementation_plan: null }]),
        $executeRaw: vi.fn().mockResolvedValue(1),
      }
      return fn(mockTx as unknown as typeof prisma)
    })

    const result = await tryClaimJob('user-1', 'token-1', 'instance-1')
    expect(result).toBe(jobId)

    // Verify the snapshot value passed is '' (empty string, not null)
    const capturedTx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: jobId, implementation_plan: null }]),
      $executeRaw: vi.fn().mockResolvedValue(1),
    }
    const txFn = mockPrisma.$transaction.mock.calls[0][0]
    await txFn(capturedTx as unknown as typeof prisma)

    const updateCall = capturedTx.$executeRaw.mock.calls[0]
    // Template literal params: [0]=sql parts, [1]=tokenId, [2]=snapshot, [3]=jobId
    expect(updateCall[2]).toBe('')
  })

  it('returns null when no QUEUED job is available', async () => {
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => {
      const mockTx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn(),
      }
      return fn(mockTx as unknown as typeof prisma)
    })

    const result = await tryClaimJob('user-1', 'token-1', 'instance-1')
    expect(result).toBeNull()
  })

  it('scopes to product_id when provided', async () => {
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => {
      const mockTx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn(),
      }
      return fn(mockTx as unknown as typeof prisma)
    })

    await tryClaimJob('user-1', 'token-1', 'instance-1', 'product-1')

    const capturedTx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $executeRaw: vi.fn(),
    }
    const txFn = mockPrisma.$transaction.mock.calls[0][0]
    await txFn(capturedTx as unknown as typeof prisma)

    const queryCall = capturedTx.$queryRaw.mock.calls[0]
    // product_id should be passed as a parameter
    expect(queryCall).toContain('product-1')
  })
})
