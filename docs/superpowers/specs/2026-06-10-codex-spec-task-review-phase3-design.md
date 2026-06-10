---
title: "Phase 3 — spec- + implementatie-review op codex — Design"
status: draft
audience: [ maintainer, ai-agent ]
language: nl
last_updated: 2026-06-10
scope: [ scrum4me-shared, scrum4me-mcp, scrum4me-workers, Scrum4Me ]
depends_on: "Phase 2 — PR-code-review op codex (scrum4me-mcp docs/superpowers/specs/2026-06-09-codex-pr-review-phase2-design.md)"
parent: "Impact report — Codex-als-worker voor alle reviews §9 (scrum4me-workers docs/superpowers/specs/2026-06-07-codex-review-worker-impact-report.md)"
---

# Phase 3 — spec- + implementatie-review op codex — Design

**Doel.** Twee nieuwe **judge-only** review-kinds op de codex-fleet-substraat:
- **`SPEC_REVIEW`** — beoordeelt een spec-document (ProductDoc, folder SPECS) op volledigheid, interne consistentie, ambiguïteit en scope tegen de product-standaarden.
- **`TASK_REVIEW`** — onafhankelijke implementatie-review van een task-diff tegen het plan + de acceptatiecriteria, náást (niet in plaats van) de verify-zelfcheck van de implementer.

Beide schrijven verdict + findings naar één nieuwe generieke **`ReviewLog`**-tabel. Advisory: geen status-driving, geen gating (Phase 4); trigger = manual-enqueue uit de workers-UI (auto-dispatch = Phase 4). Reviewer-identiteit = de bestaande bot `s4m-codex-reviewer` (Phase 2). Geen worktree — puur API/DB-werk.

## Besluitenlog (deze brainstorm)

1. **Scope = één spec, gestaffelde uitvoering**: één ontwerp + **één schema-PR met béide enum-waarden** (de migrator-cyclus is duur — Phase 2-les), uitvoering in twee slices met elk een eigen canary: eerst SPEC_REVIEW (nieuw artefact-type), dan TASK_REVIEW.
2. **Verdict-opslag = één generieke `ReviewLog`-tabel** (niet per-artefact JSON-kolommen, niet alleen job-summary): volledige herreview-historie, polymorf target, één queryplek voor Phase 4-gating.
3. **Semantiek = judge-only voor beide** (Phase 2-stijl): codex muteert het artefact niet; verdict + findings naar de ReviewLog; mens (of een aparte job) verwerkt findings. Géén doc-write-tools voor codex in deze fase.
4. **Aanpak = A, generieke review-pijplijn**: één job-gebonden sink-tool `submit_review` (target uit de jób), per kind een codex-prompt + payload-tak; TASK_REVIEW-diff via de Forgejo compare-API (geen worktree).

## 1. Voorwaarden (Phase 0/1/2 — VERVULD)

- Substrate + plan-review + PR-review zijn live (zie de Phase 1/2-specs). Relevant hergebruik: runtime-bewuste promptselectie (`getKindPromptText(kind, runtime)`), capability-advertentie + UI-gate, codex-snapshot-override, de **bot-identiteit `s4m-codex-reviewer`** (PAT in `worker-codex.env` + `config.toml` `env_vars`-allowlist), de Forgejo-client, en de canary-mechaniek inclusief de **migrator-volgorde-regel** (DB-migratie vóór worker-rebuild, anders 22P02-crash-loop).
- Basis: scrum4me-mcp `origin/main` **`65f0197`**, scrum4me-shared `47fcd51`, docker master `2b89635`, workers main `969e25c`, web main `f7fe64d`.

## 2. Scope

**IN**
- shared: `ClaudeJobKind` += `SPEC_REVIEW` + `TASK_REVIEW`; nieuwe `ReviewLog`-tabel; `ClaudeJob.doc_id` (nullable FK ProductDoc). Educatie: migratie via Scrum4Me (designated migrator), één cyclus.
- mcp: 2 codex-prompts + dunne Claude-fallbacks + kind-prompts-registratie; 2 payload-takken in `getFullJobContext` (vóór de MANUAL-branch); compare-diff-helper (`fetchCompareDiff`); sink-tool `submit_review`; beide kinds in `CLAIMABLE_STANDALONE_KINDS`.
- workers: `spec-review`- + `task-review`-templates + de bijbehorende target-ketens (doc-slug → `doc_id`; bestaande task-picker → `task_id`), naar de Phase-2-keten-discipline.
- Canary A (spec) + canary B (task) op de bestaande mechaniek.

**OUT** (expliciet, zie §13)
- Gating/status-driving op verdicts (Task.status `REVIEW`/doc-status blijven onaangeraakt) → Phase 4.
- Auto-dispatch/triggers → Phase 4.
- Actief herschrijven van het artefact (judge-only — besluit 3).
- PR_REVIEW-migratie naar de ReviewLog (kan een latere uniformerings-pass worden).
- ReviewLog-weergave in de workers-UI (volgt los; de tabel is de bron).
- Reviews van repo-bestanden (`docs/superpowers/specs/*.md` op schijf) — Phase 3 reviewt **ProductDocs**; repo-specs gaan via het bestaande s4m-queue-pad.

## 3. Architectuur & data-flow

```
enqueue (workers-UI /jobs/new: spec-review met doc_slug | task-review met task)
  → ClaudeJob{ kind: SPEC_REVIEW|TASK_REVIEW, runtime: CODEX, source: MANUAL, status: QUEUED,
               doc_id (spec) | task_id (task) }
  → agent-codex claimt        [CLAIMABLE_STANDALONE_KINDS += beide kinds]
  → getFullJobContext         [nieuwe kind-takken VÓÓR de MANUAL-branch (Phase 2-patroon)]
        SPEC_REVIEW: doc-content (huidige revisie) + doc-meta + doc_index + instruction
        TASK_REVIEW: plan/acceptatie (+ sprint-executie-snapshot) + diff (compare-API) + doc_index + instruction
  → runner kiest prompt       [getKindPromptText(kind, CODEX) → spec/review.codex.md | task/review.codex.md]
  → codex beoordeelt → verdict (APPROVED|CHANGES_REQUESTED|REJECTED) + findings
  → submit_review({ job_id, verdict, findings, summary })   ← NIEUWE generieke sink
        → INSERT ReviewLog (target uit de job; doc-revisie vastgepind)
        → ClaudeJob.summary = verdict-trace (incl. findings-telling)
  → update_job_status(done)   [source=MANUAL → DONE zonder verify-gate, bewezen in Phase 2]
```

**Wat al bestaat (gegrond):**

| Onderdeel | Locatie | Status |
|---|---|---|
| ProductDoc + revisies + SPECS-folder | shared `prisma/schema.prisma:627-683` (`ProductDoc`, `ProductDocRevision`, folder-enum) | bestaat; doc-status is VarChar (draft/active/deprecated/archived); audit-precedent `ProductDocLog:780-795` |
| Task + plan + acceptatie | `Task:413-448` (`implementation_plan`, status-enum mét ongebruikt `REVIEW`), `Story.acceptance_criteria` | bestaat |
| Sprint-executie-snapshots | `SprintTaskExecution:551-575` (`plan_snapshot`, `base_sha`/`head_sha`, `verify_result`) | bestaat (Phase 2 gebruikt ze al in `resolvePrLinkedPlan`) |
| Diff-bronnen | `ClaudeJob.base_sha/head_sha` (claim/push), `pr_url`; executie-sha's per sprint-task | betrouwbaar gevuld (verify-tools vullen lazy bij) |
| Verify-zelfcheck (≠ deze review) | `verify_task_against_plan`, `verify_sprint_task`, `checkVerifyGate` (`update-job-status.ts:261-305`) | bestaat — TASK_REVIEW is het onafhankelijke oordeel ernaast |
| Sink-patroon (job-gebonden) | `src/tools/post-pr-review.ts` (Phase 2: kind-check + target-uit-job + fail-on-error + summary-trace) | model voor `submit_review` |
| Payload-tak-patroon | `wait-for-job.ts` PR_REVIEW-tak vóór MANUAL-branch; `CLAIMABLE_STANDALONE_KINDS` | model voor beide takken |
| Forgejo-client | `src/git/forgejo-rest.ts` (`forgejoFetch`/`callForgejo`), `src/git/pr.ts` (`fetchPrDiff`) | basis voor `fetchCompareDiff` |
| Manual-enqueue-keten | workers Phase 2: kinds-arrays ×2, validatie, launch-preview-context, editor-rehydratie, context-patch-guard, enqueue-guard | patroon voor doc_slug/task-ketens |

## 4. Schema (scrum4me-shared → migratie via Scrum4Me)

```prisma
enum ClaudeJobKind {
  // … bestaande waarden …
  SPEC_REVIEW
  TASK_REVIEW
}

enum ReviewVerdict {
  APPROVED
  CHANGES_REQUESTED
  REJECTED
}

model ReviewLog {
  id                       String         @id @default(cuid())
  review_job               ClaudeJob      @relation(fields: [review_job_id], references: [id], onDelete: Cascade)
  review_job_id            String
  kind                     ClaudeJobKind
  product                  Product        @relation(fields: [product_id], references: [id], onDelete: Cascade)
  product_id               String
  doc                      ProductDoc?    @relation(fields: [doc_id], references: [id], onDelete: SetNull)
  doc_id                   String?
  doc_revision             ProductDocRevision? @relation(fields: [doc_revision_id], references: [id], onDelete: SetNull)
  doc_revision_id          String?
  task                     Task?          @relation(fields: [task_id], references: [id], onDelete: SetNull)
  task_id                  String?
  sprint_task_execution    SprintTaskExecution? @relation(fields: [sprint_task_execution_id], references: [id], onDelete: SetNull)
  sprint_task_execution_id String?
  verdict                  ReviewVerdict
  findings                 Json
  summary                  String         @db.Text
  created_at               DateTime       @default(now())

  @@index([product_id, kind, created_at])
  @@index([doc_id, created_at])
  @@index([task_id, created_at])
  @@map("review_logs")
}
```

Plus op `ClaudeJob`: `doc_id String?` + relatie naar `ProductDoc` (SPEC_REVIEW-target; `task_id` bestaat al voor TASK_REVIEW). Meerdere `ReviewLog`-rijen per artefact = herreview-historie (geen overschrijven). `doc_revision_id` pint de beoordeelde revisie (de doc kan daarna muteren). Exacte veldnamen/relatie-stijl spiegelen aan de bestaande modellen bij implementatie; `onDelete`-keuzes: log blijft bestaan als het target verdwijnt (SetNull), verdwijnt mét de job (Cascade — de job is de bron).

**Migrator-volgorde (Phase 2-les, bindend):** shared-PR → Scrum4Me-bump + migratie (`prisma migrate deploy`, ADD VALUEs idempotent waar relevant) → pas dán mcp/workers-rollout + worker-rebuilds.

## 5. Payload-takken (mcp, `getFullJobContext`)

Beide takken op kind, **vóór** de generieke MANUAL-branch (het Phase 2-patroon), na de `config`/`doc_index`-setup; beide kinds ook in `CLAIMABLE_STANDALONE_KINDS`.

**SPEC_REVIEW** — vereist `job.doc_id`:
- Doc laden (incl. huidige revisie-content; PBI-102-fallbackpatroon volgen zoals de idea-tak). Doc weg, geen content, of folder ≠ SPECS → `rollbackClaim` + null (mirror missing-pr_url).
- Payload: `{ job_id, kind, source, status, config, doc_index, spec_doc: { id, slug, folder, title?, status, revision_id, content_md }, instruction, product, repo_url, prompt_text: '' }`. Instructie uit `manual_drafts[0].prompt_md` (Phase 2-patroon).

**TASK_REVIEW** — vereist `job.task_id`:
- Task + story-acceptatie + `implementation_plan` laden; recentste relevante implementatie-context: nieuwste `TASK_IMPLEMENTATION`-job van die task (`plan_snapshot`, `base_sha`/`head_sha`, `pr_url`) én nieuwste `SprintTaskExecution` van die task (`plan_snapshot`, `base_sha`/`head_sha`) — executie wint indien aanwezig en DONE.
- **Diff-resolutie** (best-effort, in volgorde): (1) `fetchCompareDiff(repoRef, base_sha, head_sha)` via de Forgejo compare-API; (2) fallback `fetchPrDiff(pr_url)` (Phase 2-helper) als sha's ontbreken maar er een PR is; (3) geen van beide → `rollbackClaim` + null (een implementatie-review zonder diff is zinloos).
- Payload: `{ …, task: { id, title, status, implementation_plan, acceptance_criteria }, impl: { plan_snapshot, base_sha, head_sha, pr_url, execution_id? }, task_diff, instruction, … }`.

**Nieuwe helper `fetchCompareDiff`** in `src/git/pr.ts`: raw diff via de Forgejo compare-endpoint (`GET /repos/{owner}/{repo}/compare/{base}...{head}` met diff-accept/`.diff`-vorm) over `forgejoFetch` (text, niet `callForgejo`). De exacte endpoint-vorm/diff-media-variant bij implementatie pinnen tegen de live swagger (zoals het `event`-enum in Phase 2); de repo-ref komt uit `product.repo_url` (`parseForgejoRemoteUrl`). De canary vangt een verkeerde vorm.

## 6. Sink: `submit_review` (nieuw, model `post_pr_review`)

`src/tools/submit-review.ts`, geregistreerd als `submit_review`:
- **inputSchema:** `{ job_id: string, verdict: 'APPROVED'|'CHANGES_REQUESTED'|'REJECTED', findings: Array<{ severity: string, ref?: string, message: string }>, summary: string (1..65535), review_log?: passthrough }`.
- **Guards (de job is de autoriteit):** `requireWriteAccess()` + eigenaar; `job.kind ∈ {SPEC_REVIEW, TASK_REVIEW}`; target aanwezig op de job (`doc_id` voor SPEC_REVIEW — bij insert óók de huidige `current_revision_id` van de doc vastpinnen; `task_id` voor TASK_REVIEW — nieuwste executie-id meepinnen indien aanwezig). Target komt nooit uit de input.
- **Gedrag:** één `ReviewLog`-INSERT (kind, product uit de job, target-refs, verdict, findings, summary) + verdict-trace naar `ClaudeJob.summary` (`<KIND> <verdict> (<n> findings): <summary-slice>`). DB-fout → tool FAALT (prompt faalt de job; geen stille verlies — Phase 2-principe).
- **Revisie-pin-moment (expliciet):** de sink pint `doc_revision_id` op submit-moment (de dan-geldende `current_revision_id`). De payload draagt de op claim-moment gelezen `revision_id`; muteert de doc tussen claim en submit, dan kan de pin één revisie verschuiven — geaccepteerde race (reviews zijn advisory; de canary draait op een stilstaand doc).
- **Safe-default bewaakt in de prompt:** nooit `APPROVED` bij twijfel/ontbrekende kerninput.

## 7. Prompts (codex-portable, judge-only)

`src/prompts/spec/review.codex.md` + `src/prompts/task/review.codex.md` (+ dunne Claude-fallbacks `spec/review.md`, `task/review.md`; registratie in `KIND_TO_PROMPT_PATH` + `RUNTIME_PROMPT_OVERRIDES.CODEX`).

Gemeenschappelijk contract (Phase 1/2-conventies): payload via `$PAYLOAD_PATH`; `mcp__scrum4me__*`-namespace; product-context via `doc_index` (`get_product_doc`/`search_product_docs`); GEEN `ask_user_question`, GEEN Claude-toolnamen, GEEN artefact-writes; autonoom verdict; afsluiten met `submit_review` → bij succes `update_job_status(done, summary)`, bij sink-fout `update_job_status(failed, error: 'submit_review_failed')`.

- **spec/review.codex.md** — beoordeel `spec_doc.content_md` op: volledigheid (gaten/TBD's), interne consistentie, ambiguïteit (dubbel interpreteerbare eisen), scope (te groot/te vaag voor één implementatieplan), conformiteit met de product-architectuur/patterns (via doc_index). Verdict-regel: `APPROVED` ⇔ implementeerbaar zonder open kernvragen; `CHANGES_REQUESTED` bij herstelbare gebreken; `REJECTED` bij fundamentele gaten. Findings refereren secties/kopjes.
- **task/review.codex.md** — beoordeel `task_diff` tegen `task.implementation_plan` (of `impl.plan_snapshot`) + `task.acceptance_criteria`: dekt de diff het plan volledig (gemiste stappen), doet hij méér dan het plan (scope-creep), regressie-/kwaliteitsrisico's, test-dekking. Onafhankelijk oordeel — expliciet niet de verify-zelfcheck herhalen maar zelfstandig toetsen. Findings met `bestand:regel`. Zelfde verdict-regel.

## 8. Workers (templates + target-ketens, Phase 2-discipline)

- **`spec-review`-template:** velden product + `doc_slug` (string, required — folder vast SPECS) + `instruction` (optioneel). Keten: `MANUAL_JOB_KINDS` (beide modules!) += `SPEC_REVIEW`; `ManualJobDraftInput.docSlug` + zod + validatie (verplicht, slug-formaat) + `LaunchPreview.context.docSlug` + editor-mapping + rehydratie + context-patch-guard; **enqueue resolvet slug → doc** (`prisma.productDoc.findUnique({ product_id, folder: SPECS, slug })`, bestaat-check, anders weigeren) → `ClaudeJob.doc_id`.
- **`task-review`-template:** hergebruik de bestaande task-picker-keten (`taskId` bestaat end-to-end voor TASK_IMPLEMENTATION) + `instruction`; enqueue-guard: task verplicht + bestaat binnen het product → `ClaudeJob.task_id`. Geen idea-binding.
- Beide: `defaultRuntime: 'codex'` + `defaultAdapter: 'codex_cli'` (coherentie-les Phase 2), `allowedRuntimes: ['claude','codex']`, `defaultCapability: 'review'`, echte `promptSections` (lege secties blokkeren de save — Phase 2-les), codex-snapshot-override automatisch.

## 9. Canary's & succescriteria (gestaffeld)

**Volgorde (bindend):** shared-merge → web-migratie toegepast → mcp/workers gemerged → beide `agent-codex`-workers herbouwd (cache-bust!) → canary's. Seeds vanaf 154 (lokale postgres; max2-harness blokkeert prod-DB-writes). Bot-token staat al.

- **Canary A — SPEC_REVIEW:** seed een wegwerp-SPECS-ProductDoc met geplante gebreken (TBD's, een interne tegenspraak, een dubbelzinnige eis) op het canary-product + een `SPEC_REVIEW`/`CODEX`/`MANUAL`-job met `doc_id`. GO ⇔ job DONE + `ReviewLog`-rij (kind SPEC_REVIEW, doc+revisie gepind, verdict `CHANGES_REQUESTED`/`REJECTED` met findings die de geplante gebreken raken) + summary-trace + fleet ongestoord.
- **Canary B — TASK_REVIEW:** kies een bestaande DONE-task op het canary-product (of seed task+job met echte sha's) + een `TASK_REVIEW`-job met `task_id`. GO ⇔ job DONE + `ReviewLog`-rij (task gepind, diff beoordeeld tegen plan/acceptatie) + summary-trace.
- NO-GO → run-log vastleggen, fix-forward, herseeden (bekende mechaniek).

## 10. Error-handling

- Doc weg / leeg / folder ≠ SPECS (spec) of task weg / geen diff-bron (task) → `rollbackClaim` + null bij claim (geen zinloze run).
- `submit_review`-DB-fout → tool faalt → prompt zet `failed` (geen vals done).
- MANUAL-done-pad: al exempt van de verify-gate (Phase 2-bewezen).
- Herreview = nieuwe `ReviewLog`-rij (historie; geen dedup).
- Compare-API-fout met wél een `pr_url` → PR-diff-fallback; beide stuk → rollback.

## 11. Risico's & mitigatie

| Risico | Mitigatie |
|---|---|
| Compare-endpoint-vorm onzeker (Forgejo-versie) | Bij implementatie pinnen tegen de live swagger; PR-diff-fallback; canary B vangt het. |
| Schema-coördinatie (tabel + 2 enums + kolom) | Eén migrator-cyclus, volgorde bindend (§4); `ReviewLog` is additief, geen backfill. |
| Stale sha's / diff dekt niet de hele task | Executie-sha's winnen; expliciet in de payload welke bron gebruikt is; de prompt benoemt de diff-bron in de findings. |
| Verdent-vocabulaire drift t.o.v. Phase 1/2 | Bewust nieuw uniform enum (`ReviewVerdict`) alleen voor de ReviewLog; Phase 1/2-sinks blijven ongewijzigd. |
| Workers-keten-gaten (zoals Phase 2 P1's) | Zelfde checklist als Phase 2: beide kinds-arrays, validatie-module, editor-rehydratie, context-patch-guard, save→enqueue-tests, promptSections niet leeg, adapter-coherentie. |
| Blast-radius | Alles additief; bestaande kinds/paden byte-identiek; tests borgen. |

## 12. Test-strategie & cross-repo-volgorde

- **TDD per slice** (Phase 2-stijl): kind-prompts-selectie; `fetchCompareDiff` (mock `forgejoFetch`); payload-takken (MANUAL-jobs krijgen de kind-payload, rollback-paden); `submit_review` (guards, target-uit-job, revisie-pin, fail-on-DB-error, summary-trace); workers-ketens (save→enqueue, validatie, rehydratie, context-patch).
- **Volgorde:** 1) shared-PR (enums + ReviewLog + ClaudeJob.doc_id) → merge; 2) Scrum4Me-migratie-PR → merge → deploy/migrate; 3) mcp-PR (alles van §5-7) → merge; 4) workers-PR (§8) → merge; 5) rebuilds + canary A; 6) canary B. Elke PR codex-gereviewd via s4m-queue; merges user-gated; subagent-driven met spec+quality-reviews per slice.

## 13. Out of scope (expliciet)

- Merge-/status-gating op verdicts (Task.status REVIEW-flow, doc-status-koppeling) → Phase 4.
- Auto-dispatch (status-hooks/webhooks) → Phase 4.
- Actief herschrijven van specs door de reviewer (judge-only).
- PR_REVIEW achteraf in de ReviewLog hangen (latere uniformerings-pass).
- ReviewLog-UI in workers (losse follow-up).
- Reviews van repo-bestanden op schijf (alleen ProductDocs).
- Echte codex-model-ID's / runtime-aware `resolveJobConfig` (ongewijzigd uit eerdere fasen).

## 14. Review-log

*(Te vullen na de s4m-queue-reviews door codex(mac) + scrum4me-server:claude(154) en de gebruikers-review-gate.)*
