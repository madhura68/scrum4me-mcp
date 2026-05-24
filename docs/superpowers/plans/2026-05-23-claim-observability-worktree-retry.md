# Claim-flow Observability + Worktree Retry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured stderr diagnostics across the job claim/worktree flow and make `createWorktreeForJob` retry transient git failures.

**Architecture:** Two small, independently-tested helpers — `withRetry`/`isTransientGitError` (`src/git/retry.ts`) and `claimLog` (`src/lib/claim-log.ts`) — are wired into the shared claim functions (`src/git/worktree.ts`, `src/tools/wait-for-job.ts`) used by both the `wait_for_job` MCP tool and the docker runner. Logs go to stderr (stdout is the MCP JSON-RPC channel).

**Tech Stack:** TypeScript (ESM), Vitest.

**Spec:** `docs/superpowers/specs/2026-05-23-claim-observability-worktree-retry-design.md`

---

## File Structure

**New**
- `src/git/retry.ts` — `withRetry`, `isTransientGitError`.
- `src/lib/claim-log.ts` — `claimLog`.
- `__tests__/git/retry.test.ts`, `__tests__/lib/claim-log.test.ts`, `__tests__/wait-for-job-claim-log.test.ts`.

**Modify**
- `src/git/worktree.ts` — wrap `git fetch` + `git worktree add` with `withRetry`; `claimLog` chosen path/retries.
- `src/tools/wait-for-job.ts` — `claimLog` in `resolveRepoRoot` + `attachWorktreeToJob`.

Order: Task 1 (retry) + Task 2 (claim-log) are leaf helpers; Task 3 (worktree) depends on both; Task 4 (wait-for-job) depends on claim-log.

---

## Task 1: Retry helper

**Files:**
- Create: `src/git/retry.ts`
- Test: `__tests__/git/retry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { withRetry, isTransientGitError } from '../../src/git/retry.js'

describe('isTransientGitError', () => {
  it.each([
    'fatal: Unable to create .../index.lock: File exists',
    'fatal: could not lock config file',
    'fatal: unable to access ...: Could not resolve host: origin',
    'error: RPC failed; ... early EOF',
    'ssh: connect to host ...: Connection timed out',
  ])('matches transient: %s', (msg) => {
    expect(isTransientGitError(new Error(msg))).toBe(true)
  })

  it('does not match a permanent error', () => {
    expect(isTransientGitError(new Error('fatal: a branch named X already exists'))).toBe(false)
  })
})

describe('withRetry', () => {
  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    expect(await withRetry(fn, { baseDelayMs: 0 })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a retryable error then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('index.lock'))
      .mockResolvedValue('ok')
    const onRetry = vi.fn()
    const result = await withRetry(fn, { baseDelayMs: 0, isRetryable: isTransientGitError, onRetry })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('gives up after `retries` attempts and throws the last error', async () => {
    const err = new Error('index.lock')
    const fn = vi.fn().mockRejectedValue(err)
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 0 })).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry when isRetryable returns false', async () => {
    const err = new Error('permanent')
    const fn = vi.fn().mockRejectedValue(err)
    await expect(withRetry(fn, { baseDelayMs: 0, isRetryable: () => false })).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/git/retry.test.ts`
Expected: FAIL — cannot find module `../../src/git/retry.js`.

- [ ] **Step 3: Implement `src/git/retry.ts`**

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/git/retry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/git/retry.ts __tests__/git/retry.test.ts
git commit -m "feat(claim): add withRetry + isTransientGitError helper"
```

---

## Task 2: Structured claim logger

**Files:**
- Create: `src/lib/claim-log.ts`
- Test: `__tests__/lib/claim-log.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { claimLog } from '../../src/lib/claim-log.js'

afterEach(() => vi.restoreAllMocks())

describe('claimLog', () => {
  it('writes a JSON line to stderr with scope, event and fields', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    claimLog('repoRoot.resolved', { productId: 'p1', via: 'product-env' })
    expect(spy).toHaveBeenCalledOnce()
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({
      scope: 'claim',
      event: 'repoRoot.resolved',
      productId: 'p1',
      via: 'product-env',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/lib/claim-log.test.ts`
Expected: FAIL — cannot find module `../../src/lib/claim-log.js`.

- [ ] **Step 3: Implement `src/lib/claim-log.ts`**

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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/lib/claim-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/claim-log.ts __tests__/lib/claim-log.test.ts
git commit -m "feat(claim): add structured stderr claimLog helper"
```

---

## Task 3: Retry + logging in `createWorktreeForJob`

The retry *logic* is covered by Task 1's unit tests. The worktree tests use real git (temp repos) and can't induce a transient failure, so this task wires the tested helper in and verifies **no regression** on the existing integration tests + typecheck.

**Files:**
- Modify: `src/git/worktree.ts`
- Test: existing `__tests__/git/worktree.test.ts` (must stay green)

- [ ] **Step 1: Add imports**

At the top of `src/git/worktree.ts` (after the existing imports):

```ts
import { withRetry, isTransientGitError } from './retry.js'
import { claimLog } from '../lib/claim-log.js'
```

- [ ] **Step 2: Add a local retry wrapper inside `createWorktreeForJob`**

Immediately after `const worktreePath = path.join(parent, jobId)` (and before the path-exists check), add:

```ts
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
```

- [ ] **Step 3: Route the transient-prone git calls through `gitRetry`**

Replace the `git fetch` call:

```ts
await exec('git', ['fetch', 'origin', '--prune'], { cwd: repoRoot })
```
with
```ts
await gitRetry(['fetch', 'origin', '--prune'])
```

Replace EACH of the three `git worktree add …` calls in the `reuseBranch` block and the one fresh-branch `git worktree add …` call (4 total) from the form
`await exec('git', ['worktree', 'add', …], { cwd: repoRoot })`
to
`await gitRetry(['worktree', 'add', …])` (keep the exact `add`-args of each call). Do NOT wrap the `show-ref`, `git branch -D`, or `git worktree remove` calls — those are local and not transient-prone.

- [ ] **Step 4: Upgrade the orphan-branch warn + add a success log**

Replace:
```ts
console.warn(`[createWorktreeForJob] removed orphan branch ${branchName} before recreate`)
```
with
```ts
claimLog('worktree.orphanBranchRemoved', { jobId, branchName })
```

Before each `return { worktreePath, branchName }` (the reuse path and the fresh path), add:
```ts
    claimLog('worktree.created', { jobId, branchName, worktreePath, reuse: reuseBranch })
```

- [ ] **Step 5: Run the worktree tests + typecheck (no regression)**

Run: `npx vitest run __tests__/git/worktree.test.ts && npm run typecheck`
Expected: worktree tests PASS (the retry wrapper is transparent on success); typecheck shows only the known `@types/express` errors.

- [ ] **Step 6: Commit**

```bash
git add src/git/worktree.ts
git commit -m "feat(claim): retry transient git failures + log worktree creation"
```

---

## Task 4: Logging in `resolveRepoRoot` + `attachWorktreeToJob`

**Files:**
- Modify: `src/tools/wait-for-job.ts`
- Test: `__tests__/wait-for-job-claim-log.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { product: { findUnique: vi.fn() } },
}))

import { resolveRepoRoot } from '../src/tools/wait-for-job.js'

const PID = 'prod-claimlog-test'
const ENV_KEY = `SCRUM4ME_REPO_ROOT_${PID}`

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  delete process.env[ENV_KEY]
  vi.restoreAllMocks()
})

describe('resolveRepoRoot observability', () => {
  it('logs repoRoot.resolved with via=product-env', async () => {
    process.env[ENV_KEY] = '/tmp/some-repo'
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await resolveRepoRoot(PID)
    expect(result).toBe('/tmp/some-repo')
    const line = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes('repoRoot.resolved'))
    expect(line).toBeTruthy()
    expect(JSON.parse(line!)).toMatchObject({ scope: 'claim', event: 'repoRoot.resolved', via: 'product-env' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/wait-for-job-claim-log.test.ts`
Expected: FAIL — no `repoRoot.resolved` line is logged yet.

- [ ] **Step 3: Add the import**

At the top of `src/tools/wait-for-job.ts` (with the other imports):

```ts
import { claimLog } from '../lib/claim-log.js'
```

- [ ] **Step 4: Instrument `resolveRepoRoot`**

Inside `resolveRepoRoot`, add a local helper at the very top of the function body:

```ts
  const resolved = (via: string, repoRoot: string): string => {
    claimLog('repoRoot.resolved', { productId, via, repoRoot })
    return repoRoot
  }
```

Then change each successful `return <value>` to route through it with the matching `via`:
- task-level env → `return resolved('task-env', process.env[overrideEnv]!)`
- task-level config → `return resolved('task-config', config.repoRoots[taskRepoName])`
- task-level convention → `return resolved('task-convention', candidate)`
- product env → `return resolved('product-env', process.env[envKey]!)`
- product config → `return resolved('product-config', config.repoRoots[productId])`
- product convention → `return resolved('product-convention', candidate)`

And before the final `return null` (and the inner `if (!name) return null`), add:
```ts
    claimLog('repoRoot.unresolved', { productId, taskRepoUrl: taskRepoUrl ?? null })
```
(Place one `claimLog('repoRoot.unresolved', …)` immediately before the function's terminal `return null` paths.)

- [ ] **Step 5: Instrument `attachWorktreeToJob`**

In `attachWorktreeToJob`:
- After the function opening, add `claimLog('attach.start', { jobId, productId })`.
- After `const { branchName, reused } = await resolveBranchForJob(jobId, storyId)`, add
  `claimLog('attach.branch', { jobId, branchName, reused })`.
- Replace the base_sha `console.warn(...)` with
  `claimLog('attach.baseShaFailed', { jobId, error: String((err as Error).message).slice(0, 200) })`.
- After the `prisma.claudeJob.update({...})` succeeds (before `return { worktree_path … }`), add
  `claimLog('attach.done', { jobId, branchName: actualBranch, baseSha })`.
- In the `catch (err)` block (before `rollbackClaim`), add
  `claimLog('attach.failed', { jobId, error: String((err as Error).message).slice(0, 200) })`.

- [ ] **Step 6: Run the new test + the existing wait-for-job suites + typecheck**

Run: `npx vitest run __tests__/wait-for-job-claim-log.test.ts __tests__/wait-for-job-branch-resolution.test.ts __tests__/wait-for-job-worktree.test.ts && npm run typecheck`
Expected: all PASS; typecheck only the known `@types/express` errors.

- [ ] **Step 7: Commit**

```bash
git add src/tools/wait-for-job.ts __tests__/wait-for-job-claim-log.test.ts
git commit -m "feat(claim): log repo-root resolution + worktree attach steps"
```

---

## Final verification

- [ ] **Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass; typecheck only the pre-existing `@types/express` errors in `src/http.ts`.

---

## Spec coverage check

| Spec item | Task |
|---|---|
| `claimLog` stderr helper | Task 2 |
| `withRetry` + `isTransientGitError` | Task 1 |
| Retry `git fetch` + `git worktree add` (transient only) | Task 3 |
| `claimLog` worktree chosen-path / retries / orphan-branch | Task 3 |
| `claimLog` in `resolveRepoRoot` (via / unresolved) | Task 4 |
| `claimLog` in `attachWorktreeToJob` (start/branch/baseSha/done/failed) | Task 4 |
| base_sha-race correctness, LISTEN speed, runner-side | out of scope (spec) |
```
