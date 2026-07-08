import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock factories are hoisted, so the mock fns must be created via vi.hoisted.
const { cloneMock, findUniqueMock } = vi.hoisted(() => ({
  cloneMock: vi.fn(),
  findUniqueMock: vi.fn(),
}))

// cloneRepoOnDemand is mocked; the real error classes are kept so resolveRepoRoot's
// instanceof checks still work.
vi.mock('../src/git/on-demand-clone.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/git/on-demand-clone.js')>()
  return { ...actual, cloneRepoOnDemand: cloneMock }
})

vi.mock('../src/prisma.js', () => ({
  prisma: { product: { findUnique: (...args: unknown[]) => findUniqueMock(...args) } },
}))

import { resolveRepoRoot } from '../src/tools/wait-for-job.js'
import { TerminalJobError, TransientRepoError, OwnershipLostError } from '../src/git/on-demand-clone.js'

// Names that will never exist under ~/Projects, so the convention step misses
// and we exercise the on-demand branch.
const PRODUCT_ID = 'prod-od-test-zzz'
const PRODUCT_REPO = 'https://git.jp-visser.nl/janpeter/od-test-nonexistent-product.git'
const TASK_REPO = 'https://git.jp-visser.nl/janpeter/od-test-nonexistent-task.git'
const owner = { jobId: 'j1', instanceId: 'i1', tokenId: 't1' }

beforeEach(() => {
  cloneMock.mockReset()
  findUniqueMock.mockReset()
  findUniqueMock.mockResolvedValue({ repo_url: PRODUCT_REPO })
})

describe('resolveRepoRoot on-demand integration', () => {
  it('does NOT clone when on-demand is disabled (cleanup path) → null', async () => {
    const result = await resolveRepoRoot(PRODUCT_ID, null)
    expect(result).toBeNull()
    expect(cloneMock).not.toHaveBeenCalled()
  })

  it('clones the product repo on demand when enabled', async () => {
    cloneMock.mockResolvedValue('/cloned/product')
    const result = await resolveRepoRoot(PRODUCT_ID, null, { ownerCtx: owner, allowOnDemandClone: true })
    expect(result).toBe('/cloned/product')
    expect(cloneMock).toHaveBeenCalledTimes(1)
    expect(cloneMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: PRODUCT_REPO, name: 'od-test-nonexistent-product', ownerCtx: owner }),
    )
  })

  it('clones the TASK repo and does not degrade to the product repo', async () => {
    cloneMock.mockResolvedValue('/cloned/task')
    const result = await resolveRepoRoot(PRODUCT_ID, TASK_REPO, { ownerCtx: owner, allowOnDemandClone: true })
    expect(result).toBe('/cloned/task')
    expect(cloneMock).toHaveBeenCalledTimes(1)
    expect(cloneMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: TASK_REPO, name: 'od-test-nonexistent-task' }),
    )
    // never fell through to product-level resolution
    expect(findUniqueMock).not.toHaveBeenCalled()
  })

  it('propagates a TerminalJobError (does not swallow to null)', async () => {
    cloneMock.mockRejectedValue(new TerminalJobError('repo not found'))
    await expect(
      resolveRepoRoot(PRODUCT_ID, null, { ownerCtx: owner, allowOnDemandClone: true }),
    ).rejects.toBeInstanceOf(TerminalJobError)
  })

  it('propagates OwnershipLostError', async () => {
    cloneMock.mockRejectedValue(new OwnershipLostError('j1'))
    await expect(
      resolveRepoRoot(PRODUCT_ID, TASK_REPO, { ownerCtx: owner, allowOnDemandClone: true }),
    ).rejects.toBeInstanceOf(OwnershipLostError)
  })

  it('degrades a transient clone failure to null (rollback/requeue, not throw)', async () => {
    cloneMock.mockRejectedValue(new TransientRepoError('network blip'))
    const result = await resolveRepoRoot(PRODUCT_ID, null, { ownerCtx: owner, allowOnDemandClone: true })
    expect(result).toBeNull()
  })
})
