# scrum4me-mcp

MCP server for [Scrum4Me](https://github.com/madhura68/Scrum4Me). Exposes
the dev-flow as Model Context Protocol tools and prompts so Claude Code
(or any MCP-compatible client) can read context, update tasks, log
activity and create todos via native tool calls instead of curl.

## Tools

| Tool | Purpose | Demo write? |
|---|---|---|
| `health` | Service + DB ping | n/a |
| `list_products` | Active products the user owns or is a member of | n/a |
| `get_claude_context` | Bundled product + active sprint + next story (with tasks) + open todos | n/a |
| `update_task_status` | Set status to `todo`, `in_progress`, `review`, `done` | no |
| `update_task_plan` | Save/replace `implementation_plan` on a task | no |
| `log_implementation` | Append IMPLEMENTATION_PLAN to a story log | no |
| `log_test_result` | Append TEST_RESULT (PASSED/FAILED) | no |
| `log_commit` | Append COMMIT with hash and message | no |
| `create_todo` | Add a todo, optionally scoped to a product | no |
| `create_pbi` | Add a Product Backlog Item to a product (parent-scoped append) | no |
| `create_story` | Add a story under a PBI (status=OPEN, lands in product backlog) | no |
| `create_task` | Add a task under a story (status=TO_DO, inherits sprint_id) | no |
| `ask_user_question` | Post a question to the active user about a story; optional `wait_seconds` (max 600) polls for the answer | no |
| `get_question_answer` | Fetch the current status + answer of a previously-asked question | n/a |
| `list_open_questions` | List own open/answered questions, most recent first (max 50) | n/a |
| `cancel_question` | Cancel an own open question (asker-only) | no |
| `wait_for_job` | Block until a QUEUED ClaudeJob is available, claim it atomically, return full task context with frozen `plan_snapshot`, `worktree_path`, and `branch_name` | no |
| `update_job_status` | Report job transition to `running`, `done`, or `failed`; triggers SSE event to UI; cleans up worktree on terminal transitions | no |
| `verify_task_against_plan` | Compare frozen `plan_snapshot` against current plan + story logs + commits; returns per-AC ✓/✗/? heuristic and drift-score | yes (read-only) |
| `cleanup_my_worktrees` | Remove stale git worktrees left by crashed or cancelled agent runs | no |
| `check_queue_empty` | Synchronous, non-blocking count of active jobs (QUEUED/CLAIMED/RUNNING); optional `product_id` scope | no |
| `set_pbi_pr` | Write `pr_url` on a PBI and clear `pr_merged_at`. Idempotent: re-calling overwrites `pr_url` and resets `pr_merged_at` to null | no |
| `mark_pbi_pr_merged` | Set `pr_merged_at = now()` on a PBI. Requires `pr_url` to already be set. Idempotent: re-calling overwrites the timestamp | no |
| `verify_sprint_task` | SPRINT_IMPLEMENTATION-flow: compare a `SprintTaskExecution`'s frozen `plan_snapshot` against `git diff <base_sha>...HEAD`. Returns `verify_result` + `allowed_for_done`. For `task[1..N]` zonder base_sha vult de tool die in op basis van de head_sha van de vorige DONE-execution | yes (read-only) |
| `update_task_execution` | SPRINT_IMPLEMENTATION-flow: mutate `SprintTaskExecution.status` (PENDING/RUNNING/DONE/FAILED/SKIPPED). Token must own the parent SPRINT-job. Idempotent | no |
| `job_heartbeat` | Extend `claude_jobs.lease_until` by 5 min. For SPRINT-jobs: response includes `sprint_run_status` + `sprint_run_pause_reason` so the worker can break its task-loop on UI-side cancel/pause | no |
| `get_idea_chat_channel` | Fetch channel items (messages/logs/questions) for an idea, with composite cursor, `active_job`, and `question_states` (copilot idea-chat) | n/a |
| `send_idea_chat_message` | Post a user message to an idea's chat channel and enqueue (or coalesce) an IDEA_CHAT job | no |
| `update_idea_spec_md` | Write the spec document (ProductDoc SPECS + immutable revision) for an idea, set `Idea.spec_doc_id`, and dispatch the SPEC_REVIEW pipeline. Called as the last step of `IDEA_MAKE_SPEC`/`IDEA_REVISE_SPEC` jobs | no |
| `queue_push` | s4m-queue (stdio-only): send a `task`/`info`/`review_request` message to another agent or human (`<server>:<model>`); returns `message_id` as the reply handle | yes |
| `queue_wait_reply` | s4m-queue: fetch replies to your own `queue_push` requests, filtered by `in_reply_to`; `wait_seconds` `0` = non-blocking, default `300` blocks until the first reply (timeout is not an error) | yes |
| `queue_next` | s4m-queue: claim the next request addressed to you (FIFO); returns the message plus a `claim_token` to pass to `queue_done`/`queue_fail`. Execute within `meta.task.cwd` | yes |
| `queue_done` | s4m-queue: finish a claimed message — with `reply` it transactionally inserts the reply back to the requester and closes the request; needs the `claim_token` | yes |
| `queue_fail` | s4m-queue: mark a claimed message failed with an error text (stop-at-first-error); same ownership contract and `claim_token` as `queue_done` | yes |
| `queue_status` | s4m-queue: read-only, non-claiming — one message plus all replies to it (`in_reply_to = message_id`) | yes (read-only) |
| `queue_list` | s4m-queue: read-only, non-claiming — messages where your own address is sender or addressee; `direction: 'sent'` recovers outstanding request ids after a session crash | yes (read-only) |

Demo accounts may read but writes return `PERMISSION_DENIED`.

The `queue_*` tools are **stdio-only** (registered by `registerQueueTools`, never by
`src/http.ts`): they carry the caller's `S4M_SERVER`/`S4M_MODEL` identity and hold the
in-memory lease register for the claims they issue, which the central HTTP server does not
have. Claims do not survive an MCP restart — a self-healing lease-refresh renews live claims
and a stale-sweep requeues abandoned ones.

## Hierarchical ordering contract

`get_claude_context` is the canonical entry point for interactive Scrum4Me work. It returns
the active sprint and the next story with its tasks in parent-scoped `sort_order` (with
`created_at` and `id` as deterministic tie-breakers). Agents must use that returned order;
they must not derive work order from priority or from item codes.

**Priority** indicates how important an item is to the team. It is a label and optional
filter only; it never determines presentation order, job order, or execution order.

**`sort_order`** is the mutable ordering key within the direct parent: PBI within product,
story within PBI, and task within story. Reordering changes only `sort_order`; stable item
codes do not change and do not encode execution order.

The authoring tools enforce parent-scoped append semantics:

- `create_pbi`, `create_story`, and `create_task` accept no `sort_order` input. Each appends
  after the existing direct siblings inside a Serializable transaction; only Prisma `P2034`
  serialization conflicts are retried by that transaction layer, at most three times. A separate
  bounded outer retry reruns the complete create attempt only for the expected
  `(product_id, code)` `P2002`; unrelated unique violations surface immediately.
- `priority` remains required team-importance metadata on all three tools, but changing it does
  not move an item.

### Frozen sprint execution order

Sprint dispatch flattens the hierarchy as PBI `sort_order` → story `sort_order` → task
`sort_order`, with stable timestamp/id tie-breakers. Once the applicable freeze point below
has been reached, later backlog reordering does not change the run's order:

- A `SPRINT_BATCH` run creates one `SPRINT_IMPLEMENTATION` job. At claim time it freezes
  the flat task list into `SprintTaskExecution` rows; `SprintTaskExecution.order` is the
  canonical batch sequence returned in `task_executions[]`.
- A per-task sprint run creates one `TASK_IMPLEMENTATION` job per task and freezes the flat
  sequence in `claude_jobs.sprint_sequence`.

The per-task claim barrier serializes jobs within one SprintRun: a candidate cannot be
claimed while an earlier job in that run (smaller non-NULL `sprint_sequence`) is `QUEUED`,
`CLAIMED`, or `RUNNING`. Earlier terminal jobs (`DONE`, `FAILED`, `SKIPPED`, or `CANCELLED`) do not
block the next claim; failure/cancellation cascades remain responsible for any wider
run-level cancellation.

Legacy jobs with `sprint_sequence = NULL` remain claimable during migration. NULL does not
participate in the earlier-sibling comparison, so mixed legacy/new queues do not deadlock.
Deploy the nullable `sprint_sequence` column and its index before deploying MCP/worker code
that uses this claim barrier.

### verify_task_against_plan

Compares the immutable snapshot captured at claim time against the current state of the work. Useful at the end of a job to self-assess completeness.

**Input**

```json
{ "task_id": "cmolqlqvh0023q..." }
```

**Output**

```
# Verify task: Prisma-schema + migratie in Scrum4Me (cmolqlqvh...)

## Plan
- Snapshot: - Bewerk prisma/schema.prisma:...
- Current: - Bewerk prisma/schema.prisma:...
- Edited onderweg: **no**

## AC-checks (5/6 ✓ — drift-score 83%)
- ✓ Scrum4Me prisma/schema.prisma: nieuw veld plan_snapshot...
- ✓ Migratie aangemaakt en getest
- ✗ vendor/scrum4me submodule in scrum4me-mcp gebumpt

## Realisatie
- 1 log_implementation-entry
- commit `a3af2dd` — feat: add plan_snapshot field to ClaudeJob schema

---
⚠️ Heuristiek-rapport — handmatige PR-review blijft nodig
```

**Beperkingen heuristiek**

- Zoekt op sleutelwoorden (filenames, camelCase-identifiers, lange woorden) — geen semantisch begrip
- AC's die alleen over externe verificatie gaan (deployment, user-test) scoren altijd ✗ zonder extra log-entries
- Plan_snapshot is NULL voor jobs die zijn geclaimed vóór versie met snapshot-feature — rapport meldt "no baseline"
- Gebruik het rapport als startpunt, niet als definitief oordeel; PR-review blijft leidend

### set_pbi_pr

Links a Forgejo Pull Request to a PBI and clears any previous merge timestamp. Safe to call multiple times — idempotent.

**Input**

```json
{ "pbi_id": "cmoprewcf000q...", "pr_url": "https://git.jp-visser.nl/owner/repo/pulls/42" }
```

`pr_url` must be a valid Forgejo `/pulls/N` URL on a host in `FORGEJO_HOSTS`. GitHub URLs are rejected with `LEGACY_GITHUB_URL`.

**Output**

```json
{ "ok": true, "pbi_id": "cmoprewcf000q...", "pr_url": "https://git.jp-visser.nl/owner/repo/pulls/42" }
```

**Errors**

| Condition | Message |
|---|---|
| PBI not found or inaccessible | `PBI <id> not found or not accessible` |
| Demo account | `PERMISSION_DENIED: Demo accounts cannot perform write operations` |
| GitHub URL | `LEGACY_GITHUB_URL: …` |
| Invalid URL format | `Invalid Forgejo PR URL: …` |

### mark_pbi_pr_merged

Records that the linked PR has been merged by setting `pr_merged_at = now()`. Requires `set_pbi_pr` to have been called first. Idempotent: re-calling overwrites the timestamp.

**Input**

```json
{ "pbi_id": "cmoprewcf000q..." }
```

**Output**

```json
{
  "ok": true,
  "pbi_id": "cmoprewcf000q...",
  "pr_url": "https://git.jp-visser.nl/owner/repo/pulls/42",
  "pr_merged_at": "2026-05-03T12:00:00.000Z"
}
```

**Errors**

| Condition | Message |
|---|---|
| PBI not found or inaccessible | `PBI <id> not found or not accessible` |
| `pr_url` not set | `PBI <id> heeft geen gekoppelde PR` |
| Demo account | `PERMISSION_DENIED: Demo accounts cannot perform write operations` |

### check_queue_empty

Synchronous, non-blocking poll that returns how many ClaudeJobs are still active (`QUEUED`, `CLAIMED`, `RUNNING`). No blocking — returns immediately. Use it after the last `update_job_status('done')` in a batch to decide whether to stay in the loop or finalise.

**Input**

```json
{ "product_id": "cmoprewcf000q..." }   // optional — omit to aggregate all products
```

**Output — empty queue**

```json
{ "empty": true, "remaining": 0, "by_product": {} }
```

**Output — with product_id (non-empty)**

```json
{ "empty": false, "remaining": 2 }
```

**Output — without product_id (per-product split)**

```json
{
  "empty": false,
  "remaining": 3,
  "by_product": {
    "cmoprewcf000q...": 2,
    "cmohry5yj0001...": 1
  }
}
```

**Agent decision rule**

| `empty` | Action |
|---|---|
| `false` | Stay in loop — call `wait_for_job` again immediately |
| `true` | Finalise — push branch, open PR (if `auto_pr`), recap, exit |

**Errors**

| Condition | Message |
|---|---|
| `product_id` provided but not accessible | `Product <id> not found or not accessible` |
| Demo account | `PERMISSION_DENIED: Demo accounts cannot perform write operations` |

## Prompts

- `implement_next_story` — full workflow: fetch context, log plan, walk
  tasks, run tests, commit. Takes `product_id`.

## Setup

```bash
git clone --recurse-submodules https://github.com/madhura68/scrum4me-mcp.git
cd scrum4me-mcp
npm install              # postinstall runs prisma generate
cp .env.example .env     # fill in DATABASE_URL and SCRUM4ME_TOKEN
npm run dev              # starts the server via tsx (no build step required)
```

> **Note:** `dist` is not emitted and is unsupported — the package consumes
> `@shared` TypeScript at runtime via `tsx`. It is also **repo-only**: run it
> from a `git clone --recurse-submodules` (as above), never from an npm
> registry or `npm pack` tarball. The `tsx` runtime scripts (`dev`, `start`,
> `start:http`) need `src/`, `vendor/`, `scripts/` and `tsconfig.json`, which
> are intentionally kept out of the `files` allow-list — so the npm tarball is
> deliberately minimal and not a supported install path.

`SCRUM4ME_TOKEN` comes from Scrum4Me → **Instellingen → Tokens**
(`/settings/tokens`). The token is hashed with SHA-256 and looked up in
the same `api_tokens` table the REST API uses.

`DATABASE_URL` points to the same Postgres database Scrum4Me runs
against — typically the Neon connection string from the Scrum4Me
project's `.env`.

## Use with Claude Code

Add to `~/.claude/mcp_servers.json`:

```json
{
  "mcpServers": {
    "scrum4me": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/scrum4me-mcp/src/index.ts"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "SCRUM4ME_TOKEN": "...",
        "TSX_TSCONFIG_PATH": "/absolute/path/to/scrum4me-mcp/tsconfig.json"
      }
    }
  }
}
```

Restart Claude Code. The `scrum4me` tools and prompt show up under the
`scrum4me` namespace.

## Agent worktree-flow

When a job is claimed via `wait_for_job`, the MCP server automatically creates an isolated git worktree for the job under `~/.scrum4me-agent-worktrees/<job-id>/` with a dedicated branch `feat/job-<suffix>`. The tool response includes:

- `worktree_path` — absolute path to the worktree directory
- `branch_name` — the branch checked out in that worktree

**The agent must work exclusively inside `worktree_path`**. All file edits and commits belong there; the user's main checkout stays clean.

When `update_job_status` is called with `done` or `failed`, the worktree is automatically removed. If the agent reported a `branch` (indicating a push), the local branch is preserved on `done`; otherwise it is deleted together with the worktree directory.

### Required env vars

| Variable | Purpose |
|---|---|
| `SCRUM4ME_AGENT_WORKTREE_DIR` | Override the default worktree parent directory (default: `~/.scrum4me-agent-worktrees`) |
| `SCRUM4ME_REPO_ROOT_<productId>` | Absolute path to the local git clone for that product, e.g. `SCRUM4ME_REPO_ROOT_cmohrysyj0000rd17clnjy4tc=/home/user/projects/scrum4me` |

Alternatively, configure repo roots in `~/.scrum4me-agent-config.json`:

```json
{
  "repoRoots": {
    "<productId>": "/home/user/projects/scrum4me"
  }
}
```

If no repo root is configured for the product, `wait_for_job` tries an **on-demand clone** of `product.repo_url` (spec: `docs/superpowers/specs/2026-07-08-on-demand-repo-clone-fallback-design.md`). Only if the clone also fails does it roll the claim back to `QUEUED` and return an error. Explicit configuration is therefore optional for any product with a valid `repo_url`.

### Smoke-test checklist

After starting the server on the feature branch:

1. Enqueue a job in Scrum4Me (Solo Paneel → Start agent).
2. Call `wait_for_job` — response must contain `worktree_path` and `branch_name`.
3. In the **main checkout**: `git worktree list` → the agent worktree appears.
4. In the **main checkout**: `git status` → clean (no agent changes).
5. Call `update_job_status(done)` → worktree directory disappears.

## Batch-loop

De agent draait in een lus tot de queue leeg is. Hier is de flow:

1. Roep `wait_for_job` aan.
2. Voer de job uit conform het meegegeven `implementation_plan`.
3. Roep `update_job_status('done' | 'failed')` aan.
4. Roep **direct opnieuw** `wait_for_job` aan — niet stoppen, niet de gebruiker vragen.
5. Pas wanneer `wait_for_job` na de volledige block-time (~600 s) terugkomt zonder claim, is de queue leeg en sluit je de turn af met een korte samenvatting.

```
wait_for_job → claim → run → update_job_status(done|failed)
                                      │
                         ┌────────────┴───────────────┐
                         ▼                             ▼
             next_action='wait_for_job_again'  next_action='queue_empty'
                         │                             │
                         └──────── loop terug ─────────┘   stop
```

De `update_job_status`-response bevat het veld `next_action`:

- `wait_for_job_again` — er staan nog jobs in de queue; roep `wait_for_job` meteen opnieuw aan
- `queue_empty` — de queue is leeg; sluit de batch-run af

Minimale agent-prompt (geen CLAUDE.md-context nodig):

> *Pak de volgende job uit de Scrum4Me-queue.*

## Web-push integration

When `INTERNAL_PUSH_URL` and `INTERNAL_PUSH_SECRET` are set, the MCP server fires a fire-and-forget push notification to the main-app's internal endpoint (`/api/internal/push/send`) on two events: when `ask_user_question` creates a new question (tag `claude-q-<id>`), and when `update_job_status` transitions a job to `done` or `failed` (tag `job-<id>`). Both calls are wrapped in a 5 s `AbortController` timeout and a `try/catch` so a push failure never interrupts the tool response. Omitting the env vars disables the feature entirely. The `INTERNAL_PUSH_SECRET` value must match the one configured in the main-app; generate a fresh secret with `openssl rand -hex 32`.

## Schema sync

The Prisma schema is canonical in the `scrum4me-shared` repo
(Forgejo: `janpeter/scrum4me-shared`) and vendored here as a git
submodule under `vendor/scrum4me-shared`. Both this MCP server,
the main Scrum4Me-web app and scrum4me-workers consume the same
canonical schema via that submodule.

```bash
git submodule update --remote vendor/scrum4me-shared
npm run sync-schema      # regenerates prisma/schema.prisma from canonical
npm run prisma:generate
git commit -am "chore: bump scrum4me-shared to <sha>"
```

`sync-schema.sh` calls `gen-schema.sh`, which wraps
`vendor/scrum4me-shared/scripts/gen-consumer-schema.sh` and strips
`url=` / `directUrl=` lines from the datasource block (Prisma 7 uses
`prisma.config.ts` for connection URLs, so they would otherwise conflict).
`postinstall` and `prebuild` invoke this pipeline automatically.

## Development

```bash
npm run dev              # tsx src/index.ts (stdio)
npm run typecheck
npm run build            # tsc --noEmit (type-check only; dist is not emitted)
```

Quick local smoke-test with the official MCP inspector:

```bash
npx @modelcontextprotocol/inspector npx tsx src/index.ts
```

## Risks

- **Schema drift** — Prisma Client and live DB can diverge if the
  upstream schema changes without a sync. Re-run `sync-schema` and
  `prisma:generate` whenever Scrum4Me ships a migration.
- **Token in plain text** — `mcp_servers.json` stores `SCRUM4ME_TOKEN`
  unencrypted. Use `${env:SCRUM4ME_TOKEN}` and a real keychain for
  shared machines.
- **Concurrent updates** — no optimistic locking. Same caveat as the
  REST API.
- **Production database** — verify against a preview database before
  running against prod. The token check enforces user scope but does
  not gate reads of unrelated products you happen to be a member of.

## Worktrees

Scrum4Me-mcp uses git worktrees rooted at `~/.scrum4me-agent-worktrees/` (override via `SCRUM4ME_AGENT_WORKTREE_DIR`).

### Two kinds of worktrees

- **Per-job task-worktrees** (`<jobId>/`) — one per `TASK_IMPLEMENTATION` job. Created at claim, cleaned up on `DONE`/`FAILED`/`CANCELLED` via `cleanup_my_worktrees`.
- **Persistent product-worktrees** (`_products/<productId>/`) — one per product with `repo_url`, used by `IDEA_GRILL` and `IDEA_MAKE_PLAN`. **Detached HEAD on `origin/main`**, hard-reset at every job start. `.scratch/` holds throw-away work and is wiped on each claim.

### Concurrency: file-locks

Product-worktrees are serialised via `proper-lockfile` on `_products/<productId>.lock`. Two parallel idea-jobs on the same product wait for each other. For multi-product idea-jobs, locks are acquired in alphabetical order to prevent deadlocks.

### Single-host invariant

`proper-lockfile` only works when all MCP-server processes run on the same host. Migrate to Postgres `pg_advisory_lock` when:
- multiple MCP instances on different machines serve workers, or
- the worktree directory is shared over NFS/CIFS.

Migration path: replace `acquireFileLock` in `src/git/file-lock.ts` with a `pg_try_advisory_lock(hashtext(path)::bigint)` wrapper via the existing Prisma connection. The API stays identical.

### Manual cleanup

`cleanup_my_worktrees` skips `_products/` and `*.lock` automatically. To clean up a product-worktree manually (after archive or repo-rename):

```bash
git worktree remove --force ~/.scrum4me-agent-worktrees/_products/<productId>
rm ~/.scrum4me-agent-worktrees/_products/<productId>.lock  # if still present
```
