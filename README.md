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
| `create_issue` | Register a problem for a product or system as ISS-n (server-side). A stable `fingerprint` (`<host>:<component>:<core>`) increments the existing open issue on a recurrence instead of duplicating it, and reopens a `FIXED`/`CANNOT_REPRODUCE` issue as a regression | no |
| `update_issue` | Append research or resolution prose (timestamped, attributed to `authored_by` or the token user), change status/severity, or link a PBI or idea. Closing requires a resolution **code** in `resolution` (`fixed`, `wont_fix`, `duplicate`, `cannot_reproduce`, `invalid`) alongside `status=closed` — the prose explanation goes in `append_resolution`, and both may be sent in one call. A closed issue can only reopen to `investigating` | no |
| `list_issues` | List a product's or system's issues (max 50, most-recently-seen first); closed issues are excluded unless `include_closed` is set | n/a |
| `get_issue` | Fetch one issue with its research, resolution, links, and the last 50 log entries | n/a |
| `dispatch_task` | IDEA-213 automatic dispatch: hand a task to the central dispatch service, which picks a job worker or a registered host agent and delivers one final answer to `reply_to`. Without `task_id` this is a free task; an explicit `task_id` — and nothing else, `work_item` included — selects `task_implementation`. Needs `S4M_DISPATCH_URL` plus the caller's own bearer; there is no service identity to fall back on | no |
| `dispatch_review` | IDEA-213 automatic dispatch: review of documents pinned by revision/commit and sha256, always read-only, always answered with exactly one verdict. An unpinned reference is refused before the request leaves the host | no |
| `get_dispatch` | IDEA-213: read-only state, route, reason and delivery of one dispatch request you may see | n/a |
| `cancel_dispatch` | IDEA-213: cancel a dispatch request under the `expected_version` you last read. Before the first claim it completes at once; afterwards it requests a stop and the request finishes once termination is proven | no |
| `queue_push` | s4m-queue (stdio-only): send a `task`/`info`/`review_request` message to another agent or human (`<server>:<model>`, or `scrum4us-job:<jobid>` for the M30 job namespace); returns `message_id` as the reply handle, plus an optional `presence` block telling the sender whether the destination address is listening, busy or away (best-effort: omitted on any read error and for job-namespace destinations). Optional `sprint_id`/`story_id`/`task_id` link the message to a Scrum4Me work item — the tool derives the full hierarchy via the story and stores it canonically as `meta.work_item` (inconsistent or unknown ids are rejected). Pinned review material travels as `meta.review_documents` (a sibling of `meta.task`, `version: 1` plus `items` of `source: 'product_doc' \| 'git'`); the block is schema-validated before insert and a `review_documents` nested inside `meta.task` is rejected instead of silently stripped | yes |
| `queue_wait_reply` | s4m-queue: fetch replies to your own `queue_push` requests, filtered by `in_reply_to`; `wait_seconds` `0` = non-blocking, default `300` blocks until the first reply (timeout is not an error) | yes |
| `queue_next` | s4m-queue: claim the next request addressed to you (FIFO); returns the message plus a `claim_token` to pass to `queue_done`/`queue_fail`. Execute within `meta.task.cwd` | yes |
| `queue_done` | s4m-queue: finish a claimed message — with `reply` it transactionally inserts the reply back to the requester and closes the request; needs the `claim_token` | yes |
| `queue_fail` | s4m-queue: mark a claimed message failed with an error text (stop-at-first-error); same ownership contract and `claim_token` as `queue_done` | yes |
| `queue_status` | s4m-queue: read-only, non-claiming — one message plus all replies to it (`in_reply_to = message_id`) | yes (read-only) |
| `queue_list` | s4m-queue: read-only, non-claiming — messages where your own address is sender or addressee; `direction: 'sent'` recovers outstanding request ids after a session crash; archived messages are hidden unless `include_archived: true` | yes (read-only) |
| `queue_find_by_work_item` | s4m-queue: read-only, non-claiming — find messages linked to a Scrum4Me work item via `meta.work_item`, across all addresses (not scoped to your own); pass at least one of `sprint_id`/`story_id`/`task_id` (multiple ids filter as AND), product-guarded, capped at 100 with `truncated`; rows past `S4M_RETENTION_DAYS` (default 60) are archived and not searched | yes (read-only) |
| `queue_presence` | s4m-queue: read-only, idempotent — presence per queue address: status (`weg`/`bezig`/`beschikbaar`/`onbemand`), watcher heartbeat age, session signals and open claims; optional `{server, model}` filter, where a full filter without a row yields one synthetic `weg` entry. Presence is cached information, **never a gate**: a stale or missing row only means nobody proved liveness recently — keep pushing and keep the claim watchdog | yes (read-only) |
| `queue_archive` | s4m-queue: archive a terminal message plus its full reply subtree (sets `archived_at`); refuses when any row in the subtree is not terminal; row-level idempotent | yes |
| `queue_unarchive` | s4m-queue: clear `archived_at` on a message plus its full reply subtree, also when the root itself is active (mixed trees); row-level idempotent | yes |
| `queue_register_consumer` | s4m-queue (marked/PPE lane): register one fenced lane consumer generation and atomically acknowledge readiness under the run/orchestrator/consumer generation fences | yes |
| `queue_claim_marked` | s4m-queue (marked/PPE lane): claim one complete marked request FIFO with all run/orchestrator/consumer fences; returns the marked lease token | yes |
| `queue_renew_marked` | s4m-queue (marked/PPE lane): renew only the exact opaque-token marked lease under all generation fences | yes |
| `queue_cancel_marked` | s4m-queue (marked/PPE lane): cancel a pending request without a token, or a claimed request with the exact marked lease token | yes |

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

## Stdio release canary

The stdio process runs in one of two modes, selected by `SCRUM4ME_CANARY_MODE`:

| Value | Mode | Behaviour |
|---|---|---|
| unset / empty | `runtime` | normal worker: full toolset, auth, presence, heartbeat, queue maintenance |
| exactly `1` | `canary` | full tool **metadata** (same names, input schemas and annotations as runtime, incl. worktree + queue tools), but every handler throws `CANARY_MODE_TOOL_CALL_FORBIDDEN`; no prompts/resources; **never** touches auth, Prisma, presence, heartbeat, queue maintenance, Git or the network |

Any other non-empty value is fatal (`INVALID_CANARY_MODE`) — the mode is never
silently downgraded. Both modes construct through the same
`createStdioServer()` in `src/stdio-server.ts`, so the canary and runtime
surfaces cannot drift; the runtime lifecycle is the only place credentials and
side effects run, and it is injectable for testing.

```bash
npm run canary:stdio     # credentialless: needs no DATABASE_URL or SCRUM4ME_TOKEN
```

The script (`scripts/stdio-canary.ts`) speaks only `initialize` + `tools/list`
to a canary server over an in-memory transport, hashes the canonical tool
surface and prints exactly one `scrum4me-mcp-canary/v1` result
(`{ server_version, release_commit, protocol_version, tool_count,
tool_surface_sha256, ok }`). It exits non-zero on any other protocol traffic or
failure. In a Git checkout the commit comes from the explicit
`SCRUM4ME_RELEASE_COMMIT` binding or Git `HEAD`. In a `.git`-less release it
comes only from `release/package-identity.v1.json`; a missing, malformed or
contradictory identity fails closed instead of emitting `release_commit:
"unknown"`. The `.git`-less canary also compares its freshly computed canonical
tool-surface hash with the identity and rejects any mismatch. Forgejo CI runs
the canary on exact Node 24.19.0.

## Reproducible release attestation

There are deliberately two metadata contracts:

- `npm run release:metadata -- --candidate <reviewed-head-sha> --output
  .release/scrum4me-mcp-candidate.v1.json` emits
  `scrum4me-mcp-candidate/v1`. It is PR-head evidence only: it records
  `reviewed_head_sha` and its tree, never calls that SHA a merge, is never
  published as a release and is not accepted by release consumers.
- `npm run release:metadata -- --output
  .release/scrum4me-mcp-build.v1.json` emits the existing
  `scrum4me-mcp-build/v1` contract for one **exact two-parent `origin/main`
  merge commit**. Only push CI on `main` may create and publish this final
  metadata.

Both collectors are fail-closed over exact Node 24.19.0, the complete clean
checkout, every initialized recursive submodule and the committed generated
schema. `collectReleaseMetadata` retains injected Git/filesystem/gate
dependencies so rejection paths remain deterministic and unit-tested
(`__tests__/release-metadata.test.ts`). They reject when:

| Check | Error |
|---|---|
| HEAD is not the exact two-parent `refs/remotes/origin/main` merge | `RELEASE_COMMIT_NOT_ORIGIN_MAIN_MERGE` |
| Node is not the pinned `v24.19.0` | `NODE_VERSION_MISMATCH` |
| A recursive submodule is uninitialised or dirty | `SUBMODULE_NOT_CLEAN` |
| A recursive submodule worktree contains tracked or untracked changes | `SUBMODULE_WORKTREE_NOT_CLEAN` |
| The generated Prisma schema is uncommitted | `GENERATED_SCHEMA_NOT_COMMITTED` |
| Any other tracked or untracked checkout input is dirty | `RELEASE_CHECKOUT_NOT_CLEAN` |
| A required gate is absent / has an unknown key / a malformed digest | `GATE_EVIDENCE_MISSING` · `GATE_EVIDENCE_UNKNOWN_KEY` · `GATE_EVIDENCE_MALFORMED` |
| A content digest is not bound by its gate | `LOCK_HASH_MISMATCH` · `SCHEMA_HASH_MISMATCH` · `TOOL_SURFACE_HASH_MISMATCH` |

Each of the four gates (`schema`, `typecheck`, `tests`, `stdio_canary`) records
only a command identifier, a `passed` status and an evidence digest — never
stdout, env or secrets. Three of those digests **bind** a content artifact:
`schema` ↔ `prisma/schema.prisma`, `typecheck` ↔ `package-lock.json` (the exact
dependency closure it ran against), and `stdio_canary` ↔ the complete canary
envelope. The metadata's `tool_surface_sha256` is copied unchanged from the
validated inner `tool_surface_sha256`; it is never the outer-envelope digest.
`tests` is an opaque run digest.

### Closed release package

```bash
npm run release:package
env -i HOME="$HOME" PATH="$PATH" SCRUM4ME_CANARY_MODE=1 npm run canary:packaged
npm run release:verify-package
```

`release:package` stages the tracked runtime source under
`.release/package/`, writes `release/content-manifest.v1.json` and the single
authoritative `release/package-identity.v1.json`, verifies them, then creates
`.release/artifacts/scrum4me-mcp-<commit>.tar.gz`. The identity binds repository,
commit, tree OID, the canonical inner tool-surface hash and the content-manifest
digest. The manifest binds every packaged byte plus the non-circular identity
fields. `release:verify-package` extracts the actual archive and verifies that
closed tree, rejecting missing, extra or changed files. Release inputs and the
release tree are directories/regular files only: a selected tracked symlink or
special file fails before copying. Archives are emitted as strict POSIX ustar;
before any extraction, a dependency-free parser verifies gzip decoding, ustar
magic/version, headers, checksums, bounds and end markers, and allows only safe
relative directory/regular-file members. Traversal, links, devices/FIFOs and
PAX/GNU/other extensions fail closed. All generated output remains ignored
under `.release/`.

PR CI checks out the exact PR head, runs schema generation, both typechecks,
the full tests, stdio canary, package build, `.git`-less packaged canary,
package verification and candidate metadata. It never uploads the package or
publishes final metadata. Push CI first validates Forgejo's pre-push
`${{ github.event.before }}` SHA, proves it equals merge parent 1, proves
`GITHUB_SHA == HEAD == origin/main`, requires exactly two parents and
merge-tree equality with parent 2. Only then does it repeat every gate, create
final metadata and publish the archive and final JSON at the fixed Forgejo
generic-package version keyed by that merge SHA. Separate write and read-only
credentials are used for publication and download-back; both downloaded files
must be byte-identical and SHA-256 is recorded locally. No HTML endpoint is
scraped and credential values are never printed.

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
> deliberately minimal and not a supported install path. The separately
> attested Forgejo generic-package archive described above is the supported
> `.git`-less release artifact; after extraction, install its locked
> dependencies with `npm ci` before starting it.

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

## Queue dispatch service (IDEA-213)

`npm run start:dispatch` runs the central dispatch service (`src/dispatch/server.ts`). Importing
that module starts nothing: the listener, the tick timer and both connection pools come into
existence in `startDispatchServer` and only there. The feature ships **off** — without
`DISPATCH_ENABLED=1` and an allowlisted product nothing is selected, and without credential keys
and a start permit the executor and attempt routes are not there at all (404, not 403).

### Environment

Every variable the dispatch code actually reads, with who provisions the value and which process
reads it. Values below are shapes and examples only; no real value belongs in this repository.

| Variable | Read by | Provisioned by | Meaning |
|---|---|---|---|
| `DISPATCH_DATABASE_URL` | dispatch service | DB operator (role `scrum4me_dispatch`) | Required. Dispatch database as the limited contract role — never the migration owner. `postgres://…` |
| `DISPATCH_QUEUE_DATABASE_URL` | dispatch service | DB operator (role `s4m_dispatch_projector`) | Queue database for delivery and queue maintenance. Absent → no projection, no repair, no retention; execution keeps working |
| `DISPATCH_ENABLED` | dispatch service | release operator | `1` enables intake and selection. Anything else keeps the service read/cancel/recover only. Set **last** in a rollout |
| `DISPATCH_PRODUCT_ALLOWLIST` | dispatch service | release operator | Comma-separated product ids that may dispatch. Empty means none |
| `DISPATCH_HOST` | dispatch service | host operator | Listen address, default `127.0.0.1`. TLS ingress terminates in front of it |
| `DISPATCH_PORT` | dispatch service | host operator | Listen port, default `4319` |
| `DISPATCH_TICK_INTERVAL_MS` | dispatch service | host operator | Selection tick, default `5000` |
| `DISPATCH_MAINTENANCE_INTERVAL_MS` | dispatch service | host operator | Queue repair/retention interval, default `900000`. Not the selection tick |
| `DISPATCH_RETENTION_DAYS` | dispatch service | release operator | Opt-in. Whole days after which a terminal, acknowledged, non-recovered thread is archived and removed from the hot queue. Unset → no retention pass runs |
| `DISPATCH_WORKERS_ASSERTION_KEY` | dispatch service **and** scrum4me-workers | secret owner (shared with workers) | Shared secret, ≥32 bytes UTF-8, byte-identical on both sides |
| `DISPATCH_WEB_ASSERTION_KEY` | dispatch service **and** Scrum4Me web | secret owner (shared with the web app) | Shared secret, ≥32 bytes UTF-8, byte-identical on both sides. The web issuer may read and cancel only |
| `DISPATCH_CREDENTIAL_KEYS` | dispatch service | secret owner (dispatch only) | Attempt/session credential keys as `<version>:<base64url>`, comma separated, each ≥32 bytes: `1:<base64url>,2:<base64url>`. Never leaves the service |
| `DISPATCH_CREDENTIAL_KEY_VERSION` | dispatch service | secret owner (dispatch only) | The version new credentials are minted under; must be present in `DISPATCH_CREDENTIAL_KEYS` |
| `DISPATCH_START_PERMIT_PRIVATE_KEY` | dispatch service | secret owner (dispatch only) | Ed25519 private key, PKCS8 PEM (literal `\n` accepted). Without it there are no executor/attempt routes |
| `DISPATCH_AGENT_OUTPUT_KEY` | dispatch service | secret owner (dispatch only) | Opt-in. base64url HMAC key, ≥32 bytes, for the bounded attempt-scoped capability the child holds. Absent → no `/agent/*` routes exist and no capability is ever minted. It is not a bearer and grants no MCP tool, no database and no forge access |
| `DISPATCH_GIT_HOST` | dispatch service | release operator | The single allowed forge host, e.g. `git.example.test`. Publication and pinned source fetches accept no other host |
| `DISPATCH_WORKSPACE_ROOT` | dispatch service | host operator | Writable root the repository source producer checks a pinned base out in, mode `0700`, one directory per request and removed again when that request's base has been bundled. Absent → no producer, and intake **refuses** every request that pins a repository with `404` instead of accepting one the first tick would fail |
| `DISPATCH_GIT_PROTOCOLS` | dispatch service | release operator | Comma-separated URL schemes the producer may fetch a pinned base over, default `https`. `https` also requires `DISPATCH_GIT_HOST`, and only registered `Product.repo_url` values are ever reached. `file` exists for an isolated local fixture repository on a disposable cluster and belongs on no shared host; publication stays `https` regardless |
| `DISPATCH_GIT_TOKEN` | dispatch service | forge credential owner | Forge token for pinned fetches, push and pull-request creation. Central publisher credential: it is never handed to a supervisor, a runtime image or a model |
| `DISPATCH_PUBLICATION_ROOT` | dispatch service | host operator | Writable working root for publication. With `DISPATCH_GIT_HOST` absent, delivery stays an artifact and nothing is pushed |
| `DISPATCH_BASE_BRANCH` | dispatch service | release operator | Single default base branch, default `main`. It is not per product |
| `PATH` | dispatch service | host operator | Inherited by the isolated `git` subprocesses; `git` must be on it. Nothing else of the service environment is passed to them |
| `S4M_DISPATCH_URL` | MCP dispatch tools, s4m-queue CLI, workers, web | host operator | Base URL of the service, e.g. `https://dispatch.example.test/dispatch/v1` |
| `SCRUM4ME_TOKEN` | MCP tools in stdio mode | the calling user | The caller's own bearer. There is deliberately no service identity to fall back on: in HTTP mode the request's own bearer is used |

Rotation: add the new key to `DISPATCH_CREDENTIAL_KEYS` and point
`DISPATCH_CREDENTIAL_KEY_VERSION` at it. **Old versions stay in the list until every attempt that
was issued under them has been retired**, because a running incarnation keeps verifying against
its own key version. Removing a version early invalidates live credentials silently and frees
slots that are still occupied; retire or recover those attempts first.

### Readiness

`GET /healthz` (outside `/dispatch/v1`, unauthenticated, side-effect free, cached for one second):

```console
$ curl -s http://127.0.0.1:4319/healthz
{"version":"1.1.0","protocol":"dispatch-v1","schema_ready":true,"role_ready":true}
```

Four facts and nothing else — no credentials, no DSN, no product or request data. `schema_ready`
means the running role sees the whole durable dispatch schema; `role_ready` means the connection
is the contract role `scrum4me_dispatch` and carries no SUPERUSER, BYPASSRLS, CREATEROLE or
CREATEDB flag, the same thing the consumer preflight proves from the other side. It answers
**200 whatever the answer is**, like `/health` in `src/http.ts`: an unreachable database reads
`"schema_ready":false,"role_ready":false` and never carries the connection error. A health check
must therefore test the two booleans, not the status code.

### Operator entries

Both take the caller's own bearer and are recorded under `action_id` in `queue_dispatch_events`,
so a repeat of the same action returns the first receipt instead of acting twice.

*Queue restore* — after restoring the queue database to an earlier point, hand the newest outbox
snapshot of every request delivered since that point back to the projector:

```console
$ curl -sX POST "$S4M_DISPATCH_URL/outbox/republish" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"action_id":"<fresh-uuid>","published_after":"<restore-point-ISO-8601>"}'
```

Global `ADMIN` only (never the web issuer), at most 500 requests per call — repeat with a **new**
`action_id` until `requests` is `0`. It clears a publication marker and nothing else; the
projection stays monotone and version-guarded, so a redelivery never rewrites an answer a reader
already handled.

*Publication that reconciliation can never decide* — a `SENT` publication whose push may or may
not have happened stays `UNKNOWN` and holds its request's reservation. The audited way out sends
nothing and can only close the operation as failed:

```console
$ curl -sX POST "$S4M_DISPATCH_URL/publications/<operation-id>/resolve" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"action_id":"<fresh-uuid>","resolution":{"version":1,"operationId":"<operation-id>",
         "observer":"<who looked>","source":"<how it was observed>",
         "statement":"<what was seen, at least 20 characters>",
         "observedAt":"<ISO-8601 within the operation window>",
         "remoteHead":null,"pullRequest":"not_applicable"}}'
```

Same authority as recovery on that request. A remote that already carries our head is a
confirmation for reconciliation to find, not something to attest: that is refused. The route
exists only where the deployment configured a publisher.

Queue repair and retention need no operator command: they are stages of the service's own tick,
bounded, caught per unit and run last, on `DISPATCH_MAINTENANCE_INTERVAL_MS`. Repair hands a
reply back that a crashed reader claimed and never acknowledged (after the CLI's four-hour inbox
lease); retention only runs when `DISPATCH_RETENTION_DAYS` is set.

### Supervisor-facing and child routes

All under `/dispatch/v1`. The first group is the supervisor's; the last is the child's and is the
only place in the protocol where a caller has no dispatch identity at all.

| Method/path | Authority | Body / headers | Answer |
|---|---|---|---|
| `POST /attempts/claim` · `/start` · `/reconcile` · `/heartbeat` | supervisor bearer + session credential or `AttemptProof` | JSON | claim receipt or `null`; start permit; lease |
| `POST /attempts/stop-evidence` | supervisor bearer + `AttemptProof` | `{proof,evidence}` **or** `{proof,observation}` | `{receipt_id,evidence}`. It never frees capacity on its own |
| `POST /attempts/result` | supervisor bearer + `AttemptProof` | `{proof,result}` | `{status:'accepted'\|'late', result_id, reason, canonical_result?}` |
| `PUT /attempts/artifacts/:key` | supervisor bearer + `X-Dispatch-Attempt-Proof` | raw bytes + `X-Content-SHA256` | `{artifact_id,sha256,byte_size}`. Refused once the attempt is revoked |
| `PUT /attempts/collected/:key` | **original supervisor** bearer + `X-Dispatch-Start-Binding` | raw bytes + `X-Content-SHA256`; `:key` ∈ `report`\|`checks`\|`code` | same receipt. The post-stop path: valid only after this supervisor's own stop was accepted |
| `POST /attempts/recovery/lookup` · `/stop` · `/result` | **original supervisor** bearer, bound to the historical binding | `{key}` / `{binding,evidence}` / `{binding,result}` | `RecoveryState`; `{receipt_id}`; `RecoveryState`. No execution authority anywhere on these three |
| `GET /agent/sources/:key` | child capability only | `X-Dispatch-Agent-Token`, `X-Dispatch-Attempt-Id` | exact source bytes + `X-Content-SHA256` |
| `PUT /agent/outputs/:key` | child capability only | as above + raw bytes and `X-Content-SHA256` | `{artifact_id,sha256,byte_size}` |

`canonical_result` is what the service actually holds. `acceptDispatchResult` may rewrite a
submitted `succeeded` to `failed` or `cancelled`, so a supervisor must complete on the canonical
result and never on the one it sent. It is absent exactly where no canonical result exists yet —
an unresolved publication answers `{status:'late', result_id:null, reason:'publication_unknown'}`.
A replay of the same result answers with the same `result_id` and the same canonical bytes.

The child's capability is minted by the service at `POST /attempts/start` and returned beside the
permit as `agent_token`, so the supervisor can place it in the container before it starts. It is
attempt-scoped, expires at `min(now+5min, the attempt deadline)`, and its operation set is derived
from the request: `stage_code` only for a non-review `repo_write` request. The two `/agent` routes
refuse a bearer or a workers assertion presented alongside it, because that would be a second and
far wider authority; the gateway re-derives full database authority on every single call.

### Known limitations

Measured on this build; none of these is scheduled work in IP-14.

- **Nothing places `agent_token` in a child yet.** The service mints and accepts the capability,
  but the scrum4me-docker supervisor does not pass it into the container environment, so no child
  has used `/agent/*` outside tests. The read-only artifact profile does not need it: the child
  writes its `result.json` to `/output` and the supervisor stages it through
  `PUT /attempts/collected/:key` after the stop.
- **No NOTIFY producer.** The service relies on its tick alone. A queue-side `NOTIFY` on dispatch
  state changes was part of the plan and is not implemented; delivery latency is therefore bounded
  by `DISPATCH_TICK_INTERVAL_MS`.
- **`GET /artifacts/:id` ignores the bound-attempt proof.** Only the requester or a product
  administrator can read an artifact; a supervisor holding a valid attempt proof cannot.
- `queue_dispatch_reply_addresses` must be populated through `POST /reply-addresses` before anyone
  can submit, and the workers principal needs a global `ADMIN` role.
- `createSlot` writes version `'1'` unconditionally.
- The generated-contract check of s4m-queue
  (`node scripts/generate-dispatch-contract.mjs --check --source <shared checkout>`) runs in no CI
  workflow.
- **Practical acceptance has not run.** Nothing in this repository has ever been called against a
  live dispatch service; every acceptance gate is unmet until it is separately observed.

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
