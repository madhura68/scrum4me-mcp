# CLAUDE.md / AGENTS.md — scrum4me-mcp

## Scrum4Me-product
- **Naam:** scrum4me-mcp
- **product_id:** `cmopqt0yj000004jp7lr7mn8e`
- **Definition of Done:** vlekkeloze integratie met scrum4me

Volgt de globale Scrum4Me-methodiek (`~/.claude/rules/scrum4me-methodiek.md` voor Claude; de "Scrum4Me-methodiek"-sectie in `~/.codex/AGENTS.md` voor Codex). Niet-triviaal werk: plan → Sprint/PBI/Story/Taak via de `scrum4me` MCP → `update_task_status` per laag → docs in de DB.

MCP server that exposes the Scrum4Me dev-flow as native tools for Claude Code and Codex.

## Hierarchical ordering contract

`get_claude_context` is the canonical starting point for interactive Scrum4Me work. Its
next story and tasks are ordered by parent-scoped `sort_order` (then `created_at` and `id`
as deterministic tie-breakers). Follow that order; never infer work order from priority or
from item codes.

**Priority** indicates how important an item is to the team. It is a label and optional
filter only; it never determines presentation order, job order, or execution order.

**`sort_order`** is the mutable ordering key within the direct parent: PBI within product,
story within PBI, and task within story. Reordering changes only `sort_order`; stable item
codes do not change and do not encode execution order.

MCP authoring is parent-scoped append-only: `create_pbi`, `create_story`, and `create_task`
accept no `sort_order` and append within their direct parent. The sibling max-read and create
share one Serializable transaction; only a serialization failure is retried, at most three times.
An outer bounded retry reruns that complete transaction only for the tool's expected
`(product_id, code)` unique violation; unrelated unique violations are not retried.
All three still require `priority` as team-importance metadata, but changing priority never
moves an item.

Both loops back off with full jitter between attempts (`src/lib/retry-backoff.ts`). Without it
the losers of a contended create retry in the same tick and re-collide: measured on Postgres
17.9, six concurrent `create_pbi` calls left 16 of 60 handlers failing after exhausting all
four attempts, versus 1 of 60 with jitter.

### Matching Prisma errors: use the SQLSTATE, not `meta.target`

Under Prisma 7 + `@prisma/adapter-pg` the engine-era error fields are gone, and matching on
them fails **silently** — a retry loop that recognises nothing degrades to a single attempt
and still looks correct in review:

| Postgres | Arrives as | Where the detail lives |
|---|---|---|
| `23505` | `PrismaClientKnownRequestError` `P2002`, **`meta.target` absent** | `meta.driverAdapterError.cause.constraint.fields` |
| `40001` in the callback | `PrismaClientKnownRequestError` `P2034` | `meta.driverAdapterError.cause` |
| `40001` at COMMIT | bare `DriverAdapterError`, **no `code`, no `meta`** | `cause` |

`src/lib/prisma-driver-error.ts` pulls the driver-adapter cause out of either wrapping;
predicates key on `cause.originalCode` (the SQLSTATE) and keep the legacy `meta.target` branch
for other adapters. Note `constraint.fields` is derived from the Postgres DETAIL line and is
absent when that line is — hence the constraint-name fallback.

Mocked unit tests cannot catch a regression here, because a hand-built error object asserts the
shape it was built from. The guards that matter are in
`__tests__/create-concurrency.integration.test.ts`, which replays errors Postgres actually
raised; they need `TEST_DATABASE_URL` and skip without it.

### Frozen sprint execution and claims

Sprint dispatch flattens work as PBI `sort_order` → story `sort_order` → task `sort_order`,
with stable timestamp/id tie-breakers. Once the applicable freeze point below has been
reached, later backlog reordering does not mutate the run:

- Batch (`SPRINT_BATCH`) runs freeze the list at claim time into
  `SprintTaskExecution.order`; process the returned `task_executions[]` in that order.
- Per-task runs freeze the list at dispatch time into `claude_jobs.sprint_sequence`.

For per-task runs, `wait_for_job` will not claim a job while an earlier sibling in the same
SprintRun (smaller non-NULL `sprint_sequence`) is `QUEUED`, `CLAIMED`, or `RUNNING`.
Terminal earlier siblings (`DONE`, `FAILED`, `SKIPPED`, `CANCELLED`) do not block the next claim; the
existing failure/cancellation cascade decides whether other jobs are cancelled.

Legacy rows with `sprint_sequence = NULL` stay claimable and do not participate in the
earlier-sibling comparison, preventing mixed legacy/new queues from deadlocking during
rollout. Database migration is therefore first: deploy the nullable column and index before
deploying the MCP/worker claim SQL.

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

### Auto-merge (PBI-47 + PBI-130)

`enableAutoMergeOnPr` doet eerst een discovery-call (`/version` + `/swagger.v1.json`, gecached per host) om te verifiëren dat `merge_when_checks_succeed` in `MergePullRequestOption` zit. Bij ontbreken: typed `AUTO_MERGE_NOT_ALLOWED` zonder een merge-call te doen.

Bij wél-support (schedule-first, PBI-130): **stap 1** — `POST /pulls/{idx}/merge` met `{Do:'squash', merge_when_checks_succeed:true, head_commit_id:<expectedHeadSha>}`. Faalt stap 1 → surface de fout; stap 2 draait niet. **Stap 2** — opportunistische directe squash-merge (zónder `merge_when_checks_succeed`), max 3 pogingen met backoff. Lukt → `{ok:true, mode:'merged'}`; faalt → `{ok:true, mode:'scheduled'}` (schedule uit stap 1 blijft actief). De directe merge is bedoeld voor repos zónder CI-checks waar de schedule anders nooit getriggerd wordt.

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

If no local root is found, `wait_for_job` tries an **on-demand clone** of `product.repo_url` (spec: `docs/superpowers/specs/2026-07-08-on-demand-repo-clone-fallback-design.md`). Only if the clone also fails does it roll the claim back to QUEUED and return an error. Explicit configuration is therefore optional for any product with a valid `repo_url`.

## Token-usage capture (PostToolUse hook)

`update_job_status` accepts optional fields `model_id`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`. The agent never has to pass them — `scripts/persist-job-usage.ts` runs as a PostToolUse hook, reads the local Claude Code transcript JSONL (no Anthropic API needed), sums per-job usage, and writes directly to `claude_jobs` via Prisma. Window detection: from the most-recent `wait_for_job` tool_use to EOF.

The hook is registered in `.claude/settings.json` of this repo. **For agent-worker mode** (Claude Code running with cwd inside a product worktree, not scrum4me-mcp), copy the same hook block into your user settings (`~/.claude/settings.json`) and set `SCRUM4ME_MCP_DIR` so the script resolves regardless of cwd:

```bash
export SCRUM4ME_MCP_DIR=/absolute/path/to/scrum4me-mcp
```

Pricing rows (`model_prices`) are seeded by Scrum4Me's `prisma/seed.ts`. Unknown `model_id`s leave `cost_usd = NULL` in Insights queries — add a row and re-run `npm run seed` to fill them in. Subscription-based rate-card helpers are in `src/lib/job-usage/pricing.ts`. To verify the capture pipeline end-to-end: `npm run usage:canary` (`scripts/check-worker-usage-capture.ts`).

Robustness notes:
- Subagent (`isSidechain: true`) lines in the main JSONL are skipped to avoid double-counting against `subagents/`-subdirectory transcripts.
- Lines are deduplicated on `uuid` because branching/resumption can rewrite the same message into multiple JSONLs.
- Known Claude Code bug: auto-updates can silently delete files under `~/.claude/projects/`. If you depend on these numbers for billing/reporting, persist `claude_jobs.input_tokens` etc. immediately on `update_job_status` (already what this hook does) and consider an external backup of `~/.claude/projects/` if you want to retain historical detail.

## Manual worktree cleanup

Run `cleanup_my_worktrees` (no arguments) to scan `~/.scrum4me-agent-worktrees/` and remove worktrees for jobs that are in a terminal state (DONE, FAILED, CANCELLED). Worktrees for active jobs (QUEUED, CLAIMED, RUNNING) are left untouched. Returns `{ removed, kept, skipped }`.

## Worker presence

Server-startup registers a `ClaudeWorker` record + starts a 10 s heartbeat; shutdown fires on SIGTERM/SIGINT, on stdin EOF (`end`/`close`), or on `transport.onclose`, and cleans it up. Under the agent-runner Claude spawns the server via an `npx tsx …` wrapper chain, so the real node process is a grandchild that never receives SIGTERM/SIGINT — stdin EOF / `transport.onclose` is the exit signal a spawned stdio-MCP can actually rely on. The Scrum4Me NavBar counts active workers via `last_seen_at < now() - 15s` — at 10 s interval one missed tick + jitter can flicker the indicator; bump that threshold in Scrum4Me to ≥ 25 s if needed.

| File | Purpose |
|---|---|
| `src/presence/worker.ts` | `registerWorker` (upsert + pg_notify worker_connected) + `unregisterWorker` |
| `src/presence/heartbeat.ts` | `startHeartbeat` — 10 s interval (`unref`ed, so it never keeps the process alive on its own), self-heals by re-registering when record disappears |
| `src/presence/shutdown.ts` | `registerShutdownHandlers` — SIGTERM/SIGINT + stdin `end`/`close` → stop heartbeat + unregister; returns `shutdown()` so the caller can also trigger it (e.g. from `transport.onclose`) |
| `src/index.ts` | Bootstrap: calls `getAuth` → `registerWorker` → `startHeartbeat` → `registerShutdownHandlers`, and wires `transport.onclose` → `shutdown()` |

## Queue-leeskant: entiteit-transparantie

De MCP escapet queue-bodies niet. `messageView` (`src/queue/view.ts`) geeft `body` door
en `toolJson` (`src/errors.ts`) is een kale `JSON.stringify` — geen entiteit komt erbij,
en al-geëscapete tekst wordt niet dubbel geëscaped. Dat is vastgelegd in
`__tests__/queue-entity-transparency.test.ts`; die test gaat rood op elke escape-pass
(gecontroleerd door de bug tijdelijk in `messageView` te injecteren: 5/5 rood, 5/5 groen
na terugdraaien).

**Bekend gedrag, niet reproduceerbaar (2026-07-27).** Eén keer kwam de body van bericht
`8ceedd5d` bij de ontvanger (max2, via `queue_next`) binnen met `&lt;`, `&gt;` en `&amp;`
in plaats van `<`, `>` en `&` — één blanket-laag over álle voorkomens, ongeacht markdown-
context. De ontvanger vertaalde terug en de sha klopte op de eerste poging, dus het was
echt precies één laag. Uitgesloten met meting, niet met redenering:

| Laag | Meting |
|---|---|
| Postgres-kolom | schoon, identieke sha vanaf mac én max2 |
| `queue_push` (schrijfpad) | byte-exact, ook bij 10 KB via `--file` |
| `messageView` / `toolJson` | broncode + `git log -S` over de hele historie: nooit escaping-code bestaan |
| `queue_status` / `queue_next` | byte-exact op beide hosts |
| `s4m-queue` CLI | byte-exact op beide hosts |
| NOTIFY-payload | draagt de body helemaal niet (`RETURNING *` levert 'm, niet de envelope) |

Herhaald met de byte-exacte originele body (10 KB, zelfde grootteorde, zelfde tool, zelfde
clientversie, geen compaction): niet gereproduceerd. Wat overblijft is de client-/agent-leg
op die host tijdens díé sessie — **bij eliminatie vastgesteld, niet positief aangewezen**.

**Praktische regel:** stuur bij bestandsinhoud altijd een sha256 (+ bytes/regels) mee in de
`verification` van de taak. Bij `8ceedd5d` ving die check het af; zonder zo'n check schrijft
een ontvanger stil `&lt;` naar schijf. Queue-berichten bevatten routinematig
`<server>:<model>`, `&&` en shell-fragmenten, dus dit raakt de normale gevallen.

## Key source files

| File | Purpose |
|---|---|
| `src/queue/view.ts` | `messageView` — gedeelde presentatievorm; entiteit-transparant (zie hierboven) |
| `src/tools/queue-archive.ts` | `queue_archive` / `queue_unarchive` — M32-archivering: transitieve reply-subtree in één `$transaction` (`FOR UPDATE`), alleen terminale rijen archiveerbaar (`QUEUE_NOT_TERMINAL`), per rij idempotent, géén NOTIFY. Zelfde semantiek als de s4m-queue-CLI |
| `src/git/worktree.ts` | `createWorktreeForJob` + `removeWorktreeForJob` |
| `src/git/on-demand-clone.ts` | `cloneRepoOnDemand` — on-demand clone fallback voor `resolveRepoRoot` |
| `src/tools/wait-for-job.ts` | `resolveRepoRoot`, `rollbackClaim`, `attachWorktreeToJob` |
| `src/tools/update-job-status.ts` | `cleanupWorktreeForTerminalStatus` |
| `src/tools/cleanup-my-worktrees.ts` | `cleanup_my_worktrees` tool — scans + removes stale worktrees |

## Testing

```bash
npm test                # vitest run — pretest typechecks __tests__ first
npm run typecheck       # tsc --noEmit — src/**/* only
npm run typecheck:tests # tsc -p tsconfig.type-tests.json — all of __tests__
```

### Integration tests need a database — and must not run in parallel

The `*.integration.test.ts` files run against a real Postgres and skip silently
without `TEST_DATABASE_URL`, so `npm test` never covers them. Run them with:

```bash
TEST_DATABASE_URL=<test-db-url> npm run test:integration
```

That script passes `--no-file-parallelism`, which is **required**, not a
preference. The queue integration files share one database, and
`sweepStaleQueueClaims()` has no sender filter — it requeues every stale row in
`agent_message`, including rows another test file just set to `claimed`. Run
them with vitest's default file parallelism and 3–4 of the phase-2 ownership
tests fail with a shifting cast; serialized, all 26 pass.

Point `TEST_DATABASE_URL` at a throwaway database, never at `scrum4me`. The
sweep mutates whatever it finds.

All worktree helpers have unit tests under `__tests__/git/worktree.test.ts`, `__tests__/wait-for-job-worktree.test.ts`, and `__tests__/update-job-status-worktree.test.ts`.

### Test files are typechecked by a second config

| Config | Scope | Runs via |
|---|---|---|
| `tsconfig.json` | `src/**/*` | `npm run typecheck` |
| `tsconfig.type-tests.json` | `__tests__/**/*` | `npm run typecheck:tests`, wired to `pretest` |

Because it hangs off `pretest`, `npm test` — and therefore the CI step `npm run test` —
always typechecks the tests first; `.forgejo/workflows/ci.yml` needs nothing extra. `src/`
comes along transitively through the tests' imports.

This exists because **vitest transpiles without typechecking**, so a type error in a test file
runs green. Until 2026-07-26 the base config only included `src/**/*` and the test config was
scoped to one file: 54 type errors sat unnoticed in main, and a signature change that broke
its tests passed CI. Keep the `include` a glob, never a file list — new test files must be
covered automatically.

Two consequences worth knowing before writing tests:

- `result.content[0].text` does not typecheck for handlers returning the SDK's
  `CallToolResult` (its `content` is a union). Use `toolText()` from
  `__tests__/helpers/tool-result.ts`.
- `ReturnType<typeof vi.fn>` resolves to the non-callable `Mock<Procedure | Constructable>`
  under vitest 4. Use `AnyMock` from `__tests__/helpers/mocks.ts` where a test calls the mock
  or reads `.mock.calls`.

Relative imports need explicit `.js` extensions (`moduleResolution: NodeNext`). Vitest resolves
them without, so such an import only fails in `tsc` — and a missing extension yields TS2307,
meaning the module was never typechecked at all. Details: product doc
`PATTERNS/typecheck-scope-src-en-tests`.
