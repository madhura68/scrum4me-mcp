# CLAUDE.md / AGENTS.md — scrum4me-mcp

## Scrum4Me-product
- **Naam:** scrum4me-mcp
- **product_id:** `cmopqt0yj000004jp7lr7mn8e`
- **Definition of Done:** vlekkeloze integratie met scrum4me

MCP server that exposes the Scrum4Me dev-flow as native tools for Claude Code and Codex.

<!-- BEGIN scrum4me-agent-workflow v1 -->
## Scrum4Me-methodiek en MCP-queue

Volgt de globale Scrum4Me-methodiek (`~/.claude/rules/scrum4me-methodiek.md` voor Claude; de "Scrum4Me-methodiek"-sectie in `~/.codex/AGENTS.md` voor Codex). Niet-triviaal werk: plan → Sprint/PBI/Story/Taak via de `scrum4me` MCP → `update_task_status` per laag → docs in de DB. Volg de bestaande goedkeuring en hardstop na materialisatie; voor alleen documentatie/instructies geldt de doc-only-uitzondering.

**Context.** Lees `product_id` uit het Scrum4Me-productblok in de repo-`CLAUDE.md`/`AGENTS.md`. Ontbreekt het, werk normaal zonder een product-ID te raden.
Start als interactieve hoofdsessie met `mcp__scrum4me__get_context({ product_id, agent })` en herhaal dit na compactie vóór je het inhoudelijke werk hervat. Geef een bekende `agent.runtime` (CLAUDE/CODEX) mee, ook als het model-ID onbekend is; voeg `agent.model_id` alleen toe als het exacte ID bekend is. Laat bij onbekende runtime het hele `agent`-object weg; raad geen identiteit. `model_id` selecteert een profiel en wisselt geen model.
Lees `agent_guide`, controleer `agent_context.applied_profiles` en volg het beleid voor taakverdeling, modelkeuze voor subagents en verificatie binnen de actuele opdracht. Het door de gebruiker gekozen hoofdmodel blijft ongewijzigd; een andere aanbeveling in de guide is geen fout. Geef subagents de relevante guide en taakcontext mee; zij herhalen de hoofdstartflow niet automatisch.
Alleen als de guide ontbreekt of leeg is: vraag één keer `get_agent_guide` met hetzelfde product en dezelfde agentinvoer op en lees `guide_md`. Een ontbrekend profiel alleen is geen reden voor een extra aanroep. Blijft de guide ontbreken, meld dit en volg de bestaande werkwijze voor ontbrekende MCP-context zonder herhaallus.
`get_context` geeft product en alle `active_sprints`. Kies uitsluitend de sprint binnen de actuele opdracht; lees `get_sprint_context({ sprint_id })` voor stories/taken en voeg `task_id` alleen toe voor het volledige taakplan. Gebruik `get_ideas_context({ product_id })` alleen voor ideeën. Behoud na compactie dezelfde opdracht en autorisatie; context autoriseert geen volgende story of nieuwe claim. Geclaimde workerjobs volgen eerst hun kind-prompt en payload, gebruiken een meegegeven passende guide en halen alleen een ontbrekende guide gericht op.

**Queue gebruiken.** Volg de `s4m-queue`-skill bij queue-handelingen. Gebruik de `mcp__scrum4me__queue_*`-tools met je eigen identiteit; de CLI is fallback bij ontbrekende MCP-toegang of identiteit.
- Stuur een geautoriseerde opdracht/vraag met `queue_push({ to, type, body, ... })`: `task`, `info` of `review_request`. Voor `task`/`review_request`: `cwd` op de ontvangende host en `meta.task: { objective, verification, response_format }`; geef `meta.task.repo` expliciet mee als die niet uit `cwd` kan worden afgeleid.
- Koppel bestaand werk met het meest specifieke `task_id`, `story_id` of `sprint_id` als toolparameter. Gebruik echte IDs uit de context, geen zichtbare codes. De tool leidt `product_id` en bovenliggende IDs af naar `meta.work_item`; geef geen losse `product_id`-parameter aan `queue_push`. Zonder bestaand werkitem geen ID verzinnen.
- Bewaar `message_id`; lees antwoorden met `queue_wait_reply({ message_ids: [...] })`. Ontvang werk via `queue_next`, lees body én metadata en werk binnen `meta.task.cwd`. Rond af via `queue_done`/`queue_fail` met `message_id` en `claim_token`; sluit CLI-claims via de CLI af.

**Reviewdocumenten via metadata.** Voeg bij `review_request` de beoordeelde bronnen toe als `meta.review_documents: { version: 1, items: [...] }`, naast `meta.task`.
- Iedere referentie bevat `key`, `title`, `product_id` en `sha256` van de exacte documentinhoud. Gebruik `source: "product_doc"` met `doc_id` + `revision_id`, of `source: "git"` met relatief `.md`-`path` + volledige gepubliceerde `commit_sha`.
- Lees als reviewer de gekoppelde exacte revisie/commit en controleer de SHA-256; alleen de body of de nieuwste versie lezen volstaat niet. Ontbreekt de gepinde bron of wijkt de hash af, voer de review niet uit: meld de fout en rond een geclaimd verzoek af met `queue_fail`.
- Rapporteer tegen deze pins en antwoord via `queue_done`; het `reviewed`-antwoord blijft via `in_reply_to` gekoppeld aan de reviewdocumenten van het verzoek.
<!-- END scrum4me-agent-workflow v1 -->

## Hierarchical ordering contract

Use the standard context workflow above before applying the ordering contract below.

Sprint stories/tasks follow PBI → story → task `sort_order` (then `created_at` and `id`
at each level). Follow that order; never infer it from priority or stored item codes.

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
   - Base: origin's default branch for fresh branches (resolved via `origin/HEAD` after fetch, falling back to `origin/main`, so repos whose default is `master` also work); existing remote tip for reused branches
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

- **Open PR** → Forgejo REST close (cascade-comment + state:closed) + best-effort `git push origin --delete <branch>` with `expectedHeadSha`-guard so a late worker-push isn't overwritten. Since M38 the remote delete only runs when origin's tip is already contained in the default branch; an unmerged tip is left in place as a backup instead of being deleted.
- **Merged PR** → revert-PR opened against the base branch via `git revert` (parent-count-aware: `-m 1` for merge-commits, plain revert for squash-merges with 1 parent). **No** auto-merge on the revert PR — review by hand.
- **Branch without PR** → best-effort `git push origin --delete <branch>` with `expectedHeadSha`-guard, subject to the same M38 gate: an unmerged tip is kept as a backup rather than deleted.

A loose task job that is a `HARNESS` job or a `local_llm` job (`isHarnessJob`, see "HARNESS runtime" below) is exempt: it gets no auto-PR, no status propagation to task/story/PBI and no PBI fail-cascade on `done`/`failed` — the harness manages those loose task jobs itself.

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

### Range-diff: geen web-route, wel een reeks commit-diffs

De Forgejo-API kent **geen** raw diff voor een commit-range: `/repos/{o}/{r}/compare/{basehead}` levert alleen JSON, en `.diff` op dat pad is 404. Alleen `/git/commits/{sha}.{diffType}` en `/pulls/{index}.{diffType}` geven `text/plain`.

Gebruik daarvoor **niet** de web-route `/{owner}/{repo}/compare/{base}...{head}.diff`: web-routes kennen geen token-auth, dus op een private repo geeft die onvoorwaardelijk 404 — voor elke range, altijd. `fetchCompareDiff` (`src/git/pr.ts`) haalt daarom de commits uit de compare-JSON en per commit de diff via `/git/commits/{sha}.diff`, allebei via `forgejoFetch` (dus mét token).

Gevolgen voor de caller — en voor wie zo'n diff reviewt:

- Het resultaat is de reeks commit-diffs in **chronologische** volgorde (`git log -p base..head`), niet de samengevouwen drie-punts-diff. Een bestand dat in twee commits is aangeraakt, komt twee keer voor.
- Merge-commits leveren een lege diff en worden overgeslagen.
- Harde grenzen: **50** commits (`COMPARE_MAX_COMMITS`) en **4 MB** (`COMPARE_MAX_BYTES`) — een drie-punts-range trekt merge-historie mee. Overschrijding is een expliciete fout, geen stil afgekapte diff.

### TASK_REVIEW-requeue is begrensd

Mislukt de diff-fetch voor een `TASK_REVIEW`, dan requeuet `getFullJobContext` de job (meestal een storing buiten deze job om), maar hoogt het daarbij `retry_count` op en gooit `TerminalJobError` zodra dat `DIFF_FETCH_MAX_RETRIES` (2, gelijk aan de stale-lease-sweep) bereikt. Zonder die grens wint een permanent-falende job elke ronde — de claim pakt de **oudste** QUEUED rij — en legt hij de hele reviewrij stil.

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

If no local root is found, `wait_for_job` tries an **on-demand clone** of `product.repo_url` (spec: `docs/superpowers/specs/2026-07-08-on-demand-repo-clone-fallback-design.md`). Only if the clone also fails does it roll the claim back to QUEUED and return an error. Explicit configuration is therefore optional for any product with a valid `repo_url`. Exception: a `HARNESS` job or a `local_llm` job (`isHarnessJob`: `runtime = 'HARNESS'` or `required_capability = 'local_llm'`) resolves **only** from an explicitly configured root (env var or config entry) — no `~/Projects/<name>` convention lookup and no on-demand clone, and a cross-repo task never falls back to the product root. Without one the job goes straight to `FAILED` (no rollback to QUEUED).

## HARNESS runtime (M45-2b)

`HARNESS` is the third worker runtime beside `CLAUDE` and `CODEX`: a LiteLLM model on a per-product configuration, run by the harness instead of Claude Code (Scrum4Me spec `docs/superpowers/specs/2026-10-05-harness-runtime-design.md`, plan `docs/plans/M45-2b-harness-mcp.md`). It exists for two job kinds only: `IDEA_CHAT` and a standalone `TASK_IMPLEMENTATION` (source `COPILOT`, no sprint run). `WorkerRuntime` is the shared `AgentRuntime` (`@shared/agent-runtime.js`), not a list of its own. `HARNESS` is a worker runtime only: the caller identity of `get_context`/`get_agent_guide` and managed dispatch (`dispatch_task`, `dispatch_review`) stay `CLAUDE | CODEX`. Without a product choice, job routing and the claim of Claude and Codex jobs stay as before; the startup check of `SCRUM4ME_WORKER_RUNTIME`, the `dispatch_job` refusal and the read of `product_harness_choices` on the enqueue paths apply regardless. No `HARNESS` row exists in a shared database before the cutover (M45 increment 2e).

### Worker identity

- `SCRUM4ME_WORKER_RUNTIME` accepts `CLAUDE`, `CODEX` and `HARNESS`, case-insensitive, surrounding whitespace ignored. Empty or unset is `CLAUDE`.
- **Any other value is fatal.** `parseWorkerRuntime` throws `UNKNOWN_AGENT_RUNTIME` (the value is never in the message). `startStdioServer` resolves the runtime before authentication and registration (the credentialless canary mode never reads it), so the process exits with code 1 and registers no worker. Before M45-2b every value except `CODEX` silently became `CLAUDE`: a typo registered a Claude worker that claimed Claude jobs. Check the variable on an installation before updating it; only an empty value or one of the three above still starts.
- `health` returns `runtimes: ['CLAUDE', 'CODEX', 'HARNESS']` (a fresh copy per call, also when the database is down). An installation without that field predates M45-2b. The plain `GET /health` route of `src/http.ts` is unchanged.

### Claim

- A `HARNESS` worker claims only `HARNESS` jobs: `required_capability IS NULL` and either `IDEA_CHAT` (source `SYSTEM`) or a standalone `TASK_IMPLEMENTATION` (source `COPILOT`, `sprint_run_id IS NULL`). The branch is chosen on the worker's runtime, before the capability branches, so its capabilities do not count. No Claude or Codex worker claims a `HARNESS` job. The branch exists in every mirror of the claim filter in `src/dispatch/eligibility.ts` (string SQL, Prisma fragment, TS predicate, SQL condition); the tier fragment needs none (peers already filter on the worker's own runtime). `__tests__/dispatch/harness-claim.integration.test.ts` pins the filter in both directions on a real Postgres in the dispatch gate.
- `getFullJobContext` compares the job's runtime with the worker's as the first step after loading the job, before any worktree or idea preparation, and only when the caller passes a runtime. `wait_for_job` does, and so does the docker runner (`scrum4me-docker` `bin/run-one-job.ts` calls `getFullJobContext(jobId, runtime, ownerCtx)` with the runtime from `getWorkerRuntimeFromEnv()`); a call without a runtime argument has no production caller today and then checks and gives back nothing. A job whose runtime differs is given back by `releaseMismatchedClaim` and `wait_for_job` returns the tool error `RUNTIME_MISMATCH` (not a `TerminalJobError`: the job is not failed). The give-back is one database-only transaction: `SELECT … FOR UPDATE` on the job row (nothing changes when the claim is no longer this token and instance), the task back to `TO_DO` only if this claim promoted it (`tasks.updated_at = claude_jobs.claimed_at`), then the job back to `QUEUED` with empty claim fields. Only a claim-filter bug can cause this. The docker runner does not handle `RuntimeMismatchError` (master `77a00a7`): the error falls into its generic catch, which calls `rollbackClaim(jobId, { tokenId, instanceId })`. That call is ownership-fenced, so after the give-back it updates no row (claim log `rollback.ownership_lost`) and stops: a no-op, not a second give-back. Docker should handle `RUNTIME_MISMATCH` explicitly in part 2d. The harness (increment 2d, not in this repo) must stop on this error without restarting; nothing here enforces that. A Claude or Codex worker would instead claim and give back the same job on every poll, visible as `runtime_mismatch` in the claim log.
- The payload `config` of a `HARNESS` job is `{ runtime: 'HARNESS', model, max_cost_usd }`: `model` is the configuration name from the job's `requested_model`, `max_cost_usd` the ceiling that `readHarnessChoice` (`src/lib/harness-choice.ts`) reads from `product_harness_choices` at claim time, as a plain decimal string (`'0.2000'` becomes `'0.2'`). No row means the default of the kind (`IDEA_CHAT` `0.05`, `TASK_IMPLEMENTATION` `0.50`); a failing read is an error and never the default. In the `IDEA_CHAT` payload `prompt_text` is `''`: `getIdeaPromptText` returns `''` for `HARNESS`, which never gets a Claude prompt because the harness has its own. A standalone `TASK_IMPLEMENTATION` payload has no `prompt_text` key at all, for a `HARNESS` job as for a Claude job. The rest of each payload has the same shape as for a Claude job of that kind.
- An unusable `HARNESS` configuration is terminal. The resolver errors `HARNESS_CONFIGURATION_INVALID`, `HARNESS_COST_LIMIT_INVALID`, `HARNESS_KIND_UNSUPPORTED` and `UNKNOWN_AGENT_RUNTIME` become a `HarnessJobConfigError` (a `TerminalJobError`): `markJobTerminallyFailed` sets the job to `FAILED` with that code and `wait_for_job` returns the bare code, on both claim paths (direct and after waiting). Both catch blocks test `HarnessJobConfigError` before `TerminalJobError`, which would otherwise word the failure as an unresolvable repo. Without this the job would stay `CLAIMED` until the lease expires and be claimed twice more.
- The "is there a worker for this idea job?" precheck of `IDEA_GRILL`, `IDEA_MAKE_PLAN` and `IDEA_MAKE_SPEC` (`src/lib/dispatch/idea-jobs.ts`) does not count `HARNESS` workers: they never claim those kinds, so counting them left the job `QUEUED` for ever.

### Git protection: `isHarnessJob`

One predicate decides the git protection of a guarded job (`src/git/local-llm.ts`): `isHarnessJobRow({ runtime, required_capability })` is true for `runtime = 'HARNESS'` **or** `required_capability = 'local_llm'`, and `isHarnessJob(jobId)` reads both fields from the database — never from the worktree, and without a status filter. The `local_llm` branch stays permanent: the worktree of a closed `local_llm` job can still occupy a branch, and that directory stays guarded. A guarded job gets:

- an explicitly configured repo root only, no on-demand clone (so no `npm ci` on the host) — `attachWorktreeToJob`, `resolveRepoRoot({ explicitRootsOnly })`;
- no `prepare:worktree`, and a refusal (`LocalLlmWorktreeRefused`) when the worktree's `.gitmodules` differs from the trusted default ref's;
- removal of a stale branch occupant, for an existing and for a fresh branch, and removal of its own worktree on a terminal status, without running git in the worktree (`removeWorktreeWithoutGit`; the branch ref stays in the clone);
- `SAFE_GIT_CONFIG` (hooks, fsmonitor and submodule processing off) plus the gitlink check before every host-git call with the worktree as working directory (`gitPrefixFor`: push with `--no-verify`, set-head, rev-parse, diff);
- no backup push from the worktree (`maybeBackupPush` skips it; `maybeBackupPushBranch` runs from the repo root on the branch ref and does not consult the predicate);
- in `update_job_status`: no auto-PR, no status propagation and no PBI fail-cascade, through `!isHarnessJobRow(job)` at the three former `local_llm` checks.

The derived names keep their pre-M45 spelling (`isLocalLlmWorktree`, `gitPrefixFor`, `SAFE_GIT_CONFIG`, `LocalLlmWorktreeRefused`, `removeWorktreeWithoutGit`) and follow the predicate. Four git paths have no check of their own and rely on the job kind (`update-task-execution`, the sprint claim, the product-worktrees of idea kinds, the sprint-batch PR): the claim branch, the resolver (`HARNESS_KIND_UNSUPPORTED`) and the enqueue paths admit only `IDEA_CHAT` and a standalone `TASK_IMPLEMENTATION`, so a `HARNESS` job never reaches them. A grep for `local_llm` in `src/` should find only the predicate, the five `local_llm` spots of the claim filter (until increment 3), the `dispatch_job` refusal, and comments, error texts and log keys (`backup-push.skip_local_llm`); any other hit is a protection that still reads `required_capability` alone. The legacy capability inheritance of the idea-chat follow-up job (`routing` in `update_job_status`, also until increment 3) copies `job.required_capability` without a `local_llm` literal, so that grep does not show it.

### Routing at enqueue

- `dispatch_job` refuses every `required_capability`, for every kind, with the one message `required_capability local_llm wordt niet meer aangenomen; kies per product een HARNESS-configuratie.` (`VALIDATION_ERROR`, before authentication and any database access): the `local_llm` route is replaced by a `HARNESS` configuration per product. The key stays in the input schema (with a description saying so) so zod does not drop it silently. `dispatchTaskImplementation` no longer has a `requiredCapability` option.
- Three paths read the product's choice with `readHarnessChoice` inside their own transaction, after their guards and before the create: a standalone `TASK_IMPLEMENTATION` (`dispatchTaskImplementation`), `send_idea_chat_message` (after the coalescing check) and the idea-chat follow-up job that `update_job_status` creates when a turn ends with newer user messages waiting. With a choice the job gets `runtime: 'HARNESS'` and the configuration as `requested_model`, no Claude snapshot and never a `required_capability`. Without a row the create object stays exactly as before M45 (existing tests pin those shapes); a read error propagates and is never "no choice".
- The follow-up job follows the choice at that moment, not the runtime of the job that just finished. Without a choice it still inherits `required_capability` (the legacy `local_llm` route). The enqueue paths never give a `HARNESS` job a `required_capability`, so a `HARNESS` predecessor without a choice has none to inherit and yields an ordinary Claude follow-up job: the choice is also the permission.

### Cost report

`update_job_status` takes an optional strict `cost: { reported_cost_usd: string | null, cost_source: 'provider_reported' | 'litellm_computed' | 'local' | 'none', provider?: string }` (`src/lib/harness-cost.ts`).

- Only a job with `runtime = 'HARNESS'` of a kind the harness runs (`IDEA_CHAT` or `TASK_IMPLEMENTATION`, `isHarnessJobKind`) reports (a `local_llm` job does not), and only with status `done`, `failed` or `skipped`; otherwise `VALIDATION_ERROR: COST_REPORT_NOT_ALLOWED`. The kind matters because the own end paths of `DOCS_AUDIT` and `DEPLOY` never write a cost row: a report there would vanish without a trace, so it is refused (no such `HARNESS` job exists today). The whole object is validated right after the job is read, before the verify gate, the push and those own end paths, so a refusal leaves no pushed branch behind a job that stays `RUNNING`; a mismatch gives `VALIDATION_ERROR: COST_REPORT_INVALID`.
- Rules per source: `none` has no amount, `local` needs `0`, `provider_reported` and `litellm_computed` need an amount `>= 0`. The amount is a plain decimal string (no exponent, no sign, at most 6 digits before the point, at most 64 characters: the parser refuses a longer input before any pattern or `BigInt` work, while the tool schema does not limit the length) and is **rounded up** to 6 decimals (`'0.00031200000000000005'` becomes `'0.000313'`): a refusal would block the whole end status, and rounding up never reports too little. String and `BigInt` arithmetic only, never a float. The MCP never invents an amount.
- The row in `job_cost_reports` (one per job, upsert on `job_id`, `reported_at` = now) carries the configuration from the job's own `requested_model`, never from the report. It is written in the same transaction as the status update: inside the existing transaction of an idea-chat turn, otherwise as `prisma.$transaction([update, upsert])`, and only when a cost is reported — without one the plain single update stays. A row the database refuses rolls the status update back with it.

## Session usage and estimates (IDEA-235)

- `record_usage_segment` (written by the usage-ledger mod): monotonic per segment id. Ownership and access are checked first; then a header creates or is a no-op, a closing message closes an open segment once (`updateMany … where ended_at IS NULL`, lines replaced in the same transaction), and anything on a closed segment succeeds without effect. Owner, product and sprint are fixed from `anchor_task_id` at creation and never change. Errors starting with `USAGE_SEGMENT_REJECTED` are permanent (the mod drops the segment); every other failure is transient (the mod retries from its outbox). Schema errors fall under the prefix too: the tool is registered with a loose schema and the handler validates strictly, because a bare SDK `-32602` would be retried forever. A closing is checked against the stored `started_at`, not the one in the message.
- `create_task` takes an optional estimate (`estimate_active_minutes`, `estimate_usd`, `estimate_basis`: all three or none) and writes one `task_estimates` row in the task's transaction. No other code writes `task_estimates` (`__tests__/create-task-estimate.test.ts` enforces it). With PPE the estimate is part of the hashed request, only when present.
- `get_estimate_history` uses the shared SQL in `vendor/scrum4me-shared/lib/usage-sql.ts`; USD only when every line is priced. Real-Postgres coverage: `__tests__/usage-ledger.integration.test.ts` (`TEST_DATABASE_URL`, skips without it).

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

## Notes-tools (IDEA-226)

- Six tools (`create_note`, `update_note`, `delete_note`, `get_note`, `search_notes`, `list_note_keywords`) on top of `src/lib/notes-data.ts` — the **only** module that touches `prisma.note*`, `prisma.noteKeyword*` and `prisma.noteKeywordLink*`. Every adapter function takes `userId` as its first parameter; no tool schema has a `user_id`.
- Writes start with `requireWriteAccess()` (demo → `PERMISSION_DENIED` before handler-level parsing or any DB access; input that fails the published `inputSchema` is rejected by the MCP SDK before the handler runs, so a demo token never reaches the adapter either way); product links and product filters go through `userCanAccessProduct` (respects `scoped_products`). `get_note` is the only read/search tool that returns a `body`; `create_note`/`update_note` return the full note.
- **Never `prisma db pull` on `note_keywords`:** the partial unique index `note_keywords_default_name_key` and the default keywords live only in Scrum4Me migration `20260928060000_add_notes`. This repo only runs `prisma generate`.

## Key source files

| File | Purpose |
|---|---|
| `src/queue/view.ts` | `messageView` — gedeelde presentatievorm; entiteit-transparant (zie hierboven) |
| `src/tools/queue-archive.ts` | `queue_archive` / `queue_unarchive` — M32-archivering: transitieve reply-subtree in één `$transaction` (`FOR UPDATE`), alleen terminale rijen archiveerbaar (`QUEUE_NOT_TERMINAL`), per rij idempotent, géén NOTIFY. Zelfde semantiek als de s4m-queue-CLI |
| `src/git/worktree.ts` | `createWorktreeForJob` + `removeWorktreeForJob` |
| `src/git/on-demand-clone.ts` | `cloneRepoOnDemand` — on-demand clone fallback voor `resolveRepoRoot` |
| `src/git/local-llm.ts` | `isHarnessJobRow` / `isHarnessJob` — the predicate behind the git protection of a guarded job (`HARNESS` or `local_llm`), plus `SAFE_GIT_CONFIG`, `gitPrefixFor`, `removeWorktreeWithoutGit` |
| `src/worker-runtime.ts` | `parseWorkerRuntime` / `getWorkerRuntimeFromEnv` — `SCRUM4ME_WORKER_RUNTIME`; an unknown value throws `UNKNOWN_AGENT_RUNTIME` |
| `src/dispatch/eligibility.ts` | The claim filter in all its mirrors (string SQL, Prisma fragment, TS predicate, SQL condition), including the `HARNESS` branch |
| `src/lib/harness-choice.ts` | `readHarnessChoice` — the product's choice (configuration + cost ceiling) for the claim and the three enqueue paths |
| `src/lib/harness-cost.ts` | `checkCostReport` / `parseReportedCostUsd` — validation of the `cost` object of `update_job_status` |
| `src/tools/wait-for-job.ts` | `resolveRepoRoot`, `rollbackClaim`, `releaseMismatchedClaim`, `attachWorktreeToJob` |
| `src/tools/update-job-status.ts` | `cleanupWorktreeForTerminalStatus`; the cost row of a `HARNESS` job |
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

### The PPE controller suites need their own database

`ppe-ceremony-idempotency`, `ppe-log-idempotency` and `ppe-task-cas` run against
the PPE controller schema, not the `TEST_DATABASE_URL` one. They
`describe.skipIf` themselves away unless
`PPE_CONTROLLER_TEST_DATABASE_URL` is set, so a plain `npm test` reports them as
skipped instead of failing on an absent local Postgres. Set the variable to opt
in:

```bash
PPE_CONTROLLER_TEST_DATABASE_URL=<ppe-test-db-url> npm test
```

CI covers them: `.forgejo/workflows/ci.yml` provisions the database, exports the
variable, and `npx prisma db push --url "$PPE_CONTROLLER_TEST_DATABASE_URL"`
applies the schema.

### The dispatch integration suite has its own config and database

`__tests__/dispatch/**/*.integration.test.ts` is **excluded** from
`vitest.config.ts`, so neither `npm test` nor `npm run test:integration` ever
runs it — `TEST_DATABASE_URL` does not apply to it. It runs under
`vitest.dispatch.config.ts` (own setup file, `fileParallelism: false`) via:

```bash
npm run test:dispatch
```

That script first runs `node scripts/dispatch-test-db.mjs check`, which demands
a disposable cluster: `DISPATCH_TEST_ADMIN_URL` plus a `DISPATCH_TEST_SCHEMA_ROOT`
checkout of the pinned Scrum4Me schema commit, and it refuses any target that is
not a throwaway. CI provisions both and drives the whole gate through
`node scripts/run-dispatch-ci.mjs`, which creates a fresh `s4m_dispatch_test`
database and then calls `npm run test:dispatch`.

The test database is the historical schema of `DISPATCH_SCHEMA_COMMIT`
(`6dc581da`) plus two additive overlays. Each is an immutable pin of commit, path
and sha256 that `scripts/dispatch-test-db.mjs` reads with `git show` from the
schema source, never a replacement baseline: the token-usage migration
(`TOKEN_USAGE_MIGRATION_COMMIT`) and, since M45-2b, the two M45-2a migrations of
Scrum4Me commit `ae6483b2` (`HARNESS_MIGRATION_COMMIT`): the `AgentRuntime.HARNESS`
enum member and the tables `product_harness_choices` and `job_cost_reports`. The
enum member and the tables go in as two separate queries, on one admin connection,
under a temporary `CREATE` right on `public` that a `finally` revokes again (the
schema belongs to `pg_database_owner`), followed by grants equal to the 2a
contracts. So `DISPATCH_TEST_SCHEMA_ROOT` must be a **full** clone of Scrum4Me — not
shallow, and recent enough to contain `ae6483b2` — checked out clean at
`DISPATCH_SCHEMA_COMMIT`. `check` and `provision` refuse a source without that
commit (`DISPATCH_HARNESS_MIGRATION_SOURCE_REFUSED`) and a file with another hash
(`DISPATCH_HARNESS_MIGRATION_HASH_REFUSED`). CI already clones fully
(`git clone --no-checkout`, no `--depth`), so `.forgejo/workflows/ci.yml` needs
nothing extra.

All worktree helpers have unit tests under `__tests__/git/worktree.test.ts`, `__tests__/wait-for-job-worktree.test.ts`, and `__tests__/update-job-status-worktree.test.ts`.

### Test files are typechecked by a second config

| Config | Scope | Runs via |
|---|---|---|
| `tsconfig.json` | `src/**/*` | `npm run typecheck` |
| `tsconfig.type-tests.json` | `__tests__/**/*`, plus `scripts/dispatch-test-db.mjs` under `allowJs`/`checkJs` | `npm run typecheck:tests`, wired to `pretest` |

Because it hangs off `pretest`, `npm test` — and therefore the CI step `npm run test` —
always typechecks the tests first; `.forgejo/workflows/ci.yml` needs nothing extra. `src/`
comes along transitively through the tests' imports.

This exists because **vitest transpiles without typechecking**, so a type error in a test file
runs green. Until 2026-07-26 the base config only included `src/**/*` and the test config was
scoped to one file: 54 type errors sat unnoticed in main, and a signature change that broke
its tests passed CI. Keep the `__tests__` entry a glob, never a file list — new test files must
be covered automatically. The named `scripts/dispatch-test-db.mjs` entry beside it is the
exception: a single non-test helper pulled in deliberately, not a pattern to copy.

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
