// On-demand repo-clone fallback for resolveRepoRoot.
//
// See docs/superpowers/specs/2026-07-08-on-demand-repo-clone-fallback-design.md.
// This module currently hosts the error classifier (spec §4.6); the clone helper
// itself (spec §4.a) is added in a follow-up.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { isTransientGitError, withRetry } from './retry.js'
import { acquireCloneLock } from './file-lock.js'
import { prisma } from '../prisma.js'

export type RepoBootstrapPhase = 'clone' | 'reset' | 'install'
export type ErrorDisposition = 'terminal' | 'transient'

// Deterministic git failures: the repo/ref/URL/auth is wrong and no amount of
// retrying will fix it. Kept context-specific ("repository", "remote branch",
// "remote ref") so a bare "not found" from an unrelated network log does not
// trip a terminal verdict.
const TERMINAL_GIT_PATTERNS: RegExp[] = [
  /repository .*not found/i,
  /remote: repository not found/i,
  /repository does not exist/i,
  /does not appear to be a git repository/i,
  /unable to find remote helper for/i,
  /protocol '.*' is not supported/i,
  /authentication failed/i,
  /invalid username or password/i,
  /(^|\W)(401 unauthorized|403 forbidden)(\W|$)/i,
  /access denied|access forbidden|permission denied/i,
  /terminal prompts disabled/i,
  /remote branch .* not found/i,
  /could ?n'?t find remote ref/i,
  /could not find remote branch/i,
]

// Deterministic install failures: a lockfile/dependency-graph problem that will
// reproduce on every retry. Network/registry hiccups are intentionally NOT here
// (they are transient) — see TRANSIENT_EXTRA_PATTERNS.
const TERMINAL_INSTALL_PATTERNS: RegExp[] = [
  /code ERESOLVE|ERESOLVE unable to resolve/i,
  /can only install packages when your package\.json and package-lock\.json are in sync/i,
  /Missing: .* from lock ?file/i,
  /Invalid: lock ?file/i,
  /npm error .* Invalid package/i,
  /unsupported engine/i,
]

// Registry/network conditions that git's isTransientGitError does not phrase the
// same way (npm surfaces raw error codes / HTTP statuses).
const TRANSIENT_EXTRA_PATTERNS =
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network timeout|(^|\W)(429|500|502|503|504)(\W|$)|service unavailable|too many requests|bad gateway|gateway time-?out/i

function extractMessage(err: unknown): string {
  if (err instanceof Error) {
    const withStreams = err as Error & { stderr?: unknown; stdout?: unknown }
    return [err.message, String(withStreams.stderr ?? ''), String(withStreams.stdout ?? '')].join('\n')
  }
  return String(err)
}

/**
 * Decide whether a repo-bootstrap failure is terminal (mark the job FAILED, no
 * requeue) or transient (recoverable — rollback/requeue as today).
 *
 * Order matters: known-transient network/registry signals win first so a DNS
 * outage or 503 is never mislabelled terminal. Then the phase-specific
 * deterministic patterns fire. Anything unrecognised defaults to `transient` —
 * a needless retry is cheaper than a false terminal (codex review r1).
 */
export function classifyRepoBootstrapError(
  phase: RepoBootstrapPhase,
  err: unknown,
): ErrorDisposition {
  const msg = extractMessage(err)

  // Run the shared transient-git regex over the FULL text (message + stderr +
  // stdout): execFile rejects with the detail on err.stderr, so passing the raw
  // err (message only) would miss "could not resolve host" and friends.
  if (isTransientGitError(new Error(msg)) || TRANSIENT_EXTRA_PATTERNS.test(msg)) return 'transient'

  const patterns = phase === 'install' ? TERMINAL_INSTALL_PATTERNS : TERMINAL_GIT_PATTERNS
  if (patterns.some((re) => re.test(msg))) return 'terminal'

  return 'transient'
}

// ---------------------------------------------------------------------------
// Error taxonomy for the on-demand clone (spec §7).
//
// TerminalJobError  → the job cannot succeed; the runner marks it FAILED with
//                     `reason` and does NOT rollback/requeue.
// TransientRepoError→ recoverable (network/registry); the caller degrades to the
//                     existing null/rollback→requeue path.
// OwnershipLostError→ another worker reclaimed the job mid-clone; abort silently,
//                     the runner must NOT rollback (it no longer owns the row).
// ---------------------------------------------------------------------------
export class TerminalJobError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'TerminalJobError'
    this.reason = reason
  }
}

export class TransientRepoError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'TransientRepoError'
    this.reason = reason
  }
}

export class OwnershipLostError extends Error {
  constructor(jobId: string) {
    super(`ownership lost for job ${jobId} — reclaimed by another worker; aborting clone`)
    this.name = 'OwnershipLostError'
  }
}

export interface CloneOwnerCtx {
  jobId: string
  instanceId: string
  tokenId: string
}

type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>

export interface CloneRepoDeps {
  projectsDir?: string
  pid?: number
  exec?: ExecFn
  acquireLock?: (lockPath: string) => Promise<() => Promise<void>>
  /** Owner-guarded lease renewal; resolves to the number of rows updated. */
  renewLease?: (ownerCtx: CloneOwnerCtx) => Promise<number>
  leaseIntervalMs?: number
}

const execFileP = promisify(execFile)
const defaultExec: ExecFn = (cmd, args, opts) =>
  execFileP(cmd, args, { ...opts, maxBuffer: 64 * 1024 * 1024 })

// Owner-guarded lease renewal: only extends the lease while THIS worker still
// owns the CLAIMED/RUNNING job. A stray old timer that fires after a stale-reset
// updates 0 rows → the caller treats it as ownership lost. (spec §4.1)
async function defaultRenewLease(ownerCtx: CloneOwnerCtx): Promise<number> {
  const rows = await prisma.$executeRaw`
    UPDATE claude_jobs
    SET lease_until = NOW() + INTERVAL '5 minutes'
    WHERE id = ${ownerCtx.jobId}
      AND status IN ('CLAIMED', 'RUNNING')
      AND worker_instance_id = ${ownerCtx.instanceId}
      AND claimed_by_token_id = ${ownerCtx.tokenId}
  `
  return rows
}

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim().length > 0) ?? s).slice(0, 300)
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// A directory is a usable repo root only if it has a .git and git agrees it is a
// work tree. Guards against a half-written clone counting as "valid".
async function isUsableRepo(dir: string, exec: ExecFn): Promise<boolean> {
  if (!(await pathExists(path.join(dir, '.git')))) return false
  try {
    await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir })
    return true
  } catch {
    return false
  }
}

/**
 * Clone a repo on demand into `~/Projects/<name>` when neither the preclone nor
 * the config/env conventions resolved it. Used as the last-resort fallback in
 * resolveRepoRoot so a product/task with a valid repo_url "just works" without
 * per-host GH_PRECLONE_REPOS maintenance. (spec §4.a)
 *
 * Guarantees:
 *  - serialized per repo via a clone-specific lock (tolerates multi-minute installs)
 *  - atomic: clones into `<name>.tmp.<pid>`, promotes with a single rename
 *  - owner-guarded lease renewal covers the whole clone (works for the docker
 *    runner AND the wait_for_job MCP-tool path, since the renewal lives here)
 *  - fail-fast install: a package repo whose deps won't install is NOT promoted
 *
 * Throws TerminalJobError / TransientRepoError / OwnershipLostError.
 */
export async function cloneRepoOnDemand(
  opts: { repoUrl: string; name: string; ownerCtx?: CloneOwnerCtx | null },
  deps: CloneRepoDeps = {},
): Promise<string> {
  const projectsDir = deps.projectsDir ?? path.join(os.homedir(), 'Projects')
  const pid = deps.pid ?? process.pid
  const exec = deps.exec ?? defaultExec
  const acquireLock = deps.acquireLock ?? acquireCloneLock
  const renewLease = deps.renewLease ?? defaultRenewLease
  const leaseIntervalMs = deps.leaseIntervalMs ?? 60_000

  const { repoUrl, name, ownerCtx } = opts
  const target = path.join(projectsDir, name)
  const tmp = path.join(projectsDir, `${name}.tmp.${pid}`)

  await fs.mkdir(projectsDir, { recursive: true })
  const releaseLock = await acquireLock(target)

  let ownershipLost = false
  let leaseTimer: ReturnType<typeof setInterval> | null = null

  const abortIfLost = (): void => {
    if (ownershipLost) throw new OwnershipLostError(ownerCtx?.jobId ?? '?')
  }
  const confirmOwnership = async (): Promise<void> => {
    if (!ownerCtx) return
    if ((await renewLease(ownerCtx)) === 0) {
      ownershipLost = true
      throw new OwnershipLostError(ownerCtx.jobId)
    }
  }

  const runPhase = async <T>(phase: RepoBootstrapPhase, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof OwnershipLostError) throw err
      const disposition = classifyRepoBootstrapError(phase, err)
      const reason = `${phase} failed for ${name}: ${firstLine(extractMessage(err))}`
      throw disposition === 'terminal' ? new TerminalJobError(reason) : new TransientRepoError(reason)
    }
  }

  try {
    // Re-check under the lock: a sibling may have finished the clone while we
    // waited for the lock. If a corrupt leftover sits there, wipe and reclone.
    if (await isUsableRepo(target, exec)) return target
    if (await pathExists(path.join(target, '.git'))) {
      await fs.rm(target, { recursive: true, force: true })
    }

    // Confirm we still own the job before the expensive work, then keep the
    // lease warm for the whole clone/install.
    await confirmOwnership()
    if (ownerCtx) {
      leaseTimer = setInterval(() => {
        renewLease(ownerCtx)
          .then((rows) => {
            if (rows === 0) {
              ownershipLost = true
              if (leaseTimer) clearInterval(leaseTimer)
            }
          })
          .catch(() => {})
      }, leaseIntervalMs)
      if (typeof leaseTimer.unref === 'function') leaseTimer.unref()
    }

    await fs.rm(tmp, { recursive: true, force: true })

    // Clone into the unique temp dir.
    await runPhase('clone', () =>
      withRetry(() => exec('git', ['clone', repoUrl, tmp]), {
        retries: 2,
        isRetryable: (e) => classifyRepoBootstrapError('clone', e) === 'transient',
      }),
    )
    abortIfLost()

    // Align the temp clone to origin's default branch (mirrors repo-bootstrap.sh).
    await runPhase('reset', async () => {
      const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd: tmp })
      const defaultRef = stdout.trim() || 'origin/HEAD'
      await withRetry(() => exec('git', ['reset', '--hard', defaultRef], { cwd: tmp }), {
        retries: 2,
        isRetryable: (e) => classifyRepoBootstrapError('reset', e) === 'transient',
      })
    })
    abortIfLost()

    // Install deps only for a package repo. Fail-fast: on failure we throw and
    // never promote the temp, so linkNodeModules can rely on repoRoot deps.
    if (await pathExists(path.join(tmp, 'package.json'))) {
      const hasLock = await pathExists(path.join(tmp, 'package-lock.json'))
      const npmArgs = hasLock
        ? ['ci', '--no-audit', '--no-fund', '--prefer-offline']
        : ['install', '--no-audit', '--no-fund', '--prefer-offline']
      await runPhase('install', () => exec('npm', npmArgs, { cwd: tmp }))
      abortIfLost()
    }

    // Atomic promote. Under the lock nothing else should have created `target`;
    // clear any stale leftover defensively before the rename.
    if (await pathExists(target)) {
      await fs.rm(target, { recursive: true, force: true })
    }
    await fs.rename(tmp, target)
    return target
  } finally {
    if (leaseTimer) clearInterval(leaseTimer)
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    await releaseLock().catch(() => {})
  }
}
