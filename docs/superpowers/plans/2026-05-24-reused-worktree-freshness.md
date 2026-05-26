# Reused Worktree Freshness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `createWorktreeForJob`'s reuse path base the worktree on the current `origin/<branch>` instead of a possibly-stale local branch ref, so multi-worker branch reuse can't yield stale code / `base_sha` / a non-fast-forward push.

**Architecture:** One reordering in the reuse branch of `createWorktreeForJob` (`src/git/worktree.ts`): check `origin/<branch>` **first** and use `git worktree add -B <branch> <path> origin/<branch>` (create-or-reset to origin tip). Local-only (unpushed) and nowhere paths are unchanged. Verified with a real-git test where origin is ahead of a stale local ref.

**Tech Stack:** TypeScript, Vitest (real-git integration test).

**Spec:** `docs/superpowers/specs/2026-05-24-reused-worktree-freshness-design.md`

---

## File Structure

- Modify: `src/git/worktree.ts` — reuse branch of `createWorktreeForJob` (the `if (reuseBranch) { … }` block, branch-resolution `if/else`).
- Test: `__tests__/git/worktree.test.ts` — add one real-git case (uses the existing `setupRepo` / `git` / `makeWorktreeParent` / `tmpDirs` helpers).

Single task. No new files.

---

## Task 1: Reused worktrees track current origin/<branch>

**Files:**
- Modify: `src/git/worktree.ts`
- Test: `__tests__/git/worktree.test.ts`

- [ ] **Step 1: Write the failing test**

Add this case inside the `describe('createWorktreeForJob', …)` block in `__tests__/git/worktree.test.ts` (after the existing `reuseBranch:` cases):

```ts
it('reuseBranch: uses the current origin tip, not a stale local branch', async () => {
  const { repoDir, originDir } = await setupRepo()
  tmpDirs.push(repoDir, originDir)
  await makeWorktreeParent()

  // Branch exists on origin AND locally, both at the initial commit.
  await git(['branch', 'feat/story-x', 'origin/main'], repoDir)
  await git(['push', 'origin', 'feat/story-x'], repoDir)

  // Another worker advances origin/feat/story-x; this clone's local ref stays behind.
  const clone2 = await fs.mkdtemp(path.join(os.tmpdir(), 'scrum4me-clone2-'))
  tmpDirs.push(clone2)
  await git(['clone', originDir, clone2], os.tmpdir())
  await git(['config', 'user.email', 'c2@test.com'], clone2)
  await git(['config', 'user.name', 'C2'], clone2)
  await git(['checkout', 'feat/story-x'], clone2)
  await fs.writeFile(path.join(clone2, 'c2.txt'), 'c2')
  await git(['add', '.'], clone2)
  await git(['commit', '-m', 'C2 from another worker'], clone2)
  await git(['push', 'origin', 'feat/story-x'], clone2)
  const { stdout: c2sha } = await git(['rev-parse', 'HEAD'], clone2)

  // repoDir's local feat/story-x is stale (at the initial commit); the reuse path
  // must check out the current origin tip (C2), not the stale local ref.
  const result = await createWorktreeForJob({
    repoRoot: repoDir,
    jobId: 'job-reuse-stale-local',
    branchName: 'feat/story-x',
    baseRef: 'origin/main',
    reuseBranch: true,
  })

  const { stdout: head } = await git(['rev-parse', 'HEAD'], result.worktreePath)
  expect(head.trim()).toBe(c2sha.trim())
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run __tests__/git/worktree.test.ts -t "current origin tip"`
Expected: FAIL — the old code checks out the local ref (initial commit), so `head` ≠ `c2sha`.

- [ ] **Step 3: Implement the fix**

In `src/git/worktree.ts`, inside the `if (reuseBranch) { … }` block, replace the comment-bullets + branch-resolution `if/else` (currently local-first) with origin-first:

```ts
    //   - exists on origin      → reset local to origin/<branch> and use the current tip
    //   - local-only (unpushed) → reuse the local branch as-is
    //   - nowhere               → create it fresh from baseRef
    if (await remoteBranchExists(repoRoot, branchName)) {
      // `-B` create-or-resets <branch> to origin/<branch> and checks it out, so a
      // stale kept local ref can't make the worktree (and the base_sha captured next)
      // lag the real tip — which would otherwise cause a non-ff push.
      await gitRetry(['worktree', 'add', '-B', branchName, worktreePath, `origin/${branchName}`])
    } else if (await branchExists(repoRoot, branchName)) {
      await gitRetry(['worktree', 'add', worktreePath, branchName])
    } else {
      await gitRetry(['worktree', 'add', '-b', branchName, worktreePath, baseRef])
    }
```

(The exact lines being replaced are the three `//   - …` comment bullets and the `if (await branchExists …) { … } else if (await remoteBranchExists …) { … } else { … }` block. Leave the occupant-removal above and the `claimLog(...)` / `return` below unchanged.)

- [ ] **Step 4: Run the new test + the full worktree suite**

Run: `npx vitest run __tests__/git/worktree.test.ts`
Expected: PASS — the new case is green AND the existing `reuseBranch:` cases still pass (local-only `feat/sprint-abc` resolves via the `branchExists` arm since origin doesn't have it; remote-only `feat/sprint-xyz` resolves via the `-B` arm; nowhere falls back to `baseRef`).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/git/worktree.ts __tests__/git/worktree.test.ts
git commit -m "fix(worktree): reused worktrees track current origin tip, not stale local ref"
```

Expected: typecheck exit 0; commit succeeds.

---

## Final verification

- [ ] **Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass; typecheck exit 0.

---

## Spec coverage check

| Spec item | Task |
|---|---|
| Reuse path prefers `origin/<branch>` via `worktree add -B` | Task 1 (Step 3) |
| Local-only + nowhere paths unchanged | Task 1 (Step 3, lower arms) |
| Real-git test: stale local vs origin-ahead → worktree on origin tip | Task 1 (Steps 1–2) |
| base_sha now reflects the origin tip (captured downstream, unchanged) | (follows from the fix; no separate code) |
| null-base fallback / pushBranchForJob origin/main check | out of scope (spec) |
```
