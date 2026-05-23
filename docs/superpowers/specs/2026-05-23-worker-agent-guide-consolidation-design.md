---
title: Worker operating manual — consolidate into the agent-guide
status: draft
author: janpetervisser
version: 0.1
date: 2026-05-23
follows: ./2026-05-23-agent-guide-prompt-design.md
---

# Worker operating manual: consolidate into the agent-guide

## Context

A Scrum4Me worker today receives instructions from **five** sources with significant
duplication:

1. **Kind-prompt** (`src/prompts/<kind>/*.md`) — per-job-kind workflow, delivered as the
   top-level `claude -p` prompt (always present).
2. **Agent-guide** (`src/lib/agent-guide-default.ts` + per-product `ProductDoc` override,
   via `get_agent_guide` / `get_claude_context`) — binding build/doc/verify guidance.
   **Content is currently a placeholder.**
3. **MCP `INSTRUCTIONS`** (`src/instructions.ts`) — handshake bootstrap pointer.
4. **`scrum4me-docker/CLAUDE.md`** — auto-loaded at `/opt/agent/CLAUDE.md`; runner
   identity + hardstop rules (separate repo).
5. **Product-repo `CLAUDE.md`** — auto-loaded because `cwd = worktree_path`.

The same rules (no `wait_for_job`/`job_heartbeat`, no manual push/PR, worktree-only,
logging/verify discipline) appear across sources 1, 2, and 4 → drift risk. Now that the
agent-guide exists as a per-product, versioned, worker-agnostic channel, it is the right
home for the **build & document house-style**. This spec rewrites the placeholder
agent-guide into a real operating manual and removes the duplicated house-style from the
kind-prompts.

## Decisions (from brainstorm)

| Decision | Choice |
|---|---|
| Consolidation model | **Tiered ownership** (not "everything in one file") |
| Safety hardstops | Stay **auto-present in kind-prompts** — the agent-guide is pull-only, so safety rules must not move there |
| Scope of this spec | **scrum4me-mcp only**; trimming `scrum4me-docker/CLAUDE.md` is a separate follow-up |
| Dedupe depth | **Targeted** — write the rich guide, remove clearly-duplicated house-style from kind-prompts, keep per-kind procedure + safety |
| Language | Guide stays **English** (matches the current `agent-guide-default.ts`; AI-facing). Flippable to Dutch on review. |

## The tiered ownership model

| Tier | Owner (single source) | Auto-present? | Customizable? |
|---|---|---|---|
| **Safety hardstops** — no `wait_for_job`/`check_queue_empty`/`job_heartbeat`; no manual `git push`/PR/publish/deploy; worktree-only; ask-don't-guess for blocking forks | **kind-prompts** | yes (top-level prompt) | no |
| **Build & document house-style** — commit granularity, logging discipline, verify expectations, doc-capture, DRY/YAGNI, reuse patterns, quality gates | **agent-guide** | no (pull; kind-prompt instructs the call) | yes (per-product override) |
| **Per-kind workflow** — grill loop, make-plan structure, review rounds, task vs sprint steps, the exact verify tool | **kind-prompts** | yes | no |
| **Runner environment** — agent identity, `/opt/agent`, `cwd=worktree`, MCP config | **scrum4me-docker/CLAUDE.md** (follow-up) | yes | no |

## Design

### 1. Rewrite `src/lib/agent-guide-default.ts`

Replace the placeholder with the operating manual below (the global default; per-product
`ProductDoc(MANUAL, agent-guide)` overrides still append underneath via the existing
resolver). It deliberately does **not** restate the safety hardstops (those live in the
kind-prompt) and frames itself as the house-style. Target size: ~1.5–3 KB (well under
`AGENT_GUIDE_MAX_CHARS = 16_000`, leaving room for overrides).

```md
# Worker operating guide — building & documenting

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
```

### 2. Targeted dedupe of the kind-prompts

Only the two **implementation** prompts are in scope (they already call `get_agent_guide`
from the prior feature):
- `src/prompts/task/implementation.md`
- `src/prompts/sprint/implementation.md`

**Remove** prose that merely restates the agent-guide house-style now that the guide owns
it, e.g. generic "commit per logical layer / reuse patterns / run tests before done"
rationale and the verbose logging explanation.

**Keep** (unchanged):
- The numbered per-kind **procedure** (mark in_progress → work → the kind-specific
  verify tool → close out).
- **All safety hardstops** (see the canonical list below).
- The existing `get_agent_guide` rule (added previously).

The `idea/*` and `plan-chat/chat.md` prompts are **not** touched (the guide is
implementation-focused; idea/plan jobs keep their own workflow).

> Net: the implementation prompts shrink to procedure + safety + "follow the agent-guide";
> the *how-to-do-it-well* lives once, in the guide.

### 3. Canonical safety hardstops (must survive dedupe)

The dedupe must not remove these from the implementation kind-prompts:
- No `mcp__scrum4me__wait_for_job`, no `check_queue_empty` (the runner already claimed).
- No `mcp__scrum4me__job_heartbeat` in SPRINT (the runner renews the lease).
- Work **only** in `worktree_path`; no edits elsewhere.
- No manual `git push` / PR creation (`update_job_status` drives it).
- Use `ask_user_question` for genuinely blocking forks; don't guess.

## Verification

1. **Unit — agent-guide content** (`__tests__/lib/agent-guide-default.test.ts`, update):
   non-empty; model-agnostic (no `claude`); contains the new markers (`log_implementation`,
   `log_commit`, `create_product_doc`, and section headers `Build well` / `Document as you
   go` / `Verify`); length under a sane bound (e.g. < 8000 chars). Remove the old `worktree`
   assertion (that concept now lives in the kind-prompt, not the guide).
2. **Unit — safety preserved** (`__tests__/kind-prompts.test.ts`, extend): task and sprint
   prompts still match the safety hardstops (`/GEEN.*wait_for_job/`, sprint
   `/GEEN.*job_heartbeat/`, a worktree-only rule) **and** still contain `get_agent_guide`.
   This guards the targeted dedupe from deleting safety rules.
3. **Resolver still merges** (existing `__tests__/lib/agent-guide.test.ts`): unchanged —
   confirms the new, larger default still merges with an override under the cap.
4. `npm test` and `npm run typecheck` green (modulo the known pre-existing `@types/express`
   errors in `src/http.ts`).

## Out of scope (YAGNI / deferred)

- **Trimming `scrum4me-docker/CLAUDE.md`** → separate follow-up PR in that repo (slim to
  runner-environment facts; point to the agent-guide for behavior).
- **Job-startup robustness** (lease/heartbeat, worktree retry, repo-root logging, sprint
  checkpointing, spawn timeout, etc.) → its own spec (sequenced after this one).
- **Delivery mechanism** — already shipped (`get_agent_guide` + `get_claude_context` +
  `INSTRUCTIONS` pointer); no change needed.
- **Per-product override authoring UI / `set_agent_guide` wrapper** — unchanged from the
  prior spec's deferral.
- Touching `idea/*` and `plan-chat` prompts.

## Follow-ups

- Follow-up A: `scrum4me-docker/CLAUDE.md` slim-down (separate repo/PR).
- Follow-up B: job-startup robustness spec (reliability + speed + correctness +
  observability, per the brainstorm).
