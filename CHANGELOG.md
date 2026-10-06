# Changelog

All notable changes to scrum4me-mcp.

## [Unreleased]

M45-2b: `HARNESS`, a LiteLLM model on a per-product configuration, becomes a third worker runtime beside `CLAUDE` and `CODEX`. Without a product choice, job routing and the claim of Claude and Codex jobs stay as before; the startup check of `SCRUM4ME_WORKER_RUNTIME` and the `dispatch_job` refusal below apply regardless. No `HARNESS` row exists in a shared database before the cutover.

### Added

- **`HARNESS` worker runtime** — `SCRUM4ME_WORKER_RUNTIME=HARNESS`. A HARNESS worker claims only HARNESS jobs (`IDEA_CHAT`, standalone `TASK_IMPLEMENTATION`) and no other worker claims them. `wait_for_job` returns `config: { runtime: 'HARNESS', model, max_cost_usd }` (ceiling from `product_harness_choices`); the `IDEA_CHAT` payload has `prompt_text: ''` and a standalone `TASK_IMPLEMENTATION` payload has no `prompt_text`. New tool errors: `RUNTIME_MISMATCH` (claim given back, job `QUEUED` again) and `HARNESS_CONFIGURATION_INVALID` / `HARNESS_COST_LIMIT_INVALID` / `HARNESS_KIND_UNSUPPORTED` (job `FAILED`).
- **`health`** — returns `runtimes: ['CLAUDE', 'CODEX', 'HARNESS']`.
- **`update_job_status`** — optional `cost: { reported_cost_usd, cost_source, provider? }` for a HARNESS job on `done`/`failed`/`skipped` (else `COST_REPORT_NOT_ALLOWED`; invalid: `COST_REPORT_INVALID`; both checked before any side effect). The amount is rounded up to 6 decimals and stored in `job_cost_reports` in the same transaction as the status update.
- **Routing** — a standalone `TASK_IMPLEMENTATION`, `send_idea_chat_message` and the idea-chat follow-up job read the product's HARNESS choice (`product_harness_choices`): with one, the job gets runtime `HARNESS` and the configuration as `requested_model`.

### Changed

- **`SCRUM4ME_WORKER_RUNTIME`** — an unknown value now stops the process at startup (`UNKNOWN_AGENT_RUNTIME`, exit code 1) instead of silently becoming `CLAUDE`. Empty or unset is still `CLAUDE`.
- **`dispatch_job`** — refuses every `required_capability`: the `local_llm` route is replaced by a HARNESS configuration per product.
- **Git protection** — one predicate, `isHarnessJob` (`runtime = 'HARNESS'` or `required_capability = 'local_llm'`), now decides the git protection of a guarded job and the `update_job_status` exemptions (no auto-PR, no status propagation, no PBI fail-cascade) for both kinds of job.
- **Dispatch integration gate** — its test database gets the two M45-2a migrations (Scrum4Me `ae6483b2`) as an additive overlay, so `DISPATCH_TEST_SCHEMA_ROOT` must be a full clone that contains that commit.

### Schema

- `vendor/scrum4me-shared` bumped to `132656b`; `prisma/schema.prisma` regenerated with `AgentRuntime.HARNESS` and the models `ProductHarnessChoice` and `JobCostReport`.

### Migration notes

- Requires the Scrum4Me M45-2a migrations (`20261006120000_agent_runtime_harness`, `20261006120100_harness_choices_cost_reports`) and a Prisma client regenerated against `scrum4me-shared` `132656b`.
- Before updating an installation, check `SCRUM4ME_WORKER_RUNTIME`: only empty, `CLAUDE`, `CODEX` or `HARNESS` (any case) still starts.
- The database role needs `SELECT` on `product_harness_choices` (read on every enqueue path, also without a choice) and `SELECT`/`INSERT`/`UPDATE` on `job_cost_reports`.

## [0.6.0] — 2026-05-04

Adds support for Scrum4Me M12 (Idea entity + Grill/Plan jobs).

### Added

- **`get_idea_context(idea_id)`** — fetch full idea + product + recent logs + open questions for agent context.
- **`update_idea_grill_md(idea_id, markdown)`** — save grill-result + transition to GRILLED + IdeaLog{GRILL_RESULT}.
- **`update_idea_plan_md(idea_id, markdown)`** — save plan with server-side yaml-frontmatter validation; ok → PLAN_READY, parse-fail → PLAN_FAILED + IdeaLog{JOB_EVENT, errors}.
- **`log_idea_decision(idea_id, type, content, metadata?)`** — DECISION/NOTE entries on the idea timeline.

### Changed

- **`ask_user_question`** — now accepts exact one of `story_id` OR `idea_id` (zod xor refine). Idea-questions are user-private (owner-scoped, no productAccessFilter).
- **`wait_for_job`** — response now includes `kind: 'TASK_IMPLEMENTATION' | 'IDEA_GRILL' | 'IDEA_MAKE_PLAN'`. For idea-jobs the payload returns `idea`, `product`, `repo_url`, `prompt_text` (embedded prompt from `src/prompts/idea/`) and **no worktree** (agent works in user's existing repo).
- **`update_job_status`** — for `failed` on `IDEA_GRILL` / `IDEA_MAKE_PLAN`: idea status auto-transitions to `GRILL_FAILED` / `PLAN_FAILED` + IdeaLog{JOB_EVENT}. Auto-PR + worktree-cleanup skipped for idea-jobs.
- **Health version** — now read dynamically from `package.json` at module load (was hardcoded; resolved sync-issues at deploy time).

### Schema

- Vendored `prisma/schema.prisma` synced with Scrum4Me M12 (Idea + IdeaLog models, IdeaStatus + ClaudeJobKind + IdeaLogType enums, ClaudeJob.task_id nullable + idea_id + kind, ClaudeQuestion.story_id nullable + idea_id, check-constraints, pg_notify-trigger update).
- Pinned to scrum4me commit on branch `feat/m12-ideas` until merged to main.

### Migration notes

- Requires Scrum4Me database to have M12 migration applied (`20260504172747_add_ideas_and_grill_jobs`).
- Worker runtime: see `vendor/scrum4me/docs/runbooks/mcp-integration.md` — batch-loop now switches on `kind` discriminator.

## [0.5.0] — earlier

Version bump (no changelog entry).
