---
title: Reused worktree freshness — prefer origin over a stale local branch
status: draft
author: janpetervisser
version: 0.1
date: 2026-05-24
follows: ./2026-05-23-claim-observability-worktree-retry-design.md
---

# Reused worktree freshness: prefer origin/<branch> over a stale local ref

## Context

Branch-per-story / branch-per-sprint means sibling jobs **reuse** one branch
(`resolveBranchForJob` returns `reused=true` when a sibling already has it). When a job
reuses a branch, `createWorktreeForJob` currently checks out the **local** branch ref if one
exists:

```ts
if (await branchExists(repoRoot, branchName)) {
  await gitRetry(['worktree', 'add', worktreePath, branchName])   // local ref — may be stale
} else if (await remoteBranchExists(repoRoot, branchName)) { … origin … } else { … baseRef … }
```

`git fetch --prune` (run just before) updates `origin/<branch>` but **not** the local branch
ref, and a clone keeps its local branch after a done job (`keepBranch=true`). So with **≥2
concurrent workers on the same story/sprint branch**, a clone whose local ref lags origin
(another worker pushed) checks out **stale code + a stale `base_sha`**. The agent then commits
on the stale base and `pushBranchForJob`'s `git push` (no `--force`) is **non-fast-forward →
`reason: 'conflict'`** (`src/git/push.ts:41,48`) → the job's push fails.

With a **single worker** this can't happen (siblings run in one clone, sequentially, so the
local ref is always current). It's latent today, real once workers scale out.

## Decision

Base reused worktrees on the **current `origin/<branch>`**, not a possibly-stale local ref.
This corrects both the worktree code and the `base_sha` captured immediately afterward, and
removes the non-ff push conflict. Scope is **just the reuse path** of `createWorktreeForJob`
(the null-base fallback and `pushBranchForJob`'s `origin/main` no-changes check are out of
scope — `Fix it`, not `broaden`).

## Design

In `createWorktreeForJob` (`src/git/worktree.ts`), reorder the reuse branch-resolution to
check **origin first** and reset to it:

```ts
// Prefer the current origin tip over a possibly-stale local ref. A clone that kept a
// local branch from an earlier sibling job can lag origin after another worker pushed;
// `-B` create-or-resets <branch> to origin/<branch> and checks it out, so the worktree
// (and the base_sha captured next) reflect the real branch tip — no non-ff push later.
if (await remoteBranchExists(repoRoot, branchName)) {
  await gitRetry(['worktree', 'add', '-B', branchName, worktreePath, `origin/${branchName}`])
} else if (await branchExists(repoRoot, branchName)) {
  // Local-only branch (created here, not yet pushed) — use it as-is.
  await gitRetry(['worktree', 'add', worktreePath, branchName])
} else {
  await gitRetry(['worktree', 'add', '-b', branchName, worktreePath, baseRef])
}
```

- The existing occupant-removal (a stale sibling worktree still holding the branch) stays
  **before** this block, so `-B` can reset the branch (git refuses to reset a branch checked
  out in another worktree).
- **Safety of `-B` reset:** in the reuse flow a sibling has already pushed, so a local ref is
  at-or-behind origin — never ahead with unpushed commits (jobs push on `done`). Resetting to
  origin therefore loses nothing. (Local-only/unpushed branches have no `origin/<branch>` yet
  and fall to the second arm, untouched.)
- No change to the fresh-branch path or to `base_sha` capture; `base_sha` (the worktree HEAD
  captured right after, in `attachWorktreeToJob` / sprint context) is now the origin tip.

## Files

- Modify: `src/git/worktree.ts` (reuse path of `createWorktreeForJob`).
- Test: `__tests__/git/worktree.test.ts` (new real-git case).

## Verification

1. **New real-git test** (red→green) in `__tests__/git/worktree.test.ts`:
   - Set up origin + a local clone (existing `setupRepo` helper).
   - Create `feat/story-x` and push it (origin + local at commit C1).
   - Advance **origin** to C2 from a second clone (so the local `feat/story-x` ref stays at
     C1 = stale), then `git checkout main` in the local clone.
   - Call `createWorktreeForJob({ repoRoot: localClone, jobId, branchName: 'feat/story-x',
     reuseBranch: true })`.
   - Assert the worktree HEAD `git rev-parse HEAD` equals **C2** (origin tip), not C1.
   - With the old code this fails (checks out stale local C1); with the fix it passes.
2. Existing `__tests__/git/worktree.test.ts` cases still pass (fresh branch + reuse-local-only
   + occupant removal behavior unchanged for the no-origin paths).
3. `npm run typecheck` exit 0; `npm test` all pass.

## Out of scope
- The `getDiffInWorktree` null-base fallback to `origin/main` for reused branches.
- `pushBranchForJob`'s `origin/main` no-changes comparison.
- Single-worker deployments (unaffected; fix is a no-op there since the local ref is already
  current).
