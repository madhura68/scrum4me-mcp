# AGENTS.md — scrum4me-mcp

## Scrum4Me-product
- **Naam:** scrum4me-mcp
- **product_id:** `cmopqt0yj000004jp7lr7mn8e`
- **Definition of Done:** vlekkeloze integratie met scrum4me

Volgt de globale Scrum4Me-methodiek (`~/.claude/rules/scrum4me-methodiek.md` voor Claude; de "Scrum4Me-methodiek"-sectie in `~/.codex/AGENTS.md` voor Codex). Niet-triviaal werk: plan → Sprint/PBI/Story/Taak via de `scrum4me` MCP → `update_task_status` per laag → docs in de DB.

MCP server that exposes the Scrum4Me dev-flow as native tools for Codex.

## Agent worktree-flow

`wait_for_job` creates an isolated git worktree per job so agent changes never touch the user's main checkout.

### How it works

1. On successful claim, `wait_for_job` calls `resolveBranchForJob` first:
   - Looks for a sibling job in the same story that already has a branch
   - If found → reuse that branch (`reused_branch: true` in the response)
   - Otherwise → fresh branch `feat/story-<last-8-chars-of-story-id>`
2. Then `createWorktreeForJob`:
   - Worktree directory: `SCRUM4ME_AGENT_WORKTREE_DIR/<job-id>` (default: `~/.scrum4me-agent-worktrees/<job-id>`)
   - Base: `origin/main` for fresh branches; existing remote tip for reused branches
   - When reusing: any stale sibling worktree still holding the branch is removed first (siblings are sequential)
3. Tool response includes `worktree_path`, `branch_name`, `reused_branch`.
4. **Work exclusively in `worktree_path`** — all file edits and commits go there.
5. On `update_job_status(done|failed)`, `removeWorktreeForJob` runs automatically — but is **deferred** while siblings in the same story are still QUEUED/CLAIMED/RUNNING (next sub-task will reuse the branch). Only the last terminal transition triggers actual cleanup:
   - `keepBranch=true` if `done` and a `branch` was reported (agent pushed)
   - `keepBranch=false` otherwise (branch deleted with worktree)

### Branch-per-story result

A story with 3 sub-tasks lands as **1 branch** with 3 commits and **1 PR** (assuming `auto_pr=true`). Sibling sub-tasks share the same `pr_url` — `maybeCreateAutoPr` reuses an existing PR from a sibling job instead of opening duplicates. Story-level PR title (`<story-code>: <story-title>`) so the GitHub view reads as one logical change rather than per-task fragments.

### PBI fail-cascade

When a `TASK_IMPLEMENTATION` job ends in `FAILED`, `cancelPbiOnFailure` (`src/cancel/pbi-cascade.ts`) cancels every queued/claimed/running sibling under the **same PBI** (across all stories) and undoes already-pushed commits:

- **Open PR** → Forgejo REST close (cascade-comment + state:closed) + best-effort `git push origin --delete <branch>` with `expectedHeadSha`-guard so a late worker-push isn't overwritten.
- **Merged PR** → revert-PR opened against the base branch via `git revert` (parent-count-aware: `-m 1` for merge-commits, plain revert for squash-merges with 1 parent). **No** auto-merge on the revert PR — review by hand.
- **Branch without PR** → best-effort `git push origin --delete <branch>` with `expectedHeadSha`-guard.

A trace (cancelled job count, closed/reverted PRs, deleted branches) is written to the original failed job's `error` column. Race-protection: if a parallel worker tries to `update_job_status` on a job that the cascade already set to `CANCELLED`, the call is rejected with a `JOB_CANCELLED` error so the agent discards local work and calls `wait_for_job` again. The cascade is idempotent and never throws — failures become warnings on the failed-job's trace.

### Required configuration

Set env var per product:

```
SCRUM4ME_REPO_ROOT_<productId>=/absolute/path/to/local/clone
```

Or add to `~/.scrum4me-agent-config.json`:

```json
{
  "repoRoots": {
    "<productId>": "/absolute/path/to/local/clone"
  }
}
```

If no local root is found, `wait_for_job` tries an **on-demand clone** of `product.repo_url` (spec: `docs/superpowers/specs/2026-07-08-on-demand-repo-clone-fallback-design.md`). Only if the clone also fails does it roll the claim back to QUEUED and return an error. Explicit configuration is therefore optional for any product with a valid `repo_url`.

## Token-usage capture (PostToolUse hook)

`update_job_status` accepts optional fields `model_id`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`. The agent never has to pass them — `scripts/persist-job-usage.ts` runs as a PostToolUse hook, reads the local Codex transcript JSONL (no Anthropic API needed), sums per-job usage, and writes directly to `claude_jobs` via Prisma. Window detection: from the most-recent `wait_for_job` tool_use to EOF.

The hook is registered in `.Codex/settings.json` of this repo. **For agent-worker mode** (Codex running with cwd inside a product worktree, not scrum4me-mcp), copy the same hook block into your user settings (`~/.Codex/settings.json`) and set `SCRUM4ME_MCP_DIR` so the script resolves regardless of cwd:

```bash
export SCRUM4ME_MCP_DIR=/absolute/path/to/scrum4me-mcp
```

Pricing rows (`model_prices`) are seeded by Scrum4Me's `prisma/seed.ts`. Unknown `model_id`s leave `cost_usd = NULL` in Insights queries — add a row and re-run `npm run seed` to fill them in.

Robustness notes:
- Subagent (`isSidechain: true`) lines in the main JSONL are skipped to avoid double-counting against `subagents/`-subdirectory transcripts.
- Lines are deduplicated on `uuid` because branching/resumption can rewrite the same message into multiple JSONLs.
- Known Codex bug: auto-updates can silently delete files under `~/.Codex/projects/`. If you depend on these numbers for billing/reporting, persist `claude_jobs.input_tokens` etc. immediately on `update_job_status` (already what this hook does) and consider an external backup of `~/.Codex/projects/` if you want to retain historical detail.

## Manual worktree cleanup

Run `cleanup_my_worktrees` (no arguments) to scan `~/.scrum4me-agent-worktrees/` and remove worktrees for jobs that are in a terminal state (DONE, FAILED, CANCELLED). Worktrees for active jobs (QUEUED, CLAIMED, RUNNING) are left untouched. Returns `{ removed, kept, skipped }`.

## Worker presence

Server-startup registers a `ClaudeWorker` record + starts a 10 s heartbeat; SIGTERM/SIGINT cleans it up. The Scrum4Me NavBar counts active workers via `last_seen_at < now() - 15s` — at 10 s interval one missed tick + jitter can flicker the indicator; bump that threshold in Scrum4Me to ≥ 25 s if needed.

| File | Purpose |
|---|---|
| `src/presence/worker.ts` | `registerWorker` (upsert + pg_notify worker_connected) + `unregisterWorker` |
| `src/presence/heartbeat.ts` | `startHeartbeat` — 10 s interval, self-heals by re-registering when record disappears |
| `src/presence/shutdown.ts` | `registerShutdownHandlers` — SIGTERM/SIGINT → stop heartbeat + unregister |
| `src/index.ts` | Bootstrap: calls `getAuth` → `registerWorker` → `startHeartbeat` → `registerShutdownHandlers` |

## Key source files

| File | Purpose |
|---|---|
| `src/git/worktree.ts` | `createWorktreeForJob` + `removeWorktreeForJob` |
| `src/git/on-demand-clone.ts` | `cloneRepoOnDemand` — on-demand clone fallback voor `resolveRepoRoot` |
| `src/tools/wait-for-job.ts` | `resolveRepoRoot`, `rollbackClaim`, `attachWorktreeToJob` |
| `src/tools/update-job-status.ts` | `cleanupWorktreeForTerminalStatus` |
| `src/tools/cleanup-my-worktrees.ts` | `cleanup_my_worktrees` tool — scans + removes stale worktrees |

## Testing

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

All worktree helpers have unit tests under `__tests__/git/worktree.test.ts`, `__tests__/wait-for-job-worktree.test.ts`, and `__tests__/update-job-status-worktree.test.ts`.
