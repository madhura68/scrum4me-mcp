// On-demand repo-clone fallback for resolveRepoRoot.
//
// See docs/superpowers/specs/2026-07-08-on-demand-repo-clone-fallback-design.md.
// This module currently hosts the error classifier (spec §4.6); the clone helper
// itself (spec §4.a) is added in a follow-up.

import { isTransientGitError } from './retry.js'

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
