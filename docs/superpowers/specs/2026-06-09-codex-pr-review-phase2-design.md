---
title: "Phase 2 — PR-code-review op codex — Design"
status: draft
audience: [ maintainer, ai-agent ]
language: nl
last_updated: 2026-06-09
scope: [ scrum4me-shared, scrum4me-mcp, scrum4me-docker, scrum4me-workers ]
depends_on: "Phase 1 — plan-review op codex (scrum4me-mcp docs/superpowers/specs/2026-06-08-codex-plan-review-phase1-design.md)"
parent: "Impact report — Codex-als-worker voor alle reviews §9 (scrum4me-workers docs/superpowers/specs/2026-06-07-codex-review-worker-impact-report.md)"
---

# Phase 2 — PR-code-review op codex — Design

**Doel.** Een codex-fleet-worker reviewt een **Forgejo pull-request** als een first-class `PR_REVIEW`-job: handmatig ge-enqueued uit de workers-UI, geclaimd via de bestaande runtime+capability-routing, beoordeelt de PR-diff + PR-meta + het gekoppelde plan/acceptatiecriteria, en post autonoom een **Forgejo review-state** (`APPROVED`/`REQUEST_CHANGES`/`COMMENT`) terug op de PR. Puur API/DB-werk — **geen code-checkout/worktree**. Advisory: de review-state is zichtbaar maar wordt (nog) niet aan merge-blocking gekoppeld (gating = Phase 4).

**Waarom dit de logische volgende fase is.** Phase 1 bewees de codex-review-keten op een bestaand kind met een bestaande sink (geen schema-wijziging). Phase 2 is de eerste review op een **nieuw artefact-type** (een PR i.p.v. een idee) en vergt daarom (a) een nieuw `ClaudeJobKind`, (b) een **Forgejo-schrijfpad** (review posten), en (c) een nieuwe payload-tak (diff + plan ophalen). Het hergebruikt verder de volledige Phase-0/1-substraat: runtime-claim-routing, capability-gate, runtime-bewuste promptselectie, snapshot-override en de canary-mechaniek.

## Besluitenlog (deze brainstorm)

1. **Aanpak = A (first-class `PR_REVIEW`-kind)**, niet B (s4m-queue `review_request`-brug). Reviews horen in de job-levenscyclus (observability via job-board/worker-insights, runtime-attributie, capability-gate, zet Phase 3/4 op). B blijft het interactieve/menselijke pad (impact-rapport §3).
2. **Verdict = echte Forgejo review-state**, autonoom geveld: `APPROVED` / `REQUEST_CHANGES` / `COMMENT`. Zichtbaar op de PR, maar **advisory** — niet aan merge-blocking gekoppeld (gating = Phase 4). Sluit aan op Phase 1's "autonoom verdict".
3. **Granulariteit = samenvattende review-body** (verdict + findings met `bestand:regel` in tekst). **Géén inline-comments** (YAGNI; kan een latere uitbreiding worden).
4. **Context = diff + PR-meta + gekoppeld plan/acceptatie**, best-effort geresolved (zie §7), met graceful fallback naar diff + product-docs als er geen koppeling is. (Bewust geaccepteerd dat dit licht in Phase 3's "implementatie-review"-gebied raakt; de gebruiker koos expliciet voor de plan-conformiteitscheck.)

## 1. Voorwaarde (Phase 0 + Phase 1 — VERVULD)

- **Phase 0 (codex-runner-substrate): LIVE.** `agent-codex` draait op **154 (LOW_P)** + **max2 (HIGH_P)**; multi-stage image, runtime-tak in `bin/run-one-job.ts`, `config.toml` met `[mcp_servers.scrum4me]`. (scrum4me-docker master `ee8c647`.)
- **Phase 1 (plan-review op codex): LIVE.** Runtime-bewuste promptselectie + capability-advertentie + snapshot-override gemerged (mcp `eeee8c7`, docker `31d13ae`, workers `189eabf`); dubbel-canary GO. Dit betekent dat de **infrastructuur die Phase 2 hergebruikt al draait**: `getKindPromptText(kind, runtime)` (mcp `src/lib/kind-prompts.ts:42`), `capabilities` op de worker-rij (`run-one-job.ts` → `registerWorker`/`startHeartbeat`), en de codex-snapshot-override in workers.

Phase 2 kan dus volledig op de huidige `origin/main` (mcp `eeee8c7`) + master gebouwd worden.

## 2. Scope

**IN**
- `PR_REVIEW` toevoegen aan `ClaudeJobKind` (scrum4me-shared schema-PR → submodule-bump in mcp/docker/workers; migratie via scrum4me-web).
- mcp: codex-portable `src/prompts/pr/review.codex.md` + registratie in `kind-prompts.ts`; een `getFullJobContext` PR_REVIEW-tak (diff + PR-meta + plan/acceptatie); `PR_REVIEW` toevoegen aan `CLAIMABLE_STANDALONE_KINDS` (`wait-for-job.ts:320`); twee Forgejo-helpers (`fetchPrDiff`, `postPullRequestReview`) in `src/git/pr.ts`; de sink-tool `post_pr_review` (`src/tools/post-pr-review.ts` + registratie).
- docker: de runner slaat **worktree-attach over** voor `PR_REVIEW` (read-only); runtime/capabilities zijn al Phase 1.
- workers: een `pr-review`-template (velden `pr_url` + `instructie`; `defaultRuntime: codex`, `allowedRuntimes: [claude, codex]`, capability `review`); de enqueue vult `ClaudeJob.pr_url`; hergebruikt de Phase-1-snapshot-override + capability-gate.
- Canary via de **echte manual-enqueue** (source=MANUAL) tegen een wegwerp-PR op 154/max2.

**OUT** (expliciet, zie §13)
- Auto-dispatch (Forgejo-webhook / status-hook) + merge/advance-gating → Phase 4.
- Inline per-regel review-comments (alleen samenvattende body in Phase 2).
- `SPEC_REVIEW` / `TASK_REVIEW` + bijbehorende sinks → Phase 3.
- Nieuwe DB-kolom: hergebruik `ClaudeJob.pr_url` (target) + `ClaudeJob.summary` (verdict-trace). Een aparte `review_verdict`-kolom is optioneel later (impact-rapport §5), niet Phase 2.
- SYSTEM/ORCHESTRATOR `PR_REVIEW` + de bijbehorende done-gate-exemptie → Phase 4 (MANUAL is al exempt, §9).
- Claude als PR-reviewer forceren: `claude` blijft in `allowedRuntimes` maar de default + de bedoeling is codex (cross-model: implement=Claude, review=Codex; impact-rapport §8).

## 3. Architectuur & data-flow

```
enqueue (workers-UI /jobs/new: pr_url + instructie)
  → ClaudeJob{ kind: PR_REVIEW, runtime: CODEX, source: MANUAL, status: QUEUED, pr_url }
  → agent-codex claimt        [runtime-filter + CLAIMABLE_STANDALONE_KINDS (wait-for-job.ts:320 → + 'PR_REVIEW')]
  → getFullJobContext         [NIEUWE PR_REVIEW-tak, op kind VOOR de MANUAL-branch (wait-for-job.ts:775): parseForgejoPrUrl + fetchPrDiff + PR-meta + plan/acceptatie-resolutie]
  → payload.json              { pr{url,owner,repo,index,meta}, pr_diff, linked_plan?, doc_index, config }
  → runner kiest prompt       [getKindPromptText('PR_REVIEW', 'CODEX') → pr/review.codex.md]   (runner gezaghebbend, Phase 1)
  → codex exec                [GEEN worktree-attach — read-only]
  → codex beoordeelt diff (+ plan/acceptatie) → bepaalt event + body
  → post_pr_review({ job_id, pr_url, event, body, review_log })   ← NIEUWE sink
        → Forgejo POST /repos/{owner}/{repo}/pulls/{index}/reviews (CreatePullReviewOptions{ body, event })
        → ClaudeJob.summary += verdict-trace  (+ log-entry)
  → update_job_status(done)   [source=MANUAL → reaches DONE zonder verify-gate, update-job-status.ts:738]
```

**Wat al bestaat (gegrond, scrum4me-mcp @ `origin/main` eeee8c7):**

| Onderdeel | Locatie | Status |
|---|---|---|
| Runtime-bewuste promptselectie | `src/lib/kind-prompts.ts:42` `getKindPromptText(kind, runtime)`, overrides `:36-40` | bestaat (Phase 1) — PR_REVIEW voegt 2 map-entries toe |
| Forgejo-client (generiek) | `src/git/forgejo-rest.ts`: `parseForgejoPrUrl:154`, `callForgejo:288`, `forgejoFetch:253`, `requireToken:217`, host-whitelist `:25` | bestaat — basis voor diff-fetch + review-post |
| PR-helpers | `src/git/pr.ts`: `listPullRequestFiles:311`, `getPullRequestState:264`, `createPullRequest:83` | bestaat — **geen** diff-fetch/review-post (nieuw) |
| Payload-assembly | `src/tools/wait-for-job.ts:681` `getFullJobContext`, idea-tak `:895-975` | bestaat — PR_REVIEW krijgt een eigen tak |
| Claim-routing standalone | `src/tools/wait-for-job.ts:320` `CLAIMABLE_STANDALONE_KINDS` | bestaat — **PR_REVIEW moet erbij** |
| Sink-patroon | `src/tools/update-idea-plan-reviewed.ts:17-92` (inputSchema + handler + register) | model voor `post_pr_review` |
| Done-handler MANUAL-exemptie | `src/tools/update-job-status.ts:738` (`source === 'MANUAL'` → done) | bestaat — dekt MANUAL PR_REVIEW |
| Job-target-veld | `ClaudeJob.pr_url` (scrum4me-shared schema; al gebruikt door task-PR's) | bestaat — target van de review |
| Runtime/capabilities op worker | docker `bin/run-one-job.ts` → `registerWorker`/`startHeartbeat` (Phase 1) | bestaat |
| Workers snapshot-override + gate | `actions/manual-jobs.ts` (codex `requested_model='codex-default'`, capability-gate), `lib/manual-jobs/templates.ts` | bestaat (Phase 1) |

## 4. Componenten (per repo, concreet)

### scrum4me-shared — *inspanning S · risico M (migratie-coördinatie)*
- `ClaudeJobKind` += `PR_REVIEW` (canonieke enum). Enum-add is **data-safe** (geen backfill). Schema-PR eerst, dan submodule-bump in mcp/docker/workers; **migratie draait in scrum4me-web** (designated migrator) — mcp/docker/workers doen alleen `prisma generate`. Dit is de enige cross-repo-coördinatiestap (bekend patroon, zie multi-worker-rollout).
- **Géén** nieuwe kolom (besluit: hergebruik `pr_url` + `summary`).

### scrum4me-mcp — *inspanning L · risico M (Forgejo-schrijfpad + CLI-divergentie)*
- **Nieuw `src/prompts/pr/review.codex.md`** — codex-portable PR-review-prompt (zie §5).
- **`src/lib/kind-prompts.ts`** — twee entries: `KIND_TO_PROMPT_PATH.PR_REVIEW = 'pr/review.md'` (Claude-fallback/placeholder) en `RUNTIME_PROMPT_OVERRIDES.CODEX.PR_REVIEW = 'pr/review.codex.md'`. `getKindPromptText` is al runtime-bewust; geen handtekening-wijziging. **Besluit voor de plan-fase:** lever een dunne `pr/review.md` Claude-variant zodat een per-ongeluk claude-enqueue niet leeg-draait (de template default + bedoeling is codex).
- **`src/git/pr.ts`** — twee nieuwe helpers bovenop `callForgejo`/`parseForgejoPrUrl`/`requireToken`:
  - `fetchPrDiff(prUrl)` → unified diff via de raw `.diff`-media-endpoint met **`forgejoFetch`** (text/plain — **niet** `callForgejo`, dat JSON parset; codex-review non-blocking). Fallback bij problemen: aggregeren uit `listPullRequestFiles` (JSON-patches).
  - `postPullRequestReview({ prUrl, event, body, commitId? })` → `requireToken()` + `callForgejo('POST', /repos/{owner}/{repo}/pulls/{index}/reviews, { body, event, commit_id? })`. `event` ∈ `{ APPROVED, REQUEST_CHANGES, COMMENT }` (exacte enum-strings tegen de live swagger pinnen; een foute waarde geeft 422 — de canary vangt dat).
- **`src/tools/wait-for-job.ts`** —
  - `CLAIMABLE_STANDALONE_KINDS` (`:320`) += `'PR_REVIEW'` zodat de claim-SQL een standalone PR_REVIEW-job (geen task/sprint) oppikt. (De payload-tak zelf staat op kind vóór de MANUAL-branch — zie hieronder.)
  - **Nieuwe PR_REVIEW-tak in `getFullJobContext`** (`:681`) — **plaats deze op kind vóór de generieke `if (job.source === 'MANUAL')`-branch** (`:775`, die op `:797-818` de generieke manual-payload returnt), ná de `config`/`doc_index`-setup. Een MANUAL PR_REVIEW zou anders die generieke branch raken en `pr`/`pr_diff`/`linked_plan` missen (codex-review P1). De tak: valideer `job.pr_url` → laad de review-instructie uit de manual-draft (`manual_draft.prompt_md` of een PR-specifiek input-veld uit `launch_preview_json` — **niet** `loadManualIdeaContext`, dat is idea-only; codex round-2 P3) → `fetchPrDiff` + een PR-meta-call (`GET /pulls/{index}` voor titel/branches/head-sha; `getPullRequestState:264` levert de merge-state — verifieer de return-shape bij implementatie) → plan/acceptatie-resolutie (§7) → payload `{ pr, pr_diff, linked_plan?, instruction, doc_index, config }`. `prompt_text` mag runtime-neutraal blijven (de runner is gezaghebbend, `wait-for-job.ts:957`).
- **Nieuw `src/tools/post-pr-review.ts`** + registratie in `src/register.ts` — de sink (zie §6).

### scrum4me-docker — *inspanning S · risico L*
- **`bin/run-one-job.ts`** — sla `attachWorktreeToJob` **over** voor `PR_REVIEW` (read-only; geen branch-checkout). Prompt-injectie (`getKindPromptText(ctx.kind, runtime).replace('$PAYLOAD_PATH', …)`) en runtime/capabilities zijn al Phase 1. Zorg dat de cleanup-tak ook geen worktree verwacht (`PR_REVIEW` → skip).
- Geen unit-harness (net als Phase 0/1) — verificatie via build + canary + code-review.

### scrum4me-workers — *inspanning M · risico laag*
- **Nieuw `pr-review`-template** (`lib/manual-jobs/templates.ts`): `kind: 'PR_REVIEW'`, velden `pr_url` (string, required, placeholder `https://git.jp-visser.nl/owner/repo/pulls/123`) + `instructie` (text, optioneel, default "Beoordeel codekwaliteit, architectuur-conformiteit, tests en docs"); `defaultRuntime: 'codex'`, `allowedRuntimes: ['claude','codex']`, `defaultCapability: 'review'`. Voeg `'PR_REVIEW'` toe aan het template-kind-union-type.
- **Draft-plumbing + enqueue** (`lib/manual-job-draft.ts`, `lib/manual-jobs/validation.ts`, `components/jobs/manual-job-draft-editor.tsx`, `actions/manual-jobs.ts`): de draft-keten persisteert vandaag géén `pr_url` (codex plan-review P1, round-2 aangescherpt) — voeg het veld toe over de hele keten, naar het bestaande taskId/ideaId-patroon: `MANUAL_JOB_KINDS += PR_REVIEW` (in **beide** modules — manual-job-draft.ts én validation.ts hebben elk een eigen array), `ManualJobDraftInput.prUrl` + zod-parseveld, `ManualJobValidationInput.prUrl` + PR_REVIEW-veldregels in `validateManualJobInput` (de échte validator achter `saveManualJobDraftAction` — zonder die update verwerpt save-draft het kind als onbekend), `ManualJobLaunchPreview.context.prUrl`, editor-mapping uit `inputValues.pr_url`, en in de enqueue een `readPrUrlFromLaunchPreview` (mirror van `readIdeaIdFromLaunchPreview`) die `ClaudeJob.pr_url` vult — verplicht voor PR_REVIEW, anders weigert de enqueue. Test het save→enqueue-pad end-to-end (save persisteert `context.prUrl`). Hergebruik de Phase-1-snapshot-override (codex → `requested_model='codex-default'`) en de capability-gate (`capabilities has 'review'`). PR_REVIEW is **niet** idea-gebonden: `isManualIdeaJobKind` dekt alleen `IDEA_*`, dus de idea-binding-guard blokkeert vanzelf niet.
- Job-board/worker-insights tonen runtime + `pr_url` al; geen nieuwe UI.

## 5. De codex-PR-review-prompt (`pr/review.codex.md`)

**Taak.** Lees uit de payload (`$PAYLOAD_PATH`): `pr` (meta), `pr_diff`, optioneel `linked_plan` (plan + acceptatiecriteria), `doc_index` (product-standaarden via `get_product_doc`/`search_product_docs`). Beoordeel de diff op: codekwaliteit, architectuur-/patroon-conformiteit (tegen de product-docs), tests, docs, en — als `linked_plan` aanwezig is — **plan-conformiteit** ("implementeert de diff het plan + de acceptatiecriteria correct?").

**Autonoom verdict (besluit 2):**
- **Beslisregel:** `event = 'APPROVED'` ⇔ geen blokkerende/`error`-severity findings én (indien gekoppeld) plan-conform; `event = 'REQUEST_CHANGES'` bij ≥1 blokkerende finding; anders `event = 'COMMENT'`.
- **Safe-default:** bij twijfel, een lege diff, of een niet-resolvebare PR → **nooit** `APPROVED`; kies `COMMENT` (of `REQUEST_CHANGES` met reden). Spiegelt Phase 1's "nooit stilzwijgend approven".
- Roept **`post_pr_review({ job_id, pr_url, event, body, review_log })`**, daarna `update_job_status({ job_id, status: 'done', summary })`.

**Output (besluit 3):** een **samenvattende markdown-body**: verdict-kop + findings-lijst, elke finding met severity + `bestand:regel` (in tekst). **Geen** inline-comments. Als `linked_plan` ontbrak: zet expliciet in de body "geen gekoppeld plan gevonden — beoordeeld op codekwaliteit + product-standaarden".

**Codex-portable** (zoals Phase 1): geen Claude-toolnamen (`Read`/`Write`/`Glob`/`Grep`) — alle context komt uit de payload + `mcp__scrum4me__*`-tools; geen `ask_user_question`/`get_question_answer`. De `review_log`-JSON wordt als passthrough aan de sink doorgegeven voor traceability.

## 6. Result-model & sink (`post_pr_review` — nieuw, model: `update_idea_plan_reviewed`)

Nieuw `src/tools/post-pr-review.ts`, geregistreerd als MCP-tool `post_pr_review`. Spiegelt `update_idea_plan_reviewed` (`:17-92`):

- **inputSchema:** `{ job_id: string, pr_url: string, event: 'APPROVED'|'REQUEST_CHANGES'|'COMMENT', body: string, commit_id?: string, review_log?: object (passthrough) }`.
- **Gedrag:**
  1. `requireWriteAccess()` + ownership-check (de job moet van de aanroepende worker/user zijn) **+ job-binding (codex plan-review P2):** de job moet `kind = PR_REVIEW` zijn én een opgeslagen `pr_url` hebben; een input-`pr_url` die afwijkt van `job.pr_url` wordt verworpen. De post gaat altijd naar `job.pr_url` — de sink is geen vrije post-API en kan niet cross-PR posten.
  2. `postPullRequestReview({ prUrl: job.pr_url, event, body, commitId: commit_id })` → Forgejo.
  3. **Forgejo-post mislukt → de tool FAALT** (geen stille review-verlies); de prompt laat dan de job falen (geen valse "done"). Analoog aan Phase 1's "plan-write-fout blokkeert approved".
  4. Schrijf een verdict-trace naar `ClaudeJob.summary` (`event` + 1-regel-samenvatting) en een log-entry voor auditbaarheid. **Geen** nieuwe kolom/idea-status.
- **Safe-default bewaakt in de prompt** (de tool post wat codex geeft); de prompt mag nooit `APPROVED` kiezen bij twijfel (§5).

*(Geen idee-status-machine voor PR's in Phase 2; de Forgejo-review-state ís de primaire sink, `summary` de DB-trace.)*

## 7. Plan/acceptatie-koppeling (besluit 4)

Best-effort resolutie in de PR_REVIEW-tak van `getFullJobContext`, in volgorde:

1. **Implementerende job** — zoek de job die deze PR heeft geopend, **exclusief de huidige review-job zelf**. De PR_REVIEW-job draagt dezelfde `pr_url` en is de nieuwste, dus een naïeve `findFirst({ where: { pr_url }, orderBy: created_at desc })` self-matcht en verliest het plan (codex-review P2). Filter op implementatie-dragers: `where: { pr_url, id: { not: job.id }, OR: [ { kind: 'TASK_IMPLEMENTATION', task_id: { not: null } }, { kind: 'SPRINT_IMPLEMENTATION', sprint_run_id: { not: null } } ] }`, nieuwste eerst. Accepteer dit pad **alleen** bij bruikbare plan-context (`plan_snapshot`, of via `task_id` → `Task.implementation_plan` + `Story.acceptance_criteria`, of sprint-task-snapshots); anders door naar (2).
2. **PBI-koppeling:** anders `prisma.pbi.findFirst({ where: { pr_url } })` → gekoppelde plan-doc / acceptatie.
3. **Geen koppeling:** `linked_plan` blijft leeg → de prompt reviewt op **diff + product-docs** en zet dat expliciet in de body.

`linked_plan` in de payload = `{ source: 'job'|'pbi'|null, plan_md?, acceptance_criteria?, plan_snapshot? }`. Alle paden zijn read-only; falen van een lookup degradeert gracieus naar (3), laat de job niet falen.

## 8. Canary & succescriteria (ná de Phase 2-PRs)

**Manual-enqueue-first** (bewijst meteen het echte pad, anders dan Phase 1's SYSTEM-seed):
1. Maak een **wegwerp-PR** op een testrepo onder `git.jp-visser.nl` (binnen `FORGEJO_HOSTS`) met een kleine, bewust-verbeterbare diff.
2. **Herbouw beide `agent-codex`-workers** (154 + max2) naar de nieuwe mcp-`main` mét de PR_REVIEW-prompt + `post_pr_review`-sink, en **laat een oude codex-worker eerst uitsterven** vóór de enqueue (154-review P3) — anders claimt een pre-Phase-2-worker en faalt op een onbekend kind of een ontbrekende sink.
3. Enqueue via de workers-UI (of een seed met `source=MANUAL`) een `PR_REVIEW`/`CODEX`-job met de `pr_url`. Claimer doorgaans max2 (HIGH_P).

**GO ⇔ alle:**
- job → **`DONE`** (bewijst de MANUAL-done-handler-tak `:738`, géén verify-gate-val);
- er staat een **Forgejo-review** op de PR met de verwachte `event` (`APPROVED`/`REQUEST_CHANGES`/`COMMENT`) + een samenvattende body met findings;
- bij een gekoppelde PR (een PR die door een eerdere implementatie-job is geopend): de body refereert aan plan/acceptatie; bij een ongekoppelde PR: de body zegt expliciet "geen gekoppeld plan";
- `ClaudeJob.summary` bevat de verdict-trace;
- 0 auth/MCP/Forgejo-fouten in de run-log; **geen hang**;
- de Claude-`worker-idea`-fleet liep ongestoord door; de codex-worker-rij adverteert `review`.

**NO-GO →** run-log vastleggen, fix-forward in de juiste repo (vrijwel zeker de prompt of het Forgejo-schrijfpad/`event`-enum), canary herhalen. Niet door naar Phase 3 tot DONE + review-op-PR bewezen.

## 9. Error-handling

- **Done-gate:** MANUAL PR_REVIEW raakt `update-job-status.ts:738` (`source === 'MANUAL'` → done, `skipWorktreeCleanup=true`) → **geen done-gate-wijziging nodig**. *(Een SYSTEM/ORCHESTRATOR PR_REVIEW zou de verify-gate raken; dat is Phase 4 — dán de exemptie zoals `IDEA_REVIEW_PLAN && SYSTEM` op `:754-756`.)*
- **PR niet resolvebaar / diff leeg** → job faalt met duidelijke reden (`pr_unresolvable`/`empty_diff`); geen lege review posten.
- **Forgejo-review-post mislukt** (4xx/5xx) → `post_pr_review` faalt → prompt faalt de job (`update_job_status('failed', …)`); geen valse "done".
- **`pr_url` buiten host-whitelist** → bestaande `FORGEJO_HOSTS`-guard (`forgejo-rest.ts:25`) blokkeert de call.
- **Idempotentie:** een re-enqueue post een *nieuwe* Forgejo-review (Forgejo staat meerdere reviews toe) — acceptabel; geen dedup in Phase 2.
- **Runner-niveau** (Phase 0): token-expiry/overload via `classifyCodexOutput` ongewijzigd.

## 10. Risico's & mitigatie

| Risico | Mitigatie |
|---|---|
| **Forgejo-schrijfpad nieuw** (review posten, `event`-enum, auth) | Hergebruik de bewezen `callForgejo`/`requireToken`/`parseForgejoPrUrl`; pin de `CreatePullReviewOptions.event`-strings tegen de live swagger; de canary post echt op een wegwerp-PR (een 422 = fout enum). |
| **Schema-coördinatie** (nieuw enum via scrum4me-web) | Bekend patroon (shared-PR → bump → web-migratie); enum-add is data-safe; mcp/docker/workers `prisma generate` only. |
| **Plan-koppeling onbetrouwbaar** (PR zonder implementerende job) | Best-effort met 3 fallbacks (§7); ongekoppeld degradeert naar diff + product-docs i.p.v. falen; de prompt is hier expliciet over. |
| **Diff-grootte / token-kosten** (grote PR's) | Manual-enqueue begrenst het volume (mens triggert bewust); grote-diff-truncatie/severity-sampling = latere optimalisatie (impact-rapport §8). |
| **Overlap met Phase 3 (impl-review)** | Bewust geaccepteerd (besluit 4); Phase 2 triggert op een PR + post op de PR; Phase 3's `TASK_REVIEW` triggert op task-done met een formeel verdict-veld. |
| **Blast-radius op Claude/bestaande kinds** | PR_REVIEW is additief: nieuw kind, nieuwe prompt, nieuwe tak/tool; bestaande paden byte-identiek; tests borgen dit. |

## 11. Test-strategie (TDD)

- **mcp (vitest):**
  - `kind-prompts`: `(PR_REVIEW, CODEX)` → `pr/review.codex.md`; `(PR_REVIEW, CLAUDE)` → `pr/review.md`; overige kinds ongewijzigd.
  - `pr.ts`: `fetchPrDiff` (Forgejo-call-shape + host/token) en `postPullRequestReview` (POST-pad + `event`-mapping + `requireToken`), met gemockte `callForgejo`/`forgejoFetch`.
  - `getFullJobContext` PR_REVIEW-tak: een **MANUAL** PR_REVIEW-job retourneert `pr`/`pr_diff`/`linked_plan` (níet de generieke manual-payload — borgt de plaatsing vóór de MANUAL-branch, codex-review P1); plan/acceptatie-resolutie met **current-job-self-match uitgesloten** + task-PR + sprint-PR + pbi-fallback + geen-koppeling (codex-review P2).
  - `post_pr_review`-sink: happy-path (post + summary-trace), `event`-mapping, **fail-on-Forgejo-error**, ownership-guard.
  - claim: `PR_REVIEW` in `CLAIMABLE_STANDALONE_KINDS` → een standalone PR_REVIEW-job is claimbaar.
- **workers (vitest):** `pr-review`-template + enqueue (codex `requested_model`-override, `pr_url` → job, capability-gate, geen idea-binding-eis).
- **docker:** geen unit-harness; verificatie via build + canary + code-review dat PR_REVIEW de worktree overslaat.
- **end-to-end:** de canary (§8) is de bindende gate.

## 12. Cross-repo volgorde & PR-plan

1. **shared-PR** (`feat/pr-review-kind`): `ClaudeJobKind += PR_REVIEW`. Codex-review (s4m-queue) → merge → submodule-bump-refs klaarzetten.
2. **mcp-PR** (`feat/codex-pr-review-phase2`): submodule-bump naar de shared-merge + `pr/review.codex.md` (+ dunne `pr/review.md`) + `kind-prompts`-entries + `pr.ts`-helpers + `getFullJobContext`-tak + `CLAIMABLE_STANDALONE_KINDS` + `post_pr_review`-tool + vitest. Codex-review → merge.
3. **docker-PR**: PR_REVIEW skip-worktree in `run-one-job.ts` (+ submodule-bump indien nodig). Pin `MCP_GIT_REF` op de mcp-branch tot die merget. Codex-review → merge.
4. **workers-PR**: `pr-review`-template + enqueue (`pr_url` → job) + snapshot-hergebruik + submodule-bump. Codex-review → merge.
5. **Canary** op 154 (manual-enqueue tegen een wegwerp-PR). Gegate; NO-GO = fix-forward.

Elke PR: codex-gereviewd plan/diff via de s4m-queue (`push --to mac:codex --type review_request`); merges door de gebruiker geautoriseerd; Forgejo-PR-acties via de API.

## 13. Out of scope (expliciet)

- Auto-dispatch (Forgejo-webhook → workers-endpoint → enqueue) + merge/advance-gating op het verdict → **Phase 4**.
- Inline per-regel review-comments (alleen samenvattende body in Phase 2).
- `SPEC_REVIEW` / `TASK_REVIEW`-kinds + result-sinks → **Phase 3**.
- Nieuwe DB-kolom (`review_verdict`/`review_job_id`) — hergebruik `pr_url` + `summary`.
- SYSTEM/ORCHESTRATOR `PR_REVIEW` + done-gate-exemptie → Phase 4.
- Runtime-aware `resolveJobConfig` in `@shared` + echte codex-model-ID's.
- Codex-enqueue-override-parity (`manual-jobs.ts` hard-block) — onveranderd, net als Phase 1.

## 14. Review-log

- **scrum4me-server:claude (154) — operationele verificatie: GO ✅** (2026-06-09, msg 23667835). Getoetst tegen de deployed mcp-clone op 154 (`/srv/scrum4me/repos/scrum4me-mcp` @ `eeee8c7`) + het live schema. Alle 5 load-bearing aannames bevestigd met regelnummers: `ClaudeJob.plan_snapshot:505`/`pr_url:509`, done-handler MANUAL-exemptie `update-job-status.ts:738`, `CLAIMABLE_STANDALONE_KINDS` `wait-for-job.ts:320` (mist PR_REVIEW — correct), Forgejo-client + PR-helpers, runtime-bewuste `getKindPromptText:42`. P3 (niet-blokkerend): dubbel-rebuild + oude-codex-laten-uitsterven vóór de canary-seed → verwerkt in §8.
- **mac:codex — bron-correctheid round-1: NO-GO → fixes verwerkt** (msg 75c0b768). 2 findings, beide geverifieerd tegen de bron en gegrond:
  - **P1:** een MANUAL PR_REVIEW raakt de generieke `if (job.source === 'MANUAL')`-branch (`wait-for-job.ts:775`, return `:797-818`) vóór de kind-specifieke takken → mist `pr`/`pr_diff`/`linked_plan`. Fix: de PR_REVIEW-tak op kind plaatsen **vóór** de MANUAL-branch + de instructie uit de draft laden + een regressietest (§3/§4/§11).
  - **P2:** de linked-job-lookup `findFirst({ where: { pr_url }, orderBy: created_at desc })` self-matcht de zojuist aangemaakte PR_REVIEW-job → verliest het plan. Fix: `id != job.id` + filter op implementatie-dragers (TASK_IMPLEMENTATION+task_id / SPRINT_IMPLEMENTATION+sprint_run_id) + alleen accepteren bij bruikbare plan-context, anders PBI-fallback (§7/§11).
  - Niet-blokkerend bevestigd: Forgejo `CreatePullReview`/`event`-shape, MANUAL-done-gate `:738`, CLAIMABLE_STANDALONE-vereiste `:320`, `fetchPrDiff` via `forgejoFetch` (raw `.diff`, niet `callForgejo`) — verwerkt in §4. Round-2-confirm aangevraagd.
- **mac:codex — round-2: GO ✅** (msg bcff3cc5). Beide round-1-fixes correct bevestigd (P1 branch-placement vóór de MANUAL-branch met regressie-dekking; P2 self-match-uitsluiting + implementatie-drager-filter + PBI/no-link-fallback met tests); geen resterende P1/P2. P3 (niet-blokkerend, verwerkt in §4): de PR_REVIEW-instructie uit `manual_draft.prompt_md` / een PR-specifiek input-veld halen, **niet** via `loadManualIdeaContext` (idea-only).
- **mac:codex — implementatieplan round-1: NO-GO → fixes verwerkt** (msg c94eb059). 4 findings, alle tegen de bron geverifieerd en gegrond:
  - **P1 (Task 9):** workers persisteert géén `pr_url` — `MANUAL_JOB_KINDS` mist PR_REVIEW, `ManualJobDraftInput`/`ManualJobLaunchPreview.context`/editor/enqueue kennen het veld niet → `ClaudeJob.pr_url` zou null zijn en de PR_REVIEW-payload-tak rolt elke claim terug. Fix: volledige plumbing naar het taskId/ideaId-patroon (draft-input + validatie + launch-preview + editor + `readPrUrlFromLaunchPreview` in de enqueue, met save→enqueue-tests). Verwerkt in §4 + plan Task 9.
  - **P2 (Task 5):** `Pbi.plan_md` bestaat niet — plan-content loopt via `PbiDoc(role=PLAN)` → `doc_revision.content_md`. Fallback-query + tests gefixt.
  - **P2 (Task 4):** `post_pr_review` postte naar caller-supplied `pr_url`. Nu: vereist `kind=PR_REVIEW` + opgeslagen `job.pr_url`, verwerpt mismatch, post naar `job.pr_url` (geen cross-PR posting); negatieve tests toegevoegd. Verwerkt in §6.
  - **P3 (Task 6):** `parseForgejoPrUrl().index` is een `number`; test verwachtte string `'42'` → numeriek contract aangehouden.
  Round-2-confirm aangevraagd.
- **mac:codex — implementatieplan round-2: NO-GO → fix verwerkt** (msg a2aaa472). Round-1-fixes voor Task 4/5/6 + de prUrl-keten bevestigd; 1 resterende **P1**: de échte validator zit in `lib/manual-jobs/validation.ts` (eigen `MANUAL_JOB_KINDS:41` + `ManualJobValidationInput:36-37` + veldregels `:94-98`), waar `parseManualJobDraftInput` → `validateManualJobInput` naartoe delegeert — zonder die module af te dekken verwerpt `saveManualJobDraftAction` (`actions/manual-job-drafts.ts:32`) PR_REVIEW als onbekend jobtype vóór de enqueue. Geverifieerd tegen de bron; Task 9 uitgebreid met validation.ts-wijzigingen (changes 6-8), validatie-tests en een save-draft-test die `launch_preview_json.context.prUrl` persisteert. Round-3-confirm aangevraagd.
