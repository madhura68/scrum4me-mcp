import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { getWorktreeRoot } from './worktree-paths.js'

const exec = promisify(execFile)

async function branchExists(repoRoot: string, name: string): Promise<boolean> {
  try {
    await exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repoRoot })
    return true
  } catch {
    return false
  }
}

async function findWorktreeForBranch(
  repoRoot: string,
  branchName: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot })
    // Porcelain blocks: worktree <path>\nHEAD <sha>\nbranch refs/heads/<name>\n\n
    const blocks = stdout.split('\n\n').filter(Boolean)
    for (const block of blocks) {
      const lines = block.split('\n')
      const wt = lines.find((l) => l.startsWith('worktree '))?.slice(9)
      const br = lines.find((l) => l.startsWith('branch '))?.slice(7) // refs/heads/<name>
      if (wt && br && br === `refs/heads/${branchName}`) return wt
    }
    return null
  } catch {
    return null
  }
}

export async function createWorktreeForJob(opts: {
  repoRoot: string
  jobId: string
  branchName: string
  baseRef?: string
  /**
   * When true the branch is expected to exist already (sibling job created it).
   * If a stale sibling worktree still occupies the branch, it is removed first
   * — siblings are sequential, so this is safe.
   */
  reuseBranch?: boolean
}): Promise<{ worktreePath: string; branchName: string }> {
  const { repoRoot, jobId, baseRef = 'origin/main', reuseBranch = false } = opts
  let { branchName } = opts

  const parent = getWorktreeRoot()

  await fs.mkdir(parent, { recursive: true })

  const worktreePath = path.join(parent, jobId)

  // Reject if worktree path already exists — caller must remove it first
  try {
    await fs.access(worktreePath)
    throw new Error(
      `Worktree path already exists: ${worktreePath}. Call removeWorktreeForJob first.`,
    )
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  await exec('git', ['fetch', 'origin', '--prune'], { cwd: repoRoot })

  if (reuseBranch) {
    // Sibling task already created the branch; check it out into a fresh worktree.
    // If the branch is still attached to a stale sibling worktree, drop that first.
    const occupant = await findWorktreeForBranch(repoRoot, branchName)
    if (occupant) {
      await exec('git', ['worktree', 'remove', '--force', occupant], { cwd: repoRoot })
    }
    await exec('git', ['worktree', 'add', worktreePath, branchName], { cwd: repoRoot })
    return { worktreePath, branchName }
  }

  // Fresh branch: if a local branch with this name already exists, it is an
  // orphan from a prior failed run (the agent didn't push or branch was
  // never tied to a worktree). Remove the orphan so the new worktree gets
  // the predictable `feat/story-<id>`-name; this prevents the kind of
  // 2-May-2026 failure where the agent inherited an unrelated suffix and
  // pushed to a non-existent remote ref.
  if (await branchExists(repoRoot, branchName)) {
    const occupant = await findWorktreeForBranch(repoRoot, branchName)
    if (occupant) {
      // Branch is currently checked out elsewhere — likely a sibling worktree
      // that should have been cleaned up. Remove it before reusing the name.
      try {
        await exec('git', ['worktree', 'remove', '--force', occupant], { cwd: repoRoot })
      } catch {
        // ignore — fall through to deletion below
      }
    }
    try {
      await exec('git', ['branch', '-D', branchName], { cwd: repoRoot })
      console.warn(`[createWorktreeForJob] removed orphan branch ${branchName} before recreate`)
    } catch {
      // last resort: timestamp-suffix to avoid collision rather than fail
      branchName = `${branchName}-${Date.now()}`
    }
  }

  await exec('git', ['worktree', 'add', '-b', branchName, worktreePath, baseRef], {
    cwd: repoRoot,
  })

  return { worktreePath, branchName }
}

export async function removeWorktreeForJob(opts: {
  repoRoot: string
  jobId: string
  keepBranch?: boolean
}): Promise<{ removed: boolean }> {
  const { repoRoot, jobId, keepBranch = false } = opts

  const parent = getWorktreeRoot()

  const worktreePath = path.join(parent, jobId)

  try {
    await fs.access(worktreePath)
  } catch {
    return { removed: false }
  }

  let branchName: string | undefined
  if (!keepBranch) {
    try {
      const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: worktreePath,
      })
      branchName = stdout.trim()
    } catch {
      // worktree HEAD unreadable — skip branch deletion
    }
  }

  await exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot })

  if (!keepBranch && branchName && (await branchExists(repoRoot, branchName))) {
    await exec('git', ['branch', '-D', branchName], { cwd: repoRoot })
  }

  return { removed: true }
}
