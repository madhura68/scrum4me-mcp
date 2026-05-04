# Changelog

All notable changes to scrum4me-mcp.

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
