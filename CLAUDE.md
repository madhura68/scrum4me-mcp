# CLAUDE.md — scrum4me-mcp

MCP server that exposes the Scrum4Me dev-flow as native tools for Claude Code.

## Agent worktree-flow

`wait_for_job` creates an isolated git worktree per job so agent changes never touch the user's main checkout.

### How it works

1. On successful claim, `wait_for_job` calls `createWorktreeForJob`:
   - Worktree directory: `SCRUM4ME_AGENT_WORKTREE_DIR/<job-id>` (default: `~/.scrum4me-agent-worktrees/<job-id>`)
   - Branch: `feat/job-<last-8-chars-of-job-id>` (timestamp-suffixed if branch already exists)
   - Base: `origin/main`
2. Tool response includes `worktree_path` and `branch_name`.
3. **Work exclusively in `worktree_path`** — all file edits and commits go there.
4. On `update_job_status(done|failed)`, `removeWorktreeForJob` runs automatically:
   - `keepBranch=true` if `done` and a `branch` was reported (agent pushed)
   - `keepBranch=false` otherwise (branch deleted with worktree)

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

## Manual worktree cleanup

Run `cleanup_my_worktrees` (no arguments) to scan `~/.scrum4me-agent-worktrees/` and remove worktrees for jobs that are in a terminal state (DONE, FAILED, CANCELLED). Worktrees for active jobs (QUEUED, CLAIMED, RUNNING) are left untouched. Returns `{ removed, kept, skipped }`.

## Worker presence

Server-startup registers a `ClaudeWorker` record + starts a 5 s heartbeat; SIGTERM/SIGINT cleans it up. The Scrum4Me NavBar counts active workers via `last_seen_at < now() - 15s`.

| File | Purpose |
|---|---|
| `src/presence/worker.ts` | `registerWorker` (upsert + pg_notify worker_connected) + `unregisterWorker` |
| `src/presence/heartbeat.ts` | `startHeartbeat` — 5 s interval, stops on record-not-found |
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
