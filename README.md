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
| `wait_for_job` | Block until a QUEUED ClaudeJob is available, claim it atomically, return full task context with frozen `plan_snapshot` | no |
| `update_job_status` | Report job transition to `running`, `done`, or `failed`; triggers SSE event to UI | no |
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
