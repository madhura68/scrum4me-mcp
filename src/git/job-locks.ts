import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { acquireFileLocksOrdered } from './file-lock.js'
import {
  getProductWorktreeLockPath,
  getWorktreeRoot,
} from './worktree-paths.js'
import {
  getOrCreateProductWorktree,
  syncProductWorktree,
} from './product-worktree.js'

type JobReleases = Map<string, Array<() => Promise<void>>>
const jobReleases: JobReleases = new Map()

export async function setupProductWorktrees(
  jobId: string,
  productIds: string[],
  resolveRepoRoot: (productId: string) => Promise<string | null>,
): Promise<Array<{ productId: string; worktreePath: string }>> {
  if (productIds.length === 0) return []

  // Ensure parent dir exists so lockfile creation succeeds
  await fs.mkdir(path.join(getWorktreeRoot(), '_products'), { recursive: true })

  // Lock-first, alphabetically sorted (deadlock prevention for multi-product idea-jobs).
  // Locks acquired in sorted order; output preserves caller's input order so that
  // worktrees[0] is the primary product (Idea.product_id), regardless of how its
  // id sorts alphabetically against secondary products.
  const sorted = [...productIds].sort()
  const lockPaths = sorted.map(getProductWorktreeLockPath)
  const releaseAll = await acquireFileLocksOrdered(lockPaths)
  registerJobLockReleases(jobId, [releaseAll])

  // After lock-acquire, create/reuse worktrees and sync — iterate input order
  // so callers get back [primary, ...secondaries] in their original sequence.
  const out: Array<{ productId: string; worktreePath: string }> = []
  for (const productId of productIds) {
    const repoRoot = await resolveRepoRoot(productId)
    if (!repoRoot) continue
    const { worktreePath } = await getOrCreateProductWorktree({ repoRoot, productId })
    await syncProductWorktree({ worktreePath })
    out.push({ productId, worktreePath })
  }

  return out
}

export function registerJobLockReleases(
  jobId: string,
  releases: Array<() => Promise<void>>,
): void {
  const existing = jobReleases.get(jobId) ?? []
  jobReleases.set(jobId, [...existing, ...releases])
}

export async function releaseLocksOnTerminal(jobId: string): Promise<void> {
  const releases = jobReleases.get(jobId)
  if (!releases) return // idempotent — already released or never locked
  jobReleases.delete(jobId)
  for (const release of releases) {
    try {
      await release()
    } catch (err) {
      console.warn(`[job-locks] release failed for job ${jobId}:`, err)
    }
  }
}

// For tests
export function _resetJobReleasesForTest(): void {
  jobReleases.clear()
}
