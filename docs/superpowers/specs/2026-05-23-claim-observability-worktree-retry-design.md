---
title: Claim-flow observability + worktree-creation retry
status: draft
author: janpetervisser
version: 0.1
date: 2026-05-23
follows: ./2026-05-23-sprint-subagent-execution-design.md
---

# Claim-flow observability + worktree-creation retry

## Context

The job claim/worktree flow lives in shared functions used by **both** the `wait_for_job`
MCP tool and the docker runner: `resolveRepoRoot` → `tryClaimJob` → `attachWorktreeToJob`
→ `createWorktreeForJob` → base_sha capture (`src/tools/wait-for-job.ts`, `src/git/worktree.ts`).
Two weaknesses:

1. **No observability.** `wait-for-job.ts` has ~4 log calls total. When a startup fails you
   can't see *which* of `resolveRepoRoot`'s 4 strategies won (or why they were exhausted),
   nor where the worktree/base_sha step failed.
2. **No retry.** `createWorktreeForJob` runs `git fetch origin --prune` and `git worktree
   add …` as single attempts. A transient git failure (lock contention, network blip) fails
   the whole claim → `attachWorktreeToJob` rolls the claim back.

This spec adds structured diagnostics + transient-retry, **without behavior changes** beyond
retrying transient git errors. (base_sha-race correctness and LISTEN/pickup speed are
explicitly deferred — see Out of scope.)

## Decisions (from brainstorm)

| Decision | Choice |
|---|---|
| Scope | **Observability + worktree-creation retry** (claim-side, scrum4me-mcp) |
| Logs target | **stderr** — stdio MCP uses stdout for JSON-RPC; a stray stdout write corrupts the protocol |
| Retry surface | `git fetch` and `git worktree add` in `createWorktreeForJob`; transient errors only |
| base_sha race / LISTEN speed | **deferred** (base_sha keeps best-effort; its warn becomes a `claimLog`) |

## Design

### 1. Structured logger — `src/lib/claim-log.ts` (new)

```ts
// Structured claim/worktree diagnostics. MUST write to stderr: in stdio MCP mode
// stdout is the JSON-RPC channel, so any stray stdout write corrupts the protocol.
export function claimLog(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.error(JSON.stringify({ scope: 'claim', event, ...fields }))
  } catch {
    console.error(`[claim] ${event}`)
  }
}
```

### 2. Retry helper — `src/git/retry.ts` (new)

```ts
export function isTransientGitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /index\.lock|could not lock|unable to access|could not resolve host|connection (timed out|refused|reset)|early EOF|fetch-pack|RPC failed|the remote end hung up|timed out|temporar/i.test(
    msg,
  )
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    retries?: number
    baseDelayMs?: number
    isRetryable?: (err: unknown) => boolean
    onRetry?: (attempt: number, err: unknown) => void
  } = {},
): Promise<T> {
  const { retries = 2, baseDelayMs = 200, isRetryable = () => true, onRetry } = opts
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === retries || !isRetryable(err)) throw err
      onRetry?.(attempt + 1, err)
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt))
    }
  }
  throw lastErr
}
```

### 3. Apply retry + logging in `src/git/worktree.ts`

Wrap the two transient git operations in `createWorktreeForJob` with `withRetry` +
`isTransientGitError`, and log the chosen path:

- `git fetch origin --prune` (currently the single `exec(... 'fetch' ...)` call).
- each `git worktree add …` variant (reuse-local / reuse-remote / fresh).

```ts
await withRetry(
  () => exec('git', ['fetch', 'origin', '--prune'], { cwd: repoRoot }),
  { isRetryable: isTransientGitError, onRetry: (n, err) =>
      claimLog('worktree.fetch.retry', { jobId, attempt: n, error: String((err as Error).message).slice(0, 200) }) },
)
```

(Use the same `withRetry(...)` wrapper around each `git worktree add` call.) After a
successful add, emit `claimLog('worktree.created', { jobId, branchName, worktreePath, reuse: reuseBranch })`.
The existing orphan-branch `console.warn` (≈ line 134) becomes
`claimLog('worktree.orphanBranchRemoved', { jobId, branchName })`.

### 4. Logging in `src/tools/wait-for-job.ts`

- `resolveRepoRoot`: emit `claimLog('repoRoot.resolved', { productId, via, repoRoot })` at each
  successful return with `via` ∈ `task-env` / `task-config` / `task-convention` / `product-env`
  / `product-config` / `product-convention`; and `claimLog('repoRoot.unresolved', { productId,
  taskRepoUrl })` at the final `return null`.
- `attachWorktreeToJob`: `claimLog('attach.start', { jobId, productId })`; after branch
  resolution `claimLog('attach.branch', { jobId, branchName, reused })`; replace the base_sha
  `console.warn` with `claimLog('attach.baseShaFailed', { jobId, error })`; on success
  `claimLog('attach.done', { jobId, branchName, baseSha })`; in the catch
  `claimLog('attach.failed', { jobId, error })` before `rollbackClaim`.

## Files

**New**
- `src/lib/claim-log.ts` — `claimLog`.
- `src/git/retry.ts` — `withRetry`, `isTransientGitError`.
- `__tests__/git/retry.test.ts`.

**Modify**
- `src/git/worktree.ts` — wrap fetch + worktree-add in `withRetry`; add `claimLog`.
- `src/tools/wait-for-job.ts` — add `claimLog` in `resolveRepoRoot` + `attachWorktreeToJob`.
- `__tests__/git/worktree.test.ts` — add transient-retry + permanent-no-retry cases.

## Verification

1. **Unit — retry** (`__tests__/git/retry.test.ts`): `withRetry` returns on first success;
   retries a retryable error up to N then throws; does NOT retry when `isRetryable` returns
   false; `isTransientGitError` matches `index.lock`/network strings but not
   `fatal: a branch named … already exists`.
2. **Unit — worktree retry** (extend `__tests__/git/worktree.test.ts`): with `exec` mocked so
   `git fetch` fails once with a transient error then succeeds, `createWorktreeForJob`
   succeeds (one retry); with a non-transient error it throws without retry.
3. **Observability (light)**: spying `console.error`, `resolveRepoRoot` emits a
   `repoRoot.resolved` line with the correct `via`. (Confirms logs go to stderr.)
4. `npm test` + `npm run typecheck` green (modulo the known `@types/express` errors).

## Out of scope (YAGNI / deferred)

- **base_sha-race correctness** — stays best-effort (only its log is upgraded to `claimLog`).
- **LISTEN/poll pickup speed** — separate later spec.
- **Runner-side robustness** (lease/heartbeat jitter, spawn timeout, quota probe) — lives in
  scrum4me-docker; separate follow-up.
- A full logging framework — `claimLog` is a deliberately minimal stderr helper.
