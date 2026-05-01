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
| `create_pbi` | Add a Product Backlog Item to a product (auto sort_order) | no |
| `create_story` | Add a story under a PBI (status=OPEN, lands in product backlog) | no |
| `create_task` | Add a task under a story (status=TO_DO, inherits sprint_id) | no |
| `ask_user_question` | Post a question to the active user about a story; optional `wait_seconds` (max 600) polls for the answer | no |
| `get_question_answer` | Fetch the current status + answer of a previously-asked question | n/a |
| `list_open_questions` | List own open/answered questions, most recent first (max 50) | n/a |
| `cancel_question` | Cancel an own open question (asker-only) | no |
| `wait_for_job` | Block until a QUEUED ClaudeJob is available, claim it atomically, return full task context with frozen `plan_snapshot`, `worktree_path`, and `branch_name` | no |
| `update_job_status` | Report job transition to `running`, `done`, or `failed`; triggers SSE event to UI; cleans up worktree on terminal transitions | no |
| `verify_task_against_plan` | Compare frozen `plan_snapshot` against current plan + story logs + commits; returns per-AC ✓/✗/? heuristic and drift-score | yes (read-only) |

Demo accounts may read but writes return `PERMISSION_DENIED`.

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

## Prompts

- `implement_next_story` — full workflow: fetch context, log plan, walk
  tasks, run tests, commit. Takes `product_id`.

## Setup

```bash
git clone --recurse-submodules https://github.com/madhura68/scrum4me-mcp.git
cd scrum4me-mcp
npm install              # postinstall runs prisma generate
cp .env.example .env     # fill in DATABASE_URL and SCRUM4ME_TOKEN
npm run build
npm link                 # exposes the `scrum4me-mcp` bin globally
```

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
      "command": "scrum4me-mcp",
      "env": {
        "DATABASE_URL": "postgresql://...",
        "SCRUM4ME_TOKEN": "..."
      }
    }
  }
}
```

Restart Claude Code. The 9 tools and 1 prompt show up under the
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

If no repo root is configured for the product, `wait_for_job` rolls back the claim to `QUEUED` and returns an error.

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

## Schema sync

The Prisma schema is the source of truth in the upstream Scrum4Me
repo. It is vendored as a git submodule under `vendor/scrum4me`:

```bash
git submodule update --remote vendor/scrum4me
npm run sync-schema      # copies prisma/schema.prisma, strips erd block
npm run prisma:generate
git commit -am "chore: sync schema with scrum4me@<sha>"
```

`sync-schema.sh` strips the upstream `generator erd` block so this
package does not depend on `prisma-erd-generator`.

## Development

```bash
npm run dev              # tsx src/index.ts (stdio)
npm run typecheck
npm run build
```

Quick local smoke-test with the official MCP inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
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
