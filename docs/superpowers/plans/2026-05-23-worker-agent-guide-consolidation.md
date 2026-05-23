# Worker Operating Manual Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder agent-guide with a real worker operating manual (build & document house-style), then dedupe the duplicated house-style out of the task/sprint kind-prompts while keeping safety hardstops auto-present.

**Architecture:** Tiered ownership. The agent-guide (`src/lib/agent-guide-default.ts`, delivered via the already-shipped `get_agent_guide`/`get_claude_context`) becomes the single home for build/document standards. The kind-prompts keep per-kind procedure + non-negotiable safety hardstops and point to the guide for the "how to do it well." No delivery-mechanism changes (already shipped).

**Tech Stack:** TypeScript (ESM), Vitest. Content-only change — no new runtime code.

**Spec:** `docs/superpowers/specs/2026-05-23-worker-agent-guide-consolidation-design.md`

---

## File Structure

**Modify**
- `src/lib/agent-guide-default.ts` — rewrite `AGENT_GUIDE_DEFAULT` string.
- `__tests__/lib/agent-guide-default.test.ts` — update assertions to the new content markers.
- `src/prompts/task/implementation.md` — trim duplicated house-style (steps 3–4).
- `src/prompts/sprint/implementation.md` — trim duplicated house-style (step 4).
- `__tests__/kind-prompts.test.ts` — add safety/invariant regression guards.

No new files. No changes to delivery (`get_agent_guide`, `get_claude_context`, `instructions.ts`) — already shipped.

---

## Task 1: Rewrite the agent-guide default content

**Files:**
- Modify: `src/lib/agent-guide-default.ts`
- Test: `__tests__/lib/agent-guide-default.test.ts`

- [ ] **Step 1: Update the test to the new content markers (red against old content)**

Replace the entire body of `__tests__/lib/agent-guide-default.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { AGENT_GUIDE_DEFAULT } from '../../src/lib/agent-guide-default.js'

describe('AGENT_GUIDE_DEFAULT', () => {
  it('is non-empty and within a sane size bound', () => {
    expect(AGENT_GUIDE_DEFAULT.length).toBeGreaterThan(0)
    expect(AGENT_GUIDE_DEFAULT.length).toBeLessThan(8000)
  })

  it('is model-agnostic (no brand coupling)', () => {
    expect(AGENT_GUIDE_DEFAULT.toLowerCase()).not.toContain('claude')
  })

  it('references the MCP documenting tools', () => {
    expect(AGENT_GUIDE_DEFAULT).toContain('log_implementation')
    expect(AGENT_GUIDE_DEFAULT).toContain('log_commit')
    expect(AGENT_GUIDE_DEFAULT).toContain('create_product_doc')
  })

  it('has the operating-manual section headers', () => {
    expect(AGENT_GUIDE_DEFAULT).toContain('Build well')
    expect(AGENT_GUIDE_DEFAULT).toContain('Document as you go')
    expect(AGENT_GUIDE_DEFAULT).toContain('Verify and hand off')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/lib/agent-guide-default.test.ts`
Expected: FAIL — old content lacks the headers `Build well` / `Document as you go` / `Verify and hand off`.

- [ ] **Step 3: Rewrite `src/lib/agent-guide-default.ts`**

Replace the whole file with:

```ts
// Global default "build & document" worker operating manual. Embedded as a TS
// string (not a runtime .md read): tsc does not copy .md into dist, and the MCP
// server may run from dist/ — a TS module compiles normally and works from src/
// and dist/. Keep model-agnostic: reference MCP tools and the git/PR flow, not
// any vendor. Deliberately does NOT restate the safety hardstops — those live in
// the kind-prompt (always-present top-level prompt). Per-product ProductDoc
// overrides append underneath this via resolveAgentGuide.
export const AGENT_GUIDE_DEFAULT = `# Worker operating guide — building & documenting

This is the standard for HOW to do good work in this product. Your job prompt carries the
non-negotiable safety rules and the step-by-step for your job type; this guide is about
doing the work well within them. It is binding — follow it together with the task's own
implementation plan.

## Build well
- Make the smallest change that satisfies the task. Don't add features, abstractions, or
  error handling for cases that can't happen (YAGNI).
- Reuse existing utilities and patterns before adding new ones; search the code and the
  product docs first.
- Work in small, logical commits: read, change, test, then commit each layer with a
  message that explains the why, not just the what.
- Fix root causes, not symptoms. Never bypass checks to make an obstacle disappear.
- Run the test suite and the type checker before considering work done.
- Add code comments only when the why is non-obvious; let names carry the what.

## Document as you go
- Record each meaningful step with log_implementation (what changed and why).
- Record every commit with log_commit (commit hash + message).
- Record each test or build run with log_test_result (PASSED/FAILED + a short explanation).
- Before implementing, use search_product_docs to find existing architecture, patterns,
  and decisions, and follow them.
- When you introduce architecture, a pattern, or a decision worth keeping, capture it with
  create_product_doc in the right folder. Don't document the obvious or leave stray notes.

## Verify and hand off
- Run the verify gate for your job type before marking work done (your job prompt names the
  exact tool).
- Ship through the configured automation; let the job-status flow open the PR.

## When to ask
- If a blocking decision genuinely needs the user, ask with ask_user_question and wait for
  the answer. Don't guess on ambiguous requirements — but don't ask for anything you can
  derive from the plan or the docs.
`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/lib/agent-guide-default.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Confirm the resolver test still passes (larger default still merges under the cap)**

Run: `npx vitest run __tests__/lib/agent-guide.test.ts`
Expected: PASS (5 tests) — the merge + size-cap behavior is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent-guide-default.ts __tests__/lib/agent-guide-default.test.ts
git commit -m "feat(agent-guide): rewrite default as worker operating manual"
```

---

## Task 2: Targeted dedupe of the implementation kind-prompts

This is a refactor under green regression guards: add tests that lock the safety + key invariants (they pass on current content), then trim the duplicated house-style and confirm the guards stay green.

**Files:**
- Test: `__tests__/kind-prompts.test.ts` (extend)
- Modify: `src/prompts/task/implementation.md`
- Modify: `src/prompts/sprint/implementation.md`

- [ ] **Step 1: Add safety/invariant regression guards**

Append this describe block to `__tests__/kind-prompts.test.ts`:

```ts
describe('implementation prompts: invariants preserved after dedupe', () => {
  it('TASK keeps safety hardstops, worktree rule, guide pointer, logging tools', () => {
    const t = getKindPromptText('TASK_IMPLEMENTATION')
    expect(t).toMatch(/GEEN.*wait_for_job/)
    expect(t).toContain('worktree')
    expect(t).toContain('get_agent_guide')
    expect(t).toContain('log_implementation')
    expect(t).toContain('log_commit')
    expect(t).toContain('log_test_result')
  })

  it('SPRINT keeps safety hardstops, worktree rule, guide pointer, logging tools', () => {
    const s = getKindPromptText('SPRINT_IMPLEMENTATION')
    expect(s).toMatch(/GEEN.*job_heartbeat/)
    expect(s).toContain('worktree')
    expect(s).toContain('get_agent_guide')
    expect(s).toContain('log_implementation')
    expect(s).toContain('log_commit')
    expect(s).toContain('log_test_result')
  })
})
```

- [ ] **Step 2: Run the test and confirm it PASSES on current content**

Run: `npx vitest run __tests__/kind-prompts.test.ts`
Expected: PASS — these invariants already hold; they now guard the dedupe edits below.

- [ ] **Step 3: Trim `src/prompts/task/implementation.md` (step 3)**

Find this block under `## Workflow`:

```markdown
3. **Implementeer** de taak: lees → verander → test → commit per logische laag.
   Gebruik `git add -A && git commit` per laag, **geen** `git push`.
```

Replace it with:

```markdown
3. **Implementeer** de taak. Commit per logische laag met `git add -A && git commit`,
   **geen** `git push`. Volg de agent-guide voor commit- en test-discipline.
```

- [ ] **Step 4: Trim `src/prompts/task/implementation.md` (step 4)**

Find this block:

```markdown
4. **Logging per laag**:
   - `mcp__scrum4me__log_implementation` met een korte beschrijving van wat je
     gewijzigd hebt en waarom.
   - `mcp__scrum4me__log_commit` met `commit_hash` en `commit_message` na elke
     commit (haal hash uit `git rev-parse HEAD`).
   - `mcp__scrum4me__log_test_result` met PASSED/FAILED en uitleg na elke
     `npm test` of build-run.
```

Replace it with:

```markdown
4. **Logging per laag**: `mcp__scrum4me__log_implementation`,
   `mcp__scrum4me__log_commit` (hash uit `git rev-parse HEAD`) en
   `mcp__scrum4me__log_test_result` — zie de agent-guide voor wat elk moet bevatten.
```

- [ ] **Step 5: Trim `src/prompts/sprint/implementation.md` (step 4)**

Find this block under `## Workflow per task_execution`:

```markdown
4. **Per laag loggen**:
   - `mcp__scrum4me__log_implementation`
   - `mcp__scrum4me__log_commit`
   - `mcp__scrum4me__log_test_result` (PASSED/FAILED)
```

Replace it with:

```markdown
4. **Per laag loggen**: `mcp__scrum4me__log_implementation`,
   `mcp__scrum4me__log_commit`, `mcp__scrum4me__log_test_result` (PASSED/FAILED) —
   zie de agent-guide voor wat elk moet bevatten.
```

- [ ] **Step 6: Run the guards + full kind-prompt suite to confirm invariants held**

Run: `npx vitest run __tests__/kind-prompts.test.ts`
Expected: PASS — all invariants (safety hardstops, worktree rule, `get_agent_guide`, logging tool names) still present after the trim.

- [ ] **Step 7: Commit**

```bash
git add src/prompts/task/implementation.md src/prompts/sprint/implementation.md __tests__/kind-prompts.test.ts
git commit -m "refactor(kind-prompts): dedupe house-style now owned by the agent-guide"
```

---

## Final verification

- [ ] **Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass; typecheck reports only the known pre-existing `@types/express` errors in `src/http.ts` (unrelated).

- [ ] **Eyeball the merged guide shape (optional, no DB needed)**

Confirm `src/lib/agent-guide-default.ts` reads as a coherent standalone operating manual and the two prompts still read as complete procedures after the trim.

---

## Spec coverage check

| Spec item | Task |
|---|---|
| Rewrite `agent-guide-default.ts` into a real operating manual (house-style; no restated hardstops) | Task 1 |
| Update agent-guide content test (new markers, drop `worktree`, size bound) | Task 1 |
| Targeted dedupe of task/sprint prompts (trim duplicated house-style, keep procedure + safety) | Task 2 |
| Safety hardstops preserved (regression guard test) | Task 2 |
| `idea/*` and `plan-chat` untouched | (no task — out of scope by omission) |
| docker-CLAUDE.md trim / job-startup | deferred follow-ups (not in this plan) |
```
