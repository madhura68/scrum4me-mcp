# CLAUDE.md — scrum4me-mcp

MCP server that exposes the Scrum4Me dev-flow as native tools for Claude Code.

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

## Forgejo PR-automatisering

PR-automatisering (create / mark-ready / auto-merge / close / revert / files-list) gaat via Forgejo REST tegen `git.jp-visser.nl`. Geen GitHub CLI (`gh`) meer; GitHub is alleen mirror.

### Env-vars

| Var | Doel | Default |
|---|---|---|
| `FORGEJO_HOST` | Primary host voor REST base-URL | `git.jp-visser.nl` |
| `FORGEJO_HOSTS` | Comma-sep whitelist voor URL-parsers (alleen URLs op deze hosts worden geaccepteerd) | `${FORGEJO_HOST}` |
| `FORGEJO_TOKEN` | `Authorization: token <…>` voor write-operaties. Scopes: `repo` (volledige PR-flow) + `write:repository`. | — |

`FORGEJO_TOKEN` wordt **lazy** opgevraagd per write-operatie. De server start zonder token; read-only tools (`getPullRequestState`, `listPullRequestFiles`) werken op publieke repos zonder token. Write-acties (`createPullRequest`, `enableAutoMergeOnPr`, `markPullRequestReady`, `closePullRequest`, `createRevertPullRequest`) geven een typed `FORGEJO_AUTH_REQUIRED` error wanneer de env-var ontbreekt. De tokenwaarde wordt nooit in logs of error-messages opgenomen (redactor in `src/git/forgejo-rest.ts`).

### Sprint-mode draft = WIP-prefix

Forgejo 15.0.2 heeft géén `draft`-veld in `POST /pulls` en géén ready-transition endpoint. Implementatie:
- `createPullRequest({ draft: true })` → title krijgt prefix `WIP: `.
- `markPullRequestReady({ prUrl })` → GET de PR, strip `WIP: ` / `[WIP] ` prefix, PATCH de title terug. Idempotent (geen-op bij ontbrekende prefix).

### Auto-merge (PBI-47)

`enableAutoMergeOnPr` doet eerst een discovery-call (`/version` + `/swagger.v1.json`, gecached per host) om te verifiëren dat `merge_when_checks_succeed` in `MergePullRequestOption` zit. Bij ontbreken: typed `AUTO_MERGE_NOT_ALLOWED` zonder een merge-call te doen — direct mergen is bewust géén fallback.

Bij wél-support: `POST /pulls/{idx}/merge` met `{Do:'squash', merge_when_checks_succeed:true, head_commit_id:<expectedHeadSha>}`. Forgejo's `head_commit_id`-check is mogelijk losser dan GitHub's `--match-head-commit` — bij twijfel verifieer in de smoke-stap dat een mismatch echt 409 oplevert.

### URL-validatie

`set_pbi_pr` accepteert alleen Forgejo-URLs op hosts in `FORGEJO_HOSTS`. GitHub URLs worden geweigerd met typed `LEGACY_GITHUB_URL`. Bestaande DB-records met github.com URLs blijven onveranderd; alleen nieuwe writes worden tegengehouden.

### Encoding-regel

`src/git/forgejo-rest.ts` past `encodePathSegment` toe op URL-segmenten (owner, repo, branchnames in path). JSON-body refs (`head`, `base`) worden **raw** doorgegeven — Forgejo doet zelf ref-matching en encoding daar leidt tot mismatches voor branchnames met slashes (bv. `feat/foo/bar`).

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

If no repo root is found, `wait_for_job` rolls the claim back to QUEUED and returns an error.

## Token-usage capture (PostToolUse hook)

`update_job_status` accepts optional fields `model_id`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`. The agent never has to pass them — `scripts/persist-job-usage.ts` runs as a PostToolUse hook, reads the local Claude Code transcript JSONL (no Anthropic API needed), sums per-job usage, and writes directly to `claude_jobs` via Prisma. Window detection: from the most-recent `wait_for_job` tool_use to EOF.

The hook is registered in `.claude/settings.json` of this repo. **For agent-worker mode** (Claude Code running with cwd inside a product worktree, not scrum4me-mcp), copy the same hook block into your user settings (`~/.claude/settings.json`) and set `SCRUM4ME_MCP_DIR` so the script resolves regardless of cwd:

```bash
export SCRUM4ME_MCP_DIR=/absolute/path/to/scrum4me-mcp
```

Pricing rows (`model_prices`) are seeded by Scrum4Me's `prisma/seed.ts`. Unknown `model_id`s leave `cost_usd = NULL` in Insights queries — add a row and re-run `npm run seed` to fill them in.

Robustness notes:
- Subagent (`isSidechain: true`) lines in the main JSONL are skipped to avoid double-counting against `subagents/`-subdirectory transcripts.
- Lines are deduplicated on `uuid` because branching/resumption can rewrite the same message into multiple JSONLs.
- Known Claude Code bug: auto-updates can silently delete files under `~/.claude/projects/`. If you depend on these numbers for billing/reporting, persist `claude_jobs.input_tokens` etc. immediately on `update_job_status` (already what this hook does) and consider an external backup of `~/.claude/projects/` if you want to retain historical detail.

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
| `src/tools/wait-for-job.ts` | `resolveRepoRoot`, `rollbackClaim`, `attachWorktreeToJob` |
| `src/tools/update-job-status.ts` | `cleanupWorktreeForTerminalStatus` |
| `src/tools/cleanup-my-worktrees.ts` | `cleanup_my_worktrees` tool — scans + removes stale worktrees |

## Testing

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

All worktree helpers have unit tests under `__tests__/git/worktree.test.ts`, `__tests__/wait-for-job-worktree.test.ts`, and `__tests__/update-job-status-worktree.test.ts`.
