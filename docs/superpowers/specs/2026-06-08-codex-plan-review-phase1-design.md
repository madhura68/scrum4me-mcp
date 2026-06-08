---
title: "Phase 1 — plan-review op codex — Design"
status: approved
audience: [ maintainer, ai-agent ]
language: nl
last_updated: 2026-06-08
scope: [ scrum4me-mcp, scrum4me-docker, scrum4me-workers ]
depends_on: "Phase 0 — codex-runner-substrate (scrum4me-docker docs/superpowers/specs/2026-06-07-codex-runner-substrate-phase0-design.md)"
parent: "Impact report — Codex-als-worker voor alle reviews §9 (scrum4me-workers docs/superpowers/specs/2026-06-07-codex-review-worker-impact-report.md)"
---

# Phase 1 — plan-review op codex — Design

**Doel.** Een codex-fleet-worker (`agent-codex`, Phase 0) draait `IDEA_REVIEW_PLAN`-jobs als een **autonome actieve-verbeteraar**: het reviewt + herschrijft het Claude-gemaakte plan in drie rondes, legt zelf een verdict vast via de bestaande sink `update_idea_plan_reviewed`, en blokkeert niet op een mens. Admin-selecteerbaar in de workers-UI, bewezen via een seed-canary op host 154.

**Waarom dit de eerste echte review is.** Het kind, de prompt-vorm, de payload én de sink bestaan al (Claude-variant). Phase 1 voegt een codex-portable promptvariant + runtime-bewuste promptselectie toe en zet het UI-pad open — **geen schema-wijziging, geen DB-migratie, geen shared-wijziging, Claude's eigen plan-review ongemoeid**. Daarmee is dit de laagste-risico-fase die de zwaardere codex-MCP-schrijftools (`update_idea_plan_md`/`update_idea_plan_reviewed`) bewijst bovenop de Phase 0-substrate (die alleen het lees-pad `list_products` bewees).

## Besluitenlog (deze brainstorm)

1. **Reikwijdte = Volledig + UI** (Approach B): mcp (prompt + selectie + tests + seed) + docker (runtime doorgeven) + workers (template/gate/snapshot) + canary. Niet "alleen seed" (A) en niet de gedeelde-prompt-refactor (C).
2. **Review-model = actieve verbeteraar, autonoom**: codex herschrijft het plan (3 rondes, persisteert via `update_idea_plan_md`) én legt zelf het verdict vast — **zonder** de `ask_user_question`-mens-gate. (Bewust geaccepteerd dat de auteur/reviewer-rollen licht vermengen; dat is de prijs van "actieve verbeteraar" t.o.v. "zuiver onafhankelijk oordeel".)
3. **Codex-enqueue-override-parity = uitgesteld**: de bestaande harde block "geen codex-worker online → kan niet queuen" (`manual-jobs.ts:87-88`) blijft in Phase 1 staan; de canary heeft toch een online `agent-codex`. Parity-override is een latere, op zichzelf staande workers-tweak.
4. **Cross-repo PR-volgorde = mcp → docker → workers → canary** (zie §12).

## 1. Voorwaarde (Phase 0 — VERVULD)

Phase 1 bouwt op de Phase 0-substrate. **Status: LIVE** (geverifieerd 2026-06-08 via de scrum4me-server:claude operationele review + docker `origin/master`):
- Phase 0 is gemerged op `scrum4me-docker` master (`ee8c647`): multi-stage Dockerfile (`base`/`codex`/`claude`), `agent-codex`-service (`docker-compose.yml:106`, `SCRUM4ME_WORKER_RUNTIME: CODEX`), runtime-tak in `bin/run-one-job.ts`, `config.toml` met `[mcp_servers.scrum4me]` + env_vars-forwarding, dedicated `/home/agent/.codex`-mount.
- `agent-codex` draait op **154 (LOW_P)** én **max2 (HIGH_P)**; de read-only Phase 0-canary (`PLAN_CHAT` → `list_products`) is **DONE** (geclaimd door codex op max2).

De §1-voorwaarde is dus **vervuld**: de Phase 1-canary (§8) kan draaien zodra de Phase 1-code-PRs (mcp/docker/workers) landen. (NB: dit corrigeert de eerdere aanname dat Phase 0 nog open stond — Phase 0 is afgerond sinds de vorige sessie.)

## 2. Scope

**IN**
- Codex-portable promptvariant voor `IDEA_REVIEW_PLAN` (autonoom, geen mens-gate, 3-ronde-herschrijf behouden).
- Runtime-bewuste promptselectie in mcp (`getKindPromptText(kind, runtime)`), consumed door de docker-runner.
- Workers-UI: `idea-review-plan`-template codex-selecteerbaar + niet-misleidend codex-snapshot + gate aan.
- Seed-script + canary op 154; daarna het UI-pad.

**OUT** (expliciet, zie §13)
- Spec-/PR-/task-review (fase 2-3), auto-dispatch + gating (fase 4).
- Wijziging aan Claude's bestaande `IDEA_REVIEW_PLAN`-gedrag (de gate blijft voor Claude).
- Schema-wijziging, DB-migratie, `scrum4me-shared`-wijziging.
- Runtime-aware `resolveJobConfig` (woont in `@shared`; vermeden — codex negeert model/turns/tools tóch). Cosmetisch snapshot via workers-only override.
- Codex-enqueue-override-parity (besluit 3).

**Cross-model.** Author/implement = Claude (`IDEA_MAKE_PLAN`), review/verbeter = Codex. Phase 1 accepteert bewust dat codex het plan muteert (besluit 2); de zuiverdere "judge-only"-variant is een mogelijke latere keuze, geen Phase 1-werk.

## 3. Architectuur & data-flow

Hergebruikt de bestaande job-levenscyclus volledig; alleen de **promptselectie** wordt runtime-bewust.

```
enqueue (workers-UI of seed-script)
  → ClaudeJob{ kind: IDEA_REVIEW_PLAN, runtime: CODEX, source: MANUAL|SYSTEM, status: QUEUED }
  → agent-codex claimt        [runtime-filter: wait-for-job.ts:362 — parameterized cj.runtime = ${input.runtime}::AgentRuntime]
  → wait_for_job payload      [IDEA_REVIEW_PLAN-tak: wait-for-job.ts:870-943 → idea/plan_md/grill_md/doc_index/worktree]
  → runner kiest prompt       [getKindPromptText(ctx.kind, runtime) → codex-variant]   ← NIEUW (runtime-arg)
  → codex exec                [buildCodexArgs, Phase 0]
  → 3 rondes review+herschrijf → update_idea_plan_md per ronde      [bestaande tool]
  → autonoom verdict          → update_idea_plan_reviewed({idea_id, review_log, approval_status})  [bestaande sink]
  → idea → PLAN_REVIEWED | PLAN_REVIEW_FAILED + plan_review_log + IdeaLog(PLAN_REVIEW_RESULT)
  → update_job_status(done)    [géén ask_user_question; niet-blokkerend]
```

**Wat al bestaat (gegrond, scrum4me-mcp @ origin/main 247c85e):**

| Onderdeel | Locatie | Status |
|---|---|---|
| `IDEA_REVIEW_PLAN`-kind | `prisma/schema.prisma:149` (`ClaudeJobKind`) | bestaat |
| Claude-prompt | `src/prompts/idea/review-plan.md` | bestaat (3-ronde + `ask_user_question`-gate) |
| Promptselectie | `src/lib/kind-prompts.ts:34` `getKindPromptText(kind)`, `:46` `getIdeaPromptText(kind)` | **kind-only** (cache op kind) |
| Payload-assembly | `src/tools/wait-for-job.ts:870-943` | bestaat (idea/grill/plan/worktree) |
| Sink | `src/tools/update-idea-plan-reviewed.ts:17-126`, geregistreerd `src/register.ts:49` | bestaat |
| Runtime-routing | `AgentRuntime` (`schema.prisma:29-32`), `ClaudeJob.runtime` (`:481`), claim-filter (`wait-for-job.ts:362`), `getWorkerRuntimeFromEnv` (`src/worker-runtime.ts`) | bestaat (Phase 0) |
| Codex-substrate-libs | `src/lib/codex-args.ts`, `src/lib/codex-output.ts`, `scripts/seed-codex-canary.ts` | bestaat (PR #41, `a9b6125`) |

## 4. Componenten (per repo, concreet)

### scrum4me-mcp — *inspanning M · risico L*
- **Nieuw `src/prompts/idea/review-plan.codex.md`** — codex-portable promptvariant (zie §6).
- **`src/lib/kind-prompts.ts`** — `getKindPromptText(kind, runtime?: WorkerRuntime)` + `getIdeaPromptText(kind, runtime?)` runtime-bewust:
  - cache-key wordt compound (`${kind}:${runtime}`) i.p.v. alleen `kind`;
  - `(IDEA_REVIEW_PLAN, CODEX)` → `idea/review-plan.codex.md`; **alle andere (kind, runtime)-combinaties → ongewijzigd** (default `CLAUDE`, bestaande paden).
  - `runtime` default `'CLAUDE'` zodat bestaande call-sites zonder arg identiek blijven.
- **Tests (vitest)** — selectie: `(IDEA_REVIEW_PLAN, CODEX)` → codex-pad; `(IDEA_REVIEW_PLAN, CLAUDE)` en alle overige kinds → bestaande paden; default-arg = CLAUDE.
- **Nieuw `scripts/seed-idea-review-codex-canary.ts`** — maakt een throwaway PLAN_READY-idee + een `IDEA_REVIEW_PLAN`/`CODEX`/`QUEUED`/`SYSTEM`-job. Patroon = `scripts/seed-codex-canary.ts`; alleen-inserts, geen deletes. **Het geseede `plan_md` + `grill_md` moeten substantieel en bewust-verbeterbaar zijn** (niet de quasi-lege Phase 0-seed), zodat de 3-ronde-herschrijf echt bijt en het GO-criterium "plan_md daadwerkelijk herzien" (§8) ondubbelzinnig is (154-review P2-2).

### scrum4me-docker — *inspanning S · risico L*
- **`bin/run-one-job.ts`** — geef de runtime door aan de promptselectie: `getKindPromptText(ctx.kind, runtime)` (Phase 0's `runtime`-var bestaat al in deze functie; ~1 regel).
- **Planning-check (P1 voor het plan):** bevestig of de **runner** de prompt kiest via `getKindPromptText(ctx.kind)` (zoals de Phase 0-plan-grounded-facts stellen) **of** dat `payload.prompt_text` uit `getFullJobContext`/`getIdeaPromptText` gezaghebbend is. Het runtime-arg moet landen op de daadwerkelijk-gebruikte selectie. Als beide bestaan: maak ze consistent (beide runtime-bewust) of kies de runner-prompt als bron.

### scrum4me-workers — *inspanning S · risico laag*
- **`lib/manual-jobs/templates.ts:343`** — `allowedRuntimes: [DEFAULT_MANUAL_RUNTIME, 'codex']` voor **alléén** de `idea-review-plan`-template (id `:336`, kind `:341`); `defaultRuntime` blijft claude.
- **`actions/manual-jobs.ts:98`** — codex-snapshot-override (workers-only, géén `@shared`-wijziging): na `snapshotFromConfig(resolveJobConfig({kind: draft.kind}, product))`, bij `draft.runtime === 'CODEX'` overschrijf `model_id` naar een codex-label (`'codex-default'`). `ClaudeJob.model_id` is een vrije `String?` (`schema.prisma:496`) → geen migratie. Spiegel dezelfde override in `actions/orchestrator-jobs.ts:104` **niet** (orchestrator-jobs zijn PLAN_CHAT/claude — buiten Phase 1-scope).
- **`SCRUM4ME_ENABLE_CODEX_WORKERS=true`** op de workers-env (gate-check in `lib/codex-runtime-gate.ts`).
- **Niet** wijzigen: de codex-hard-block (`manual-jobs.ts:87-88`) — besluit 3.

## 5. De codex-review-prompt (`review-plan.codex.md`)

**Behoudt** (gelijk aan de Claude-prompt):
- Setup: lees `plan_md` + `grill_md`; laad codex uit `doc_index` (`get_product_doc`/`search_product_docs`) + repo-`docs/patterns`/`docs/architecture` + `CLAUDE.md`.
- Drie rondes (structuur / logica & patronen / risico & edge-cases), actieve herschrijf van `plan_md` + persist via `update_idea_plan_md` per ronde, convergentie (<5% wijziging over 2 rondes), `review_log`-JSON-format.

**Vervangt de approval-gate door een autonoom verdict** (besluit 1/2):
- **Beslisregel:** `approval_status = 'approved'` ⇔ het plan is **geconvergeerd** én er staan **geen `error`-severity issues** open na de laatste ronde; anders `'rejected'`.
- Roept `update_idea_plan_reviewed({ idea_id, review_log, approval_status })` met dat verdict; daarna `update_job_status({ job_id, status: 'done', summary })`.
- **Geen** `ask_user_question`/`get_question_answer`/`list_open_questions`/`cancel_question` in de codex-flow.

**Codex-portable** (verschillen met de Claude-prompt):
- **Geen Claude-toolnamen** (`Read`/`Write`/`Glob`/`Grep`): formuleer file-toegang generiek ("lees de relevante repo-bestanden in de werkmap"). Codex heeft eigen file-ops in de `workspace-write`-sandbox (Phase 0 `config.toml`).
- De `mcp__scrum4me__*`-namespace blijft identiek (werkt onder codex per `codex-scrum4me-mcp-access-plan.md`).
- Persona/format codex-vriendelijk; het strikte `review_log`-JSON-contract blijft hetzelfde zodat de sink ongewijzigd kan blijven.

## 6. Result-model & sink (hergebruik, ongewijzigd)

`update_idea_plan_reviewed` (`src/tools/update-idea-plan-reviewed.ts:17-126`):
- input `{ idea_id, review_log (passthrough JSON), approval_status?: 'pending'|'approved'|'rejected' }`;
- `approval_status === 'approved'` → `Idea.status = PLAN_REVIEWED`; **anders** → `PLAN_REVIEW_FAILED`;
- schrijft `Idea.plan_review_log` (= `review_log`) + `reviewed_at` + een `IdeaLog`-entry (`PLAN_REVIEW_RESULT`).

De autonome beslisregel mapt dus rechtstreeks op de bestaande binaire transitie; **geen sink-wijziging nodig**. (Er is geen aparte `CHANGES_REQUESTED`-status — `rejected → PLAN_REVIEW_FAILED` dekt "verbeteringen nodig". Omdat codex het plan al actief herschrijft, is `approved` na convergentie het normale happy-path.)

## 7. Surfacing

Geen nieuwe UI nodig. Het verdict landt op `Idea` (status + `plan_review_log`) en op de job (`source/runtime/summary` op het job-board). De job-runtime (`CODEX`) en het codex-snapshot-label tonen al via de bestaande job-board-/worker-insights-mappers.

## 8. Canary & succescriteria (ná de Phase 1-PRs)

Phase 0 draait al (§1); de canary bewijst alleen de **Phase 1-prompt + de schrijftools-keten** end-to-end.

**Seed-first** (canary-discipline, net als Phase 0):
1. Seed centraal tegen de DB: `CANARY_PRODUCT_ID=cmopqumt9000004joksfaf3wc npx tsx scripts/seed-idea-review-codex-canary.ts` → een `IDEA_REVIEW_PLAN`/`CODEX`/`QUEUED`-job met een **rijk, verbeterbaar** `plan_md`+`grill_md`. (`cmopqumt9000004joksfaf3wc` = scrum4me-docker, ook in Phase 0 gebruikt, niet-verstorend; 154-review-advies.)
2. Geen rescale nodig — `agent-codex` draait al op scale 1 op 154 én max2 (154-review P3-1). **Claimer-tier (154-review P2-1):** een centraal geseede CODEX-job wordt geclaimd door de eerste vrije `agent-codex` — doorgaans **max2 (HIGH_P)**, precies zoals de Phase 0-canary. Elke `agent-codex` bewijst de prompt; is 154-lokaal bewijs vereist, forceer dan via `required_capability=LOW_P` of pauzeer max2 tijdelijk.

**GO ⇔ alle:**
- job → `DONE`;
- idea → `PLAN_REVIEWED` (of `PLAN_REVIEW_FAILED` mét reden in `plan_review_log`);
- `plan_review_log` gevuld (rondes + convergence + summary);
- `plan_md` is **substantieel herzien** t.o.v. de (rijke) seed-versie — zichtbare `update_idea_plan_md`-schrijf, géén triviale convergentie-op-ronde-0;
- 0 auth/MCP-fouten in de run-log; **geen hang** (geen wachten op een mens);
- de Claude-`worker-idea`-fleet liep ongestoord door.

**Daarna UI-pad:** zet `SCRUM4ME_ENABLE_CODEX_WORKERS=true` op de workers/web-env (gate in `lib/codex-runtime-gate.ts`; de seed-canary heeft dit niet nodig, het UI-pad wél — 154-review P3-2), dan queue't een admin `idea-review-plan` met runtime=codex → identiek resultaat (bewijst template/gate/snapshot).

**NO-GO →** run-log vastleggen, fix-forward in de juiste repo (vrijwel zeker de codex-prompt), canary herhalen. Niet door naar fase 2 tot de canary `DONE` is.

## 9. Error-handling (codex-prompt)

- **Plan parse-fout** → `update_job_status('failed', error: 'plan_parse_failed')`, stop.
- **`update_idea_plan_md` mislukt** → log in `review_log`, ga door met de review (niet fataal) — gelijk aan de Claude-prompt.
- **Geen vraag-timeout-pad meer** (gate verwijderd). Bij een onverwacht onvolledige review: schrijf het partiële `review_log` weg via `update_idea_plan_reviewed` met `approval_status: 'rejected'`.
- Runner-niveau (Phase 0): token-expiry/overload via `classifyCodexOutput` → exit 3/4 + rollbackClaim (ongewijzigd).

## 10. Risico's & mitigatie

| Risico | Mitigatie |
|---|---|
| **Prompt-portabiliteit onder codex** — de zwaardere schrijftools (`update_idea_plan_md`/`update_idea_plan_reviewed`) + codex' eigen file-ops i.p.v. Claude Read/Glob | De Phase 1-canary **is** de gate hiervoor; enig aanpassingspunt = `review-plan.codex.md`. Phase 0 bewees al de MCP-init + een lees-tool. |
| Codex herschrijft het plan anders dan Claude (kwaliteit/format-drift) | Strikt `review_log`-JSON-contract behouden; convergentie-/error-severity-regel begrenst; canary inspecteert het herziene `plan_md`. |
| Misleidend model-snapshot op een codex-job | Workers-only `model_id`-override (`'codex-default'`), geen migratie. |
| Twee promptbronnen (runner vs payload) raken uit sync | Planning-P1 (§4 docker): bevestig de gezaghebbende bron en maak die runtime-bewust. |
| Blast-radius op Claude | Runtime-bewuste selectie raakt **alleen** `(IDEA_REVIEW_PLAN, CODEX)`; Claude-prompt + alle andere paden byte-identiek; tests borgen dit. |

## 11. Test-strategie

- **mcp (vitest):** promptselectie (kind×runtime → juist pad; default CLAUDE ongewijzigd; codex-variant alleen voor `IDEA_REVIEW_PLAN`). TDD per `superpowers:test-driven-development`.
- **docker:** geen unit-harness (net als Phase 0) — verificatie via de multi-stage build + de canary + code-review dat het runtime-arg de gebruikte selectie raakt.
- **workers:** bestaande test-suite groen (`npm run verify`); template-/snapshot-wijziging is klein en typed.
- **end-to-end:** de 154-canary (§8) is de bindende gate.

## 12. Cross-repo volgorde & PR-plan

1. **mcp-PR** (`feat/codex-plan-review-phase1`): `review-plan.codex.md` + runtime-bewuste `getKindPromptText`/`getIdeaPromptText` + vitest + seed-script. Codex-review (s4m-queue) → merge.
2. **docker-PR**: 1-regel runtime-doorgifte in `run-one-job.ts` (+ eventueel de prompt-bron-consolidatie uit §4). Pint `MCP_GIT_REF` op de mcp-branch tot die merget. **Build-gotcha (154-review P3-3):** bouw de `agent-codex`-service zónder een `--target`-flag (de target staat in de compose-service-def) en mét cache-bust, anders blijft de mcp-clone-laag gecached en faalt `docker compose build --target codex` op een unknown flag. Codex-review → merge.
3. **workers-PR**: `idea-review-plan`-template `allowedRuntimes` + codex-snapshot-override + gate-env. Codex-review → merge.
4. **Canary** op 154 (ná Phase 0 live): seed → UI. Gegate; NO-GO = fix-forward.

Elke PR: codex-gereviewd plan/diff via de s4m-queue (`push --to mac:codex --type review_request`); merges door de gebruiker geautoriseerd; Forgejo-PR-acties via de API.

## 13. Out of scope (expliciet)

- `SPEC_REVIEW` / `TASK_REVIEW` / `PR_REVIEW`-kinds + `post_pr_review`-Forgejo-sink (fase 2-3).
- Auto-dispatch (status-hooks / Forgejo-webhook) + merge/advance-gating (fase 4).
- Judge-only (niet-herschrijvende) review-variant.
- Claude's `IDEA_REVIEW_PLAN`-gedrag wijzigen (de mens-gate blijft voor Claude).
- Runtime-aware `resolveJobConfig` in `@shared` + echte codex-model-ID's in het `ClaudeModel`-type.
- Codex-enqueue-override-parity (`manual-jobs.ts:87-88`).

## 14. Review-log

- **scrum4me-server:claude (154) — operationeel: GO ✅** (2026-06-08, msg d081c386). Getoetst tegen deployed `origin/main 247c85e` = de live HEAD; geen P1. Verwerkt: Phase-0-live-correctie (§1), rijk seed-`plan_md` (§4/§8, P2-2), claimer-tier-notitie (§8, P2-1), no-op rescale (§8, P3-1), UI-gate-env (§8, P3-2), build-zonder-`--target` (§12, P3-3), parameterized claim-filter-nit (§3, P3-4), product_id-advies (§8).
- **mac:codex — bron-correctheid: opnieuw aangevraagd.** Eerste aanvraag faalde op scoping: `cwd` was alleen de mcp-worktree, terwijl de verificatie ook `scrum4me-workers`-bestanden raakt, en codex werkt strikt binnen de gedeclareerde `cwd`. Heraanvraag met `cwd` = de gemeenschappelijke parent (`/Users/janpetervisser/Development`) zodat zowel de mcp-worktree als `scrum4me-workers` leesbaar zijn.
