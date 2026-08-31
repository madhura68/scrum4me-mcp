import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { getWorktreeRoot } from './worktree-paths.js'
import { withRetry, isTransientGitError } from './retry.js'
import { localTipContainedInRemote, maybeBackupPushBranch } from './branch-safety.js'
import { resolveOriginDefaultRef } from './default-branch.js'
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
//
// Absolute target is intentional: worktrees live outside repoRoot (under
// SCRUM4ME_AGENT_WORKTREE_DIR), so a relative symlink would resolve against
// the worktree directory and point nowhere.
//
// The symlink is shared across all concurrent worktrees for this repo. Tools
// that write to node_modules/.cache (vitest, eslint, rolldown) may contend on
// the same cache directory; this is self-healing (cache misses / re-builds)
// and not a source of data loss.
//
// The repoRoot deps are installed by the container's repo-bootstrap step.
// That bootstrap script lives in scrum4me-docker, not in this repository.
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

// A fresh `git worktree add` checks out the branch tree but NOT its submodules,
// so submodule-backed path aliases (e.g. tsconfig `@shared/*` →
// vendor/<submodule>/) don't resolve and lint/typecheck/test fail on every
// import of them. Init them in the worktree. Guarded on .gitmodules so this is
// a no-op for repos without submodules. Best-effort: never fail worktree
// creation over setup — verify will surface a genuine init failure instead.
async function initSubmodules(worktreePath: string, jobId: string): Promise<void> {
  try {
    await fs.access(path.join(worktreePath, '.gitmodules'))
  } catch {
    return // no submodules in this repo
  }
  try {
    await exec('git', ['submodule', 'update', '--init', '--recursive'], { cwd: worktreePath })
    claimLog('worktree.submodulesInit', { jobId })
  } catch (err) {
    claimLog('worktree.submodulesInitFailed', {
      jobId,
      error: String((err as Error).message).slice(0, 200),
    })
  }
}

// Run the repo's optional worktree-prepare hook. `verify` (lint/typecheck/test)
// expects gitignored generated files that are normally produced by a `prebuild`
// step it never triggers (e.g. a typed manifest emitted by codegen). A fresh
// worktree lacks them → spurious "Cannot find module './x.generated'" failures.
// Convention: a repo declares an npm `prepare:worktree` script that regenerates
// whatever its verify pipeline needs; we run it only when present, so this stays
// repo-agnostic. node_modules is the symlink created by linkNodeModules above.
// Best-effort: never fail worktree creation over setup.
async function runWorktreePrepare(worktreePath: string, jobId: string): Promise<void> {
  let hasHook = false
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(worktreePath, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    hasHook = Boolean(pkg.scripts?.['prepare:worktree'])
  } catch {
    return // no/unreadable package.json — nothing to run
  }
  if (!hasHook) return
  try {
    await exec('npm', ['run', 'prepare:worktree'], { cwd: worktreePath })
    claimLog('worktree.prepareHook', { jobId })
  } catch (err) {
    claimLog('worktree.prepareHookFailed', {
      jobId,
      error: String((err as Error).message).slice(0, 200),
    })
  }
}

// Set up a freshly-added worktree so `npm run verify` resolves the same imports
// it would in a full checkout: shared deps (symlink), submodule checkouts, and
// repo-specific gitignored codegen. Order matters — node_modules first so the
// prepare hook can run its npm script.
async function prepareWorktree(repoRoot: string, worktreePath: string, jobId: string): Promise<void> {
  await linkNodeModules(repoRoot, worktreePath, jobId)
  await initSubmodules(worktreePath, jobId)
  await runWorktreePrepare(worktreePath, jobId)
}

export async function createWorktreeForJob(opts: {
  repoRoot: string
  jobId: string
  branchName: string
  /**
   * Base voor een verse branch. Zonder waarde resolven we de échte default
   * branch van origin (ISS-3): een hardcoded `origin/main` maakt sprint- en
   * task-jobs onmogelijk op repo's met een andere default, zoals
   * scrum4me-docker (master) — `worktree add` faalt dan met
   * "Not a valid object name" en de job blijft claim–fail–rollback herhalen.
   */
  baseRef?: string
  /**
   * When true the branch is expected to exist already (sibling job created it).
   * If a stale sibling worktree still occupies the branch, it is removed first
   * — siblings are sequential, so this is safe.
   */
  reuseBranch?: boolean
}): Promise<{ worktreePath: string; branchName: string }> {
  const { repoRoot, jobId, reuseBranch = false } = opts
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

  // ISS-3: pas ná de fetch resolven, zodat `remote set-head --auto` een verse
  // origin/HEAD ziet. Een expliciete baseRef van de caller wint altijd.
  const baseRef = opts.baseRef ?? (await resolveOriginDefaultRef(repoRoot))

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
      //
      // Preconditie (spec §3.4): alleen resetten wanneer de lokale branch
      // ontbreekt óf origin de lokale tip bevat — anders zou `-B` precies het
      // werk wissen dat laag 3 hierboven bewaarde. Ligt lokaal vóór origin:
      // eerst best-effort pushen; lukt dat niet, dan de branch as-is
      // uitchecken zonder reset.
      let canReset = !(await branchExists(repoRoot, branchName))
      if (!canReset) canReset = await localTipContainedInRemote(repoRoot, branchName)
      if (!canReset) {
        // Branch-ref-push: repoRoot staat doorgaans op main uitgecheckt, dus
        // een cwd-HEAD-gebaseerde push/precheck zou hier de verkeerde ref
        // vergelijken of de push overslaan.
        await maybeBackupPushBranch({ repoRoot, branchName, context: 'reuse-precondition' })
        canReset = await localTipContainedInRemote(repoRoot, branchName)
      }
      if (canReset) {
        await gitRetry(['worktree', 'add', '-B', branchName, worktreePath, `origin/${branchName}`])
      } else {
        claimLog('worktree.reuseWithoutReset_localAhead', { jobId, branchName })
        await gitRetry(['worktree', 'add', worktreePath, branchName])
      }
    } else if (await branchExists(repoRoot, branchName)) {
      await gitRetry(['worktree', 'add', worktreePath, branchName])
    } else {
      await gitRetry(['worktree', 'add', '-b', branchName, worktreePath, baseRef])
    }
    claimLog('worktree.created', { jobId, branchName, worktreePath, reuse: reuseBranch })
    await prepareWorktree(repoRoot, worktreePath, jobId)
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
    if (await localTipContainedInRemote(repoRoot, branchName)) {
      try {
        await exec('git', ['branch', '-D', branchName], { cwd: repoRoot })
        claimLog('worktree.orphanBranchRemoved', { jobId, branchName })
      } catch {
        // last resort: timestamp-suffix to avoid collision rather than fail
        branchName = `${branchName}-${Date.now()}`
      }
    } else {
      // Laag 3 houdt de orphan-delete tegen → neem de suffix-uitwijk zodat
      // `worktree add -b` niet fataal faalt op de bestaande naam (spec §3.3).
      claimLog('worktree.orphanBranchKept_unpushed', { jobId, branchName })
      branchName = `${branchName}-${Date.now()}`
    }
  }

  await gitRetry(['worktree', 'add', '-b', branchName, worktreePath, baseRef])

  claimLog('worktree.created', { jobId, branchName, worktreePath, reuse: reuseBranch })
  await prepareWorktree(repoRoot, worktreePath, jobId)
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

  // Laag 3 (spec 2026-08-30-sprint-job-werkbackup-design.md §3.3): een lokale
  // branch mag alleen verdwijnen wanneer origin de tip aantoonbaar bevat.
  // De regel zit hier — ín de helper — zodat geen enkele callsite (failure,
  // requeue, cancel-cascade, cleanup-tool) hem kan overslaan.
  if (!keepBranch && branchName && (await branchExists(repoRoot, branchName))) {
    if (await localTipContainedInRemote(repoRoot, branchName)) {
      await exec('git', ['branch', '-D', branchName], { cwd: repoRoot })
      claimLog('worktree.branchRemoved', { jobId, branchName })
    } else {
      claimLog('worktree.branchKept_unpushed', { jobId, branchName })
      console.warn(
        `[worktree] branch ${branchName} bewaard voor job ${jobId}: origin mist de lokale tip`,
      )
    }
  }

  return { removed: true }
}
