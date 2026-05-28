import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { getWorktreeRoot } from './worktree-paths.js'
import { withRetry, isTransientGitError } from './retry.js'
import { claimLog } from '../lib/claim-log.js'

const exec = promisify(execFile)

async function branchExists(repoRoot: string, name: string): Promise<boolean> {
  try {
    await exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repoRoot })
    return true
  } catch {
    return false
  }
}

async function remoteBranchExists(repoRoot: string, name: string): Promise<boolean> {
  try {
    await exec(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`],
      { cwd: repoRoot },
    )
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

// Symlink the repoRoot's node_modules into a fresh worktree. A git worktree
// starts with an empty (gitignored) node_modules, so lint/typecheck/test tools
// (eslint/tsc/vitest, incl. vitest's rolldown native binding) won't resolve.
// repoRoot deps are installed once by repo-bootstrap.sh; symlinking avoids a
// per-job npm install. Best-effort: never fail worktree creation over this.
//
// NOTE: requires the repoRoot/worktree filesystem to allow exec — on a noexec
// mount the linked binaries still fail with EACCES (126) / ERR_DLOPEN_FAILED.
async function linkNodeModules(repoRoot: string, worktreePath: string, jobId: string): Promise<void> {
  const src = path.join(repoRoot, 'node_modules')
  const dest = path.join(worktreePath, 'node_modules')
  try {
    await fs.access(src)
  } catch {
    return // repoRoot has no deps to share — nothing to do
  }
  try {
    await fs.symlink(src, dest, 'dir')
    claimLog('worktree.nodeModulesLinked', { jobId, src, dest })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      claimLog('worktree.nodeModulesLinkFailed', {
        jobId,
        error: String((err as Error).message).slice(0, 200),
      })
    }
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

  const gitRetry = (args: string[]) =>
    withRetry(() => exec('git', args, { cwd: repoRoot }), {
      isRetryable: isTransientGitError,
      onRetry: (attempt, err) =>
        claimLog('worktree.git.retry', {
          jobId,
          args: args.join(' '),
          attempt,
          error: String((err as Error).message).slice(0, 200),
        }),
    })

  // Reject if worktree path already exists — caller must remove it first
  try {
    await fs.access(worktreePath)
    throw new Error(
      `Worktree path already exists: ${worktreePath}. Call removeWorktreeForJob first.`,
    )
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  await gitRetry(['fetch', 'origin', '--prune'])

  if (reuseBranch) {
    // Sibling task already created the branch; check it out into a fresh worktree.
    // If the branch is still attached to a stale sibling worktree, drop that first.
    const occupant = await findWorktreeForBranch(repoRoot, branchName)
    if (occupant) {
      await exec('git', ['worktree', 'remove', '--force', occupant], { cwd: repoRoot })
    }
    // reuseBranch is decided sprint-wide, but git branches are per-repo. For a
    // cross-repo sprint the first job targeting THIS repo gets reuseBranch=true
    // even though the branch was never created here; a container recreate also
    // wipes the local clone. Fall back gracefully instead of failing with
    // "invalid reference":
    //   - exists on origin      → reset local to origin/<branch> and use the current tip
    //   - local-only (unpushed) → reuse the local branch as-is
    //   - nowhere               → create it fresh from baseRef
    if (await remoteBranchExists(repoRoot, branchName)) {
      // `-B` create-or-resets <branch> to origin/<branch> and checks it out, so a
      // stale kept local ref can't make the worktree (and the base_sha captured next)
      // lag the real tip — which would otherwise cause a non-ff push.
      // Safe under the sequential-sibling protocol: a reused branch was already pushed
      // by an earlier sibling, so the local ref is at-or-behind origin — the reset
      // discards no unpushed local commits.
      await gitRetry(['worktree', 'add', '-B', branchName, worktreePath, `origin/${branchName}`])
    } else if (await branchExists(repoRoot, branchName)) {
      await gitRetry(['worktree', 'add', worktreePath, branchName])
    } else {
      await gitRetry(['worktree', 'add', '-b', branchName, worktreePath, baseRef])
    }
    claimLog('worktree.created', { jobId, branchName, worktreePath, reuse: reuseBranch })
    await linkNodeModules(repoRoot, worktreePath, jobId)
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
      claimLog('worktree.orphanBranchRemoved', { jobId, branchName })
    } catch {
      // last resort: timestamp-suffix to avoid collision rather than fail
      branchName = `${branchName}-${Date.now()}`
    }
  }

  await gitRetry(['worktree', 'add', '-b', branchName, worktreePath, baseRef])

  claimLog('worktree.created', { jobId, branchName, worktreePath, reuse: reuseBranch })
  await linkNodeModules(repoRoot, worktreePath, jobId)
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

  try {
    await exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot })
  } catch {
    // The path exists but git doesn't track it as a worktree — a partially
    // failed `git worktree add`, a manual leftover, or a container recreate
    // that wiped the clone. Remove the directory directly and prune any stale
    // worktree admin entry so a later `worktree add` to this path doesn't loop
    // forever on "Worktree path already exists".
    await fs.rm(worktreePath, { recursive: true, force: true })
    await exec('git', ['worktree', 'prune'], { cwd: repoRoot }).catch(() => {})
  }

  if (!keepBranch && branchName && (await branchExists(repoRoot, branchName))) {
    await exec('git', ['branch', '-D', branchName], { cwd: repoRoot })
  }

  return { removed: true }
}
