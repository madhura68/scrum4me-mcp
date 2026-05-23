---
title: Sprint-context bounding via per-task sub-agents (+ token attribution)
status: draft
author: janpetervisser
version: 0.1
date: 2026-05-23
follows: ./2026-05-23-worker-agent-guide-consolidation-design.md
---

# Sprint execution: bound context with per-task sub-agents

## Context

A `SPRINT_IMPLEMENTATION` job runs as a **single** `claude -p` session that processes
all `task_executions[]` sequentially (`scrum4me-docker/bin/run-one-job.ts` spawns one
invocation; `src/prompts/sprint/implementation.md` loops over the tasks in that one
session). Claude Code auto-compacts so it won't hard-crash, but the single context grows
across every task → expensive, and compaction is lossy, degrading quality late in a
sprint. (Task jobs don't have this problem — each is its own fresh `claude -p`.)

We bound the main context by having the sprint session **orchestrate per-task sub-agents**:
each task's heavy implementation work runs in a disposable sub-agent context; the main
session keeps only summaries + state transitions + the verify-gate.

Because sub-agent token usage is currently **dropped** from cost reporting
(`scripts/persist-job-usage.ts:91` filters out `isSidechain` lines), this spec also fixes
token attribution so sprint cost stays accurate.

## Decisions (from brainstorm)

| Decision | Choice |
|---|---|
| Approach | **A — sub-agents within the sprint session** (not splitting into per-task invocations; not just compaction) |
| Sub-agent tool name | **`Agent`** (renamed from `Task` in Claude Code v2.1.63; verified via docs) |
| Sub-agent tools | Inherit parent tools by default → sub-agents can call MCP logging tools directly (no custom agent-definition files for v1) |
| Token attribution | **Spike-first, in this spec**: empirically determine sub-agent transcript layout, then sum it into the job total |
| Scope | **scrum4me-mcp only** — the runner imports `job-config.ts`, so the allowlist change propagates without touching scrum4me-docker |

## Design

### 1. Sprint orchestration (`src/prompts/sprint/implementation.md` rewrite)

The main sprint session becomes a thin orchestrator. Hard rules unchanged (no
`wait_for_job`/`job_heartbeat`, worktree-only, call `get_agent_guide`). For each
`task_execution` in `order`:

1. **Main:** `update_task_execution({ execution_id, status: 'RUNNING' })` +
   `update_task_status({ task_id, status: 'in_progress', sprint_run_id })`.
2. **Main → dispatch an `Agent` sub-agent** with a self-contained prompt: the task's
   `plan_snapshot`, the relevant `task`/`story`/`pbi` context from the payload, the
   `worktree_path`, and instructions to: implement in the worktree, commit per logical
   layer (no `git push`), log via `log_implementation` / `log_commit` / `log_test_result`,
   and **return a concise summary** (what changed, commit hashes, test outcomes).
3. **Main:** run the verify-gate `verify_sprint_task({ execution_id })` — this stays in
   the main session and is **authoritative** (not the sub-agent's self-assessment). On
   `DIVERGENT`: stop the sprint, `update_job_status('failed')`.
4. **Main:** on `ALIGNED`/`PARTIAL` → `update_task_execution(DONE)` +
   `update_task_status(done)`; on `EMPTY` → `update_task_execution(SKIPPED)` +
   `update_task_status(done)`.

After the last task: `update_job_status({ status: 'done', summary })` (PR-promotion logic
unchanged). The main context holds only per-task summaries + state calls + verify results
→ bounded regardless of sprint size. Both main and sub-agent share the same `cwd`
(worktree), so the sub-agent's commits are visible to `verify_sprint_task`.

### 2. Allowlist (`src/lib/job-config.ts`)

Add `'Agent'` to the **SPRINT_IMPLEMENTATION** allow-list only (the
`[...TASK_TOOLS, update_task_execution, verify_sprint_task]` array). `TASK_IMPLEMENTATION`
stays without `Agent` (single-shot, no sub-agents). Sub-agents inherit the parent's tools,
so they get `Read`/`Edit`/`Write`/`Bash`/`Grep`/`Glob` + the MCP logging tools for free.

### 3. Token attribution (`scripts/persist-job-usage.ts`) — spike-first

**Spike (must run first):** execute one real `SPRINT_IMPLEMENTATION` job that uses
sub-agents, then inspect `~/.claude/projects/<project-slug>/` to determine: where
sub-agent transcripts are written (e.g. a `subagents/` subdir), how they associate to the
parent session (`parent_tool_use_id` / `session_id` / filename), and how their assistant
`usage` lines look. Record findings in the plan.

**Implementation (after spike):** extend usage computation so the job total =
main-session assistant usage (current behavior, `isSidechain` still skipped in the main
transcript) **plus** the summed assistant `usage` from the associated sub-agent
transcripts for the same session window — **without double-counting** (the whole reason
the main transcript's `isSidechain` lines are skipped). Keep it best-effort and
non-blocking (the hook already swallows errors and exits 0).

## Files

**Modify**
- `src/prompts/sprint/implementation.md` — rewrite workflow to orchestrate per-task sub-agents.
- `src/lib/job-config.ts` — add `'Agent'` to the SPRINT allow-list.
- `scripts/persist-job-usage.ts` — sum sub-agent transcripts into the job total.

**Tests**
- `__tests__/job-config.test.ts` — SPRINT allows `Agent`; TASK does not.
- `__tests__/kind-prompts.test.ts` — sprint prompt instructs `Agent` dispatch; keeps safety hardstops + `get_agent_guide`; keeps `verify_sprint_task` in the main flow.
- `__tests__/scripts/persist-job-usage.test.ts` — fixture (built from spike findings) with a main transcript + sub-agent transcript(s); assert the combined total and no double-count.

## Verification (end-to-end)

1. **Spike:** real sprint-with-sub-agents → transcript layout documented in the plan.
2. **Unit:** allow-list assertions; sprint-prompt assertions; usage-summation fixture test.
3. **Smoke (real sprint):** a multi-task sprint job runs; confirm each task ran in a
   sub-agent (main context stays small), `verify_sprint_task` gated each task, and the
   persisted `claude_jobs` token total reflects main + sub-agent usage.
4. `npm test` + `npm run typecheck` green (modulo the known `@types/express` errors).

## Risks / unknowns

- **Transcript layout (token fix)** — undocumented; resolved by the spike before coding.
- **Sub-agent reliability in `-p`** — verified supported; the smoke step confirms it end-to-end in the runner image.
- **Verify-gate authority** — the main session trusts `verify_sprint_task` (worktree diff vs `plan_snapshot`), not the sub-agent's self-report, so a sloppy sub-agent summary can't pass a bad task.

## Out of scope (YAGNI / deferred)

- **Splitting sprints into per-task `claude -p` invocations** (Approach B) — runner rework, deferred.
- **Sub-agents for `TASK_IMPLEMENTATION`** — single-shot jobs don't need them.
- **Custom agent-definition files** to restrict sub-agent toolsets — inheritance is fine for v1.
- **scrum4me-docker changes** — none needed (allow-list propagates via `job-config.ts`).
- The other job-startup robustness items (claim-side observability, lease/heartbeat jitter, worktree retry) — still a separate future spec.
