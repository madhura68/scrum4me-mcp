# Phase 3 — SPEC_REVIEW + TASK_REVIEW op codex — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Twee judge-only review-kinds (`SPEC_REVIEW`, `TASK_REVIEW`) op de codex-fleet: codex beoordeelt een SPECS-ProductDoc resp. een task-diff tegen plan + acceptatie, en schrijft verdict + findings naar één nieuwe generieke `ReviewLog`-tabel via een job-gebonden `submit_review`-sink.

**Architecture:** Eén schema-PR (shared) met béide enum-waarden + ReviewLog + `ClaudeJob.doc_id`; migratie via Scrum4Me (designated migrator); mcp krijgt 2 payload-takken vóór de MANUAL-branch (Phase 2-patroon), een `fetchCompareDiff`-helper (Forgejo **web**-`.diff`-route — de API-compare levert geen raw diff) en de `submit_review`-sink (upsert op `review_job_id`); workers krijgt 2 templates + target-ketens (doc_slug→doc_id, taskId→task_id). Advisory, manual-enqueue, geen worktree.

**Tech Stack:** Prisma 7 (schema in scrum4me-shared; mcp/workers genereren via `scripts/gen-schema.sh`), TypeScript ESM, vitest (mcp) / node test-runner via `npm run verify` (workers), zod, Forgejo REST + web-routes, s4m-queue voor host-acties.

**Spec:** `docs/superpowers/specs/2026-06-10-codex-spec-task-review-phase3-design.md` (beide reviewers GO). Sectieverwijzingen hieronder (§n) wijzen naar die spec.

---

## Bindende volgorde (spec §9/§12 — NIET herschikken)

1. Taak 1 (shared-PR) → **merge-gate** (gebruiker).
2. Taak 2 (web-migratie-PR) → **merge-gate**. Migratie draait pas bij rollout (Taak 13).
3. Taken 3-9 (mcp) → PR → **merge-gate**.
4. Taken 10-12 (workers) → PR → **merge-gate**.
5. Taak 13 (rollout): web deploy/migrate → **consumer-regel**: workers-image herbouwen/herdeployen → beide agent-codex-workers herbouwen (cache-bust) → dán pas seeds.
6. Taak 14 (canary A, SPEC_REVIEW) → GO-gate → Taak 15 (canary B, TASK_REVIEW).

**Waarom:** een nieuw `ClaudeJobKind` in de claim-SQL vóór de DB-migratie = 22P02-crash-loop (Phase 2-les); een oude Prisma-client die nieuwe enum-rijen leest = P2023-crash (consumer-regel, live bewezen 2026-06-10).

**Docker = no-op.** `scrum4me-docker` heeft geen wijziging nodig: `bin/run-one-job.ts` is kind-agnostisch en de worktree-attach is een TASK_IMPLEMENTATION-allowlist (Phase 2 #35 bevestigde dit voor PR_REVIEW). Taak 13 bevat een expliciete verificatiestap; vind je daar tóch een kind-allowlist die SPEC_REVIEW/TASK_REVIEW blokkeert → STOP en rapporteer.

## Worktrees & branches

| Repo | Worktree | Branch | Basis |
|---|---|---|---|
| scrum4me-shared | `~/Development/scrum4me-shared-phase3` | `feat/phase3-review-schema` | `origin/main` |
| Scrum4Me (web) | `~/Development/Scrum4Me-phase3` | `feat/phase3-review-migration` | `origin/main` |
| scrum4me-mcp | `~/Development/scrum4me-mcp-phase3` (bestaat al — spec+plan staan erop) | `feat/codex-spec-task-review-phase3` | `origin/main` (65f0197) |
| scrum4me-workers | `~/Development/scrum4me-workers-phase3` | `feat/codex-spec-task-review-phase3` | `origin/main` |

Aanmaken (per repo, vanuit een bestaande checkout): `git fetch origin && git worktree add <pad> -b <branch> origin/main`. **Raak de WIP-branches `fix/grill-md-status-coerce` (mcp) en `codex/mobile-entry-detection-selectors` (Scrum4Me) niet aan.** De workers-hoofd-checkout (`~/Development/scrum4me-workers`) staat op een vreemde branch — gebruik uitsluitend de verse worktree.

**Verse mcp/workers-worktrees:** `vendor/scrum4me-shared/` start leeg; `npm install` heelt dit (postinstall → submodule-init + gen-schema). Bij netwerk-issues: `git submodule update --init vendor/scrum4me-shared`.

## File-structuur (nieuw/gewijzigd)

```
scrum4me-shared/
  prisma/schema.prisma                 # +2 enum-waarden, +ReviewVerdict, +ReviewLog, +ClaudeJob.doc_id/doc/review_log, +6 back-relaties
  lib/claude-job-kind.ts               # +2 kinds in union + array

Scrum4Me/
  vendor/scrum4me-shared               # bump → shared-merge-sha
  prisma/migrations/<ts>_add_spec_task_review/migration.sql   # enum ×2 + ReviewVerdict + review_logs + claude_jobs.doc_id
  components/jobs/job-card.tsx         # KIND_LABELS +2
  components/jobs/jobs-column.tsx      # KIND_LABELS +2

scrum4me-mcp/
  vendor/scrum4me-shared               # bump → shared-merge-sha (prisma/schema.prisma volgt via gen-schema)
  src/lib/kind-prompts.ts              # +2 registraties + 2 codex-overrides
  src/prompts/spec/review.codex.md     # nieuw — codex spec-review prompt
  src/prompts/spec/review.md           # nieuw — dunne Claude-fallback
  src/prompts/task/review.codex.md     # nieuw — codex task-review prompt
  src/prompts/task/review.md           # nieuw — dunne Claude-fallback
  src/git/pr.ts                        # +fetchCompareDiff (web-route)
  src/tools/submit-review.ts           # nieuw — generieke review-sink (upsert)
  src/lib/task-review-context.ts       # nieuw — resolveTaskImplContext (executie wint)
  src/tools/wait-for-job.ts            # +2 payload-takken vóór MANUAL; CLAIMABLE +2; outer select +doc_id
  __tests__/lib/kind-prompts.test.ts   # +cases
  __tests__/git/compare-diff.test.ts   # nieuw
  __tests__/tools/submit-review.test.ts        # nieuw
  __tests__/lib/task-review-context.test.ts    # nieuw
  __tests__/tools/wait-for-job-spec-review.test.ts   # nieuw
  __tests__/tools/wait-for-job-task-review.test.ts   # nieuw

scrum4me-workers/
  vendor/scrum4me-shared               # bump → shared-merge-sha
  lib/manual-job-draft.ts              # kinds +2; docSlug-veld; launch-preview-context
  lib/manual-jobs/validation.ts        # kinds +2; DOC_SLUG_PATTERN; regels
  lib/manual-jobs/context-patch.ts     # +SPEC_REVIEW/TASK_REVIEW-takken
  lib/manual-jobs/templates.ts         # +2 templates + sections
  components/jobs/manual-job-draft-editor.tsx  # docSlug-mapping + rehydratie
  actions/manual-jobs.ts               # enqueue: docSlug→doc_id, taskId→task_id
  components/jobs/job-card.tsx         # KIND_LABELS +2
  components/jobs/jobs-column.tsx      # KIND_LABELS +2
  (+ bestaande testbestanden naast die modules — volg de bestaande test-locatieconventie)
```

---

### Taak 1: [shared] schema + kind-lib

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `lib/claude-job-kind.ts`

- [ ] **Stap 1.1: worktree + baseline**

```bash
cd ~/Development/scrum4me-shared && git fetch origin
git worktree add ~/Development/scrum4me-shared-phase3 -b feat/phase3-review-schema origin/main
cd ~/Development/scrum4me-shared-phase3 && npm install --no-audit --no-fund 2>/dev/null || true
npm test --if-present
```
Verwacht: bestaande tests groen (of geen test-script).

- [ ] **Stap 1.2: enum-waarden + ReviewVerdict + ReviewLog in `prisma/schema.prisma`**

In `enum ClaudeJobKind` ná `PR_REVIEW`:
```prisma
  SPEC_REVIEW
  TASK_REVIEW
```

Nieuw, direct onder de enum-sectie:
```prisma
enum ReviewVerdict {
  APPROVED
  CHANGES_REQUESTED
  REJECTED
}
```

Nieuw model (achteraan, bij de andere job-gerelateerde modellen):
```prisma
// Phase 3: generieke verdict-opslag voor judge-only reviews (SPEC_REVIEW,
// TASK_REVIEW). Eén rij per review-job (review_job_id @unique; sink doet
// upsert). Herreview-historie = meerdere review-jobs per artefact.
// Target-refs SetNull (log overleeft het target); Cascade op de job (de job
// is de bron van de rij).
model ReviewLog {
  id                       String              @id @default(cuid())
  review_job               ClaudeJob           @relation("JobReviewLog", fields: [review_job_id], references: [id], onDelete: Cascade)
  review_job_id            String              @unique
  kind                     ClaudeJobKind
  product                  Product             @relation("ProductReviewLogs", fields: [product_id], references: [id], onDelete: Cascade)
  product_id               String
  doc                      ProductDoc?         @relation("DocReviewLogs", fields: [doc_id], references: [id], onDelete: SetNull)
  doc_id                   String?
  doc_revision             ProductDocRevision? @relation("DocRevisionReviewLogs", fields: [doc_revision_id], references: [id], onDelete: SetNull)
  doc_revision_id          String?
  task                     Task?               @relation("TaskReviewLogs", fields: [task_id], references: [id], onDelete: SetNull)
  task_id                  String?
  sprint_task_execution    SprintTaskExecution? @relation("ExecutionReviewLogs", fields: [sprint_task_execution_id], references: [id], onDelete: SetNull)
  sprint_task_execution_id String?
  verdict                  ReviewVerdict
  findings                 Json
  summary                  String              @db.Text
  created_at               DateTime            @default(now())

  @@index([product_id, kind, created_at])
  @@index([doc_id, created_at])
  @@index([task_id, created_at])
  @@map("review_logs")
}
```

- [ ] **Stap 1.3: back-relaties + nieuwe FK (Prisma vereist beide kanten)**

In `model ClaudeJob` (bij de bestaande relatie-velden):
```prisma
  // Phase 3: SPEC_REVIEW-target (task_id bestaat al voor TASK_REVIEW).
  doc                       ProductDoc?           @relation("JobReviewDoc", fields: [doc_id], references: [id], onDelete: SetNull)
  doc_id                    String?
  review_log                ReviewLog?            @relation("JobReviewLog")
```
plus index bij de andere `@@index`-regels: `@@index([doc_id])`.

In `model Product`: `review_logs ReviewLog[] @relation("ProductReviewLogs")`
In `model ProductDoc`: `review_logs ReviewLog[] @relation("DocReviewLogs")` én `review_jobs ClaudeJob[] @relation("JobReviewDoc")`
In `model ProductDocRevision`: `review_logs ReviewLog[] @relation("DocRevisionReviewLogs")`
In `model Task`: `review_logs ReviewLog[] @relation("TaskReviewLogs")`
In `model SprintTaskExecution`: `review_logs ReviewLog[] @relation("ExecutionReviewLogs")`

- [ ] **Stap 1.4: valideer het schema (dit is de RED→GREEN voor relatiefouten)**

```bash
DATABASE_URL=postgresql://x:x@localhost:5432/x DIRECT_URL=postgresql://x:x@localhost:5432/x npx prisma validate --schema prisma/schema.prisma
```
Verwacht: `The schema at prisma/schema.prisma is valid 🚀` — elke ontbrekende back-relatie of dubbele relatienaam faalt hier.

- [ ] **Stap 1.5: `lib/claude-job-kind.ts` +2 kinds**

Volledige nieuwe inhoud:
```ts
// lib/claude-job-kind.ts
export type ClaudeJobKind =
  | 'TASK_IMPLEMENTATION'
  | 'IDEA_GRILL'
  | 'IDEA_MAKE_PLAN'
  | 'IDEA_REVIEW_PLAN'
  | 'PLAN_CHAT'
  | 'SPRINT_IMPLEMENTATION'
  | 'PR_REVIEW'
  | 'SPEC_REVIEW'
  | 'TASK_REVIEW'

export const CLAUDE_JOB_KINDS: ClaudeJobKind[] = [
  'TASK_IMPLEMENTATION',
  'IDEA_GRILL',
  'IDEA_MAKE_PLAN',
  'IDEA_REVIEW_PLAN',
  'PLAN_CHAT',
  'SPRINT_IMPLEMENTATION',
  'PR_REVIEW',
  'SPEC_REVIEW',
  'TASK_REVIEW',
]

export function isClaudeJobKind(value: unknown): value is ClaudeJobKind {
  return typeof value === 'string' && (CLAUDE_JOB_KINDS as string[]).includes(value)
}
```

- [ ] **Stap 1.6: tests + commit + PR**

```bash
npm test --if-present
git add prisma/schema.prisma lib/claude-job-kind.ts
git commit -m "feat(schema): SPEC_REVIEW + TASK_REVIEW kinds, ReviewVerdict, ReviewLog, ClaudeJob.doc_id (Phase 3)"
git push -u origin feat/phase3-review-schema
```
PR via de Forgejo-API (curl `--config` met token-header, titel `feat(schema): Phase 3 review-kinds + ReviewLog`, body eindigt met de Claude-Code-footer). **→ merge-gate (gebruiker), daarna noteer de merge-sha als `SHARED_SHA`.**

---

### Taak 2: [web] migratie + labels

**Files:**
- Modify: `vendor/scrum4me-shared` (submodule bump → `SHARED_SHA`)
- Create: `prisma/migrations/<timestamp>_add_spec_task_review_reviewlog/migration.sql`
- Modify: `components/jobs/job-card.tsx`, `components/jobs/jobs-column.tsx` (zoek `KIND_LABELS`)

- [ ] **Stap 2.1: worktree + bump + baseline**

```bash
cd ~/Development/Scrum4Me && git fetch origin
git worktree add ~/Development/Scrum4Me-phase3 -b feat/phase3-review-migration origin/main
cd ~/Development/Scrum4Me-phase3 && npm install
cd vendor/scrum4me-shared && git fetch origin && git checkout <SHARED_SHA> && cd ../..
npx prisma generate
npm test
```
Verwacht: baseline groen (≥1340 tests).

- [ ] **Stap 2.2: migratie genereren (niet handschrijven) + idempotent maken**

```bash
npx prisma migrate dev --create-only --name add_spec_task_review_reviewlog
```
Open de gegenereerde `migration.sql` en pas aan: de twee `ALTER TYPE`-regels MOETEN `IF NOT EXISTS` krijgen (her-runbaar op een DB waar een waarde al bestaat):
```sql
ALTER TYPE "ClaudeJobKind" ADD VALUE IF NOT EXISTS 'SPEC_REVIEW';
ALTER TYPE "ClaudeJobKind" ADD VALUE IF NOT EXISTS 'TASK_REVIEW';
```
Checklist — de migratie moet exact bevatten (namen volgen uit de generator; controleer):
1. de 2 enum-ADD VALUEs (idempotent);
2. `CREATE TYPE "ReviewVerdict" AS ENUM ('APPROVED','CHANGES_REQUESTED','REJECTED');`
3. `ALTER TABLE "claude_jobs" ADD COLUMN "doc_id" TEXT;` + FK naar `product_docs(id)` ON DELETE SET NULL + index;
4. `CREATE TABLE "review_logs" (…)` met UNIQUE op `review_job_id`, de 3 indexen en 6 FK's (Cascade voor review_job/product; SetNull voor doc/doc_revision/task/sprint_task_execution).

NB: Postgres staat `ADD VALUE` niet toe in hetzelfde transaction-block als gebruik van de waarde; de migratie gebruikt de nieuwe waarden zelf niet (review_logs.kind krijgt geen default), dus dit is veilig. Splits NIET handmatig in losse migraties.

- [ ] **Stap 2.3: migratie lokaal toepassen + verifiëren**

```bash
npx prisma migrate dev
npx prisma migrate status
```
Verwacht: migratie applied, status clean.

- [ ] **Stap 2.4: KIND_LABELS in beide componenten**

In `components/jobs/job-card.tsx` en `components/jobs/jobs-column.tsx`, in het `KIND_LABELS: Record<ClaudeJobKind, string>`-object, ná de `PR_REVIEW`-regel:
```ts
  SPEC_REVIEW: 'Spec-review',
  TASK_REVIEW: 'Task-review',
```
(Het `Record<ClaudeJobKind, …>`-type FORCEERT deze toevoeging zodra de client de nieuwe kinds kent — typecheck faalt anders. Dat is de RED.)

- [ ] **Stap 2.5: verify + commit + PR**

```bash
npm test && npm run lint --if-present
git add -A
git commit -m "feat(schema): Phase 3 migratie — SPEC_REVIEW/TASK_REVIEW + ReviewVerdict + review_logs + claude_jobs.doc_id; shared-bump; KIND_LABELS"
git push -u origin feat/phase3-review-migration
```
PR via API. **→ merge-gate. Deploy/migrate gebeurt pas in Taak 13.**

---

### Taak 3: [mcp] vendor-bump + schema-regeneratie

**Files:** `vendor/scrum4me-shared` (bump), `prisma/schema.prisma` (gegenereerd — niet handmatig bewerken)

- [ ] **Stap 3.1** (in `~/Development/scrum4me-mcp-phase3`, bestaande branch):
```bash
cd ~/Development/scrum4me-mcp-phase3
git submodule update --init vendor/scrum4me-shared
cd vendor/scrum4me-shared && git fetch origin && git checkout <SHARED_SHA> && cd ../..
npm install            # postinstall: gen-schema.sh > prisma/schema.prisma && prisma generate
git diff --stat prisma/schema.prisma   # moet ReviewLog/doc_id/enums tonen
npm test
```
Verwacht: baseline groen (≥712 tests) — niets gebruikt de nieuwe modellen nog.

- [ ] **Stap 3.2: commit**
```bash
git add vendor/scrum4me-shared prisma/schema.prisma
git commit -m "chore(shared): bump vendor naar Phase 3-schema (ReviewLog + review-kinds)"
```

---

### Taak 4: [mcp] kind-prompts registratie + 4 promptbestanden (TDD)

**Files:**
- Modify: `src/lib/kind-prompts.ts`
- Create: `src/prompts/spec/review.codex.md`, `src/prompts/spec/review.md`, `src/prompts/task/review.codex.md`, `src/prompts/task/review.md`
- Test: `__tests__/lib/kind-prompts.test.ts`

- [ ] **Stap 4.1: failing tests**

Voeg toe aan `__tests__/lib/kind-prompts.test.ts` (volg de bestaande describe-stijl):
```ts
it('SPEC_REVIEW: CODEX-override en Claude-fallback bestaan en verschillen', () => {
  const codex = getKindPromptText('SPEC_REVIEW', 'CODEX')
  const claude = getKindPromptText('SPEC_REVIEW', 'CLAUDE')
  expect(codex).toContain('submit_review')
  expect(codex).toContain('judge-only')
  expect(claude).toContain('submit_review')
  expect(codex).not.toBe(claude)
})

it('TASK_REVIEW: CODEX-override en Claude-fallback bestaan en verschillen', () => {
  const codex = getKindPromptText('TASK_REVIEW', 'CODEX')
  const claude = getKindPromptText('TASK_REVIEW', 'CLAUDE')
  expect(codex).toContain('submit_review')
  expect(codex).toContain('task_diff')
  expect(claude).toContain('submit_review')
  expect(codex).not.toBe(claude)
})
```

- [ ] **Stap 4.2: run → RED**
```bash
npx vitest run __tests__/lib/kind-prompts.test.ts
```
Verwacht: FAIL (lege string — kinds niet geregistreerd).

- [ ] **Stap 4.3: registratie in `src/lib/kind-prompts.ts`**

```ts
const KIND_TO_PROMPT_PATH: Partial<Record<ClaudeJobKind, string>> = {
  // …bestaande regels…
  PR_REVIEW: 'pr/review.md',
  SPEC_REVIEW: 'spec/review.md',
  TASK_REVIEW: 'task/review.md',
}
```
```ts
  CODEX: {
    IDEA_REVIEW_PLAN: 'idea/review-plan.codex.md',
    PR_REVIEW: 'pr/review.codex.md',
    SPEC_REVIEW: 'spec/review.codex.md',
    TASK_REVIEW: 'task/review.codex.md',
  },
```

- [ ] **Stap 4.4: `src/prompts/spec/review.codex.md`** (volledig)

```markdown
Je bent een onafhankelijke spec-reviewer (runtime: CODEX). Je beoordeelt één spec-document (ProductDoc, folder SPECS) en legt autonoom een verdict vast. Je vraagt NOOIT iets aan een mens en je wijzigt het document NIET (judge-only).

## Invoer
Lees het JSON-bestand op $PAYLOAD_PATH. Velden:
- `spec_doc`: { id, slug, folder, title, status, revision_id, revision, content_md } — het te beoordelen document.
- `instruction`: vrije review-instructie van de aanvrager (kan leeg zijn).
- `doc_index`: index van product-docs; lees relevante architectuur/patterns via mcp__scrum4me__get_product_doc / mcp__scrum4me__search_product_docs als toetskader.

## Taak
Beoordeel `spec_doc.content_md` op:
1. **Volledigheid** — gaten, TBD's/placeholders, ontbrekende foutpaden of test-strategie.
2. **Interne consistentie** — secties die elkaar tegenspreken.
3. **Ambiguïteit** — eisen die op twee manieren te lezen zijn.
4. **Scope** — te groot of te vaag voor één implementatieplan.
5. **Conformiteit** met de product-architectuur/patterns (via doc_index).

## Verdict (autonoom)
- `APPROVED` — implementeerbaar zonder open kernvragen.
- `CHANGES_REQUESTED` — herstelbare gebreken.
- `REJECTED` — fundamentele gaten of tegenstrijdigheden.
Safe-default: bij twijfel of ontbrekende kerninput kies je NOOIT `APPROVED`.

## Findings
Elke finding: `{ severity: 'error'|'warning'|'info', ref: '<sectie/kopje>', message: '<korte uitleg>' }`.

## Afsluiten
1. Roep `mcp__scrum4me__submit_review({ job_id: <payload.job_id>, verdict: <APPROVED|CHANGES_REQUESTED|REJECTED>, findings: [...], summary: <1-3 zinnen> })`.
   - Faalt deze call, roep dan `mcp__scrum4me__update_job_status({ job_id, status: 'failed', error: 'submit_review_failed' })` en stop. Post NOOIT een vals "done".
2. Bij succes: `mcp__scrum4me__update_job_status({ job_id, status: 'done', summary: <verdict + 1-regel-samenvatting> })`.
```

- [ ] **Stap 4.5: `src/prompts/spec/review.md`** (dunne Claude-fallback, volledig)

```markdown
Je beoordeelt één spec-document (ProductDoc, folder SPECS) en legt autonoom een verdict vast. Judge-only: wijzig het document niet.

Lees $PAYLOAD_PATH ({ spec_doc, instruction, doc_index }). Beoordeel `spec_doc.content_md` op volledigheid (gaten/TBD's), interne consistentie, ambiguïteit, scope en conformiteit met de product-architectuur (via doc_index).

Bepaal `verdict` (APPROVED / CHANGES_REQUESTED / REJECTED); kies bij twijfel nooit APPROVED. Findings: { severity, ref: sectie, message }.

Roep dan `submit_review({ job_id, verdict, findings, summary })`; faalt die, roep `update_job_status({ job_id, status: 'failed', error: 'submit_review_failed' })` en stop. Bij succes `update_job_status({ job_id, status: 'done', summary })`.
```

- [ ] **Stap 4.6: `src/prompts/task/review.codex.md`** (volledig)

```markdown
Je bent een onafhankelijke implementatie-reviewer (runtime: CODEX). Je beoordeelt één task-diff tegen het plan en de acceptatiecriteria en legt autonoom een verdict vast. Je vraagt NOOIT iets aan een mens en je wijzigt niets (judge-only). Dit is een ONAFHANKELIJK oordeel náást de verify-zelfcheck van de implementer — herhaal die zelfcheck niet, toets zelfstandig.

## Invoer
Lees het JSON-bestand op $PAYLOAD_PATH. Velden:
- `task`: { id, title, status, implementation_plan, acceptance_criteria }
- `impl`: { plan_snapshot, base_sha, head_sha, pr_url, execution_id, diff_source } — welke implementatie-context en diff-bron gebruikt is ('compare' = base...head-range; 'pr' = hele PR-diff, kan breder zijn dan deze task).
- `task_diff`: de unified diff (kan groot zijn).
- `instruction`: vrije review-instructie (kan leeg zijn).
- `doc_index`: product-docs-index; gebruik mcp__scrum4me__get_product_doc / mcp__scrum4me__search_product_docs voor patterns/architectuur.

## Taak
Beoordeel `task_diff` tegen `impl.plan_snapshot` (of `task.implementation_plan` als snapshot ontbreekt) + `task.acceptance_criteria`:
1. **Dekking** — implementeert de diff het plan volledig (gemiste stappen)?
2. **Scope-creep** — doet de diff méér dan het plan?
3. **Kwaliteit/regressierisico** — fouten, edge-cases, onveilige patronen.
4. **Tests** — dekt de diff zijn gedrag met tests?
Benoem in je summary expliciet welke diff-bron je beoordeelde (`impl.diff_source`); bij 'pr' kan de diff ook werk van sibling-tasks bevatten — reken dat de task niet aan.

## Verdict (autonoom)
- `APPROVED` — plan + acceptatie gedekt, geen blokkerende findings.
- `CHANGES_REQUESTED` — herstelbare gebreken of gemiste plan-stappen.
- `REJECTED` — implementatie wijkt fundamenteel af van het plan.
Safe-default: bij twijfel, een lege diff of ontbrekend plan én acceptatie kies je NOOIT `APPROVED`.

## Findings
Elke finding: `{ severity: 'error'|'warning'|'info', ref: '<bestand:regel>', message: '<korte uitleg>' }`.

## Afsluiten
1. Roep `mcp__scrum4me__submit_review({ job_id: <payload.job_id>, verdict, findings: [...], summary })`.
   - Faalt deze call, roep dan `mcp__scrum4me__update_job_status({ job_id, status: 'failed', error: 'submit_review_failed' })` en stop. Post NOOIT een vals "done".
2. Bij succes: `mcp__scrum4me__update_job_status({ job_id, status: 'done', summary: <verdict + 1-regel> })`.
```

- [ ] **Stap 4.7: `src/prompts/task/review.md`** (dunne Claude-fallback, volledig)

```markdown
Je beoordeelt één task-diff tegen het plan en de acceptatiecriteria en legt autonoom een verdict vast. Judge-only; onafhankelijk van de verify-zelfcheck.

Lees $PAYLOAD_PATH ({ task, impl, task_diff, instruction, doc_index }). Toets `task_diff` op plan-dekking, scope-creep, kwaliteit/regressierisico en tests; benoem de gebruikte diff-bron (`impl.diff_source`).

Bepaal `verdict` (APPROVED / CHANGES_REQUESTED / REJECTED); kies bij twijfel of lege diff nooit APPROVED. Findings: { severity, ref: bestand:regel, message }.

Roep dan `submit_review({ job_id, verdict, findings, summary })`; faalt die, roep `update_job_status({ job_id, status: 'failed', error: 'submit_review_failed' })` en stop. Bij succes `update_job_status({ job_id, status: 'done', summary })`.
```

- [ ] **Stap 4.8: run → GREEN + commit**
```bash
npx vitest run __tests__/lib/kind-prompts.test.ts
git add src/lib/kind-prompts.ts src/prompts/spec src/prompts/task __tests__/lib/kind-prompts.test.ts
git commit -m "feat(mcp): SPEC_REVIEW/TASK_REVIEW prompts + runtime-registratie (Phase 3)"
```

---

### Taak 5: [mcp] `fetchCompareDiff` via de web-route (TDD)

**Files:**
- Modify: `src/git/pr.ts` (achteraan, na `postPullRequestReview`)
- Test: `__tests__/git/compare-diff.test.ts` (nieuw)

- [ ] **Stap 5.1: failing tests** — `__tests__/git/compare-diff.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchCompareDiff } from '../../src/git/pr.js'

const DIFF = 'diff --git a/x.ts b/x.ts\nindex 000..111 100644\n--- a/x.ts\n+++ b/x.ts\n'
const REPO = 'https://git.example.test/janpeter/demo.git'

describe('fetchCompareDiff', () => {
  const fetchMock = vi.fn()
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('haalt een unified diff op via de web-.diff-route (niet /api/v1)', async () => {
    fetchMock.mockResolvedValue(new Response(DIFF, { status: 200 }))
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toBe(DIFF)
    const url = String(fetchMock.mock.calls[0]![0])
    expect(url).toBe('https://git.example.test/janpeter/demo/compare/aaa1111...bbb2222.diff')
    expect(url).not.toContain('/api/v1/')
  })

  it('weigert een lege range (base === head) zonder fetch-call', async () => {
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'aaa1111' })
    expect(out).toHaveProperty('error')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('non-2xx (bv. private repo: web-route kent geen token-auth) → {error}', async () => {
    fetchMock.mockResolvedValue(new Response('Not found.', { status: 404 }))
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toHaveProperty('error')
  })

  it('200 zonder unified-diff-body (sanity-check) → {error}', async () => {
    fetchMock.mockResolvedValue(new Response('<!DOCTYPE html>…', { status: 200 }))
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toHaveProperty('error')
  })

  it('onparseerbare repo-URL → {error} zonder fetch-call', async () => {
    const out = await fetchCompareDiff({ repoUrl: ':::', baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toHaveProperty('error')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
```
NB: `parseForgejoRemoteUrl` draait `assertHostAllowed` — als de test-host geweigerd wordt, kijk hoe `__tests__/git/pr-review-helpers.test.ts` host-allowance regelt (zelfde aanpak hergebruiken; pas dan ook REPO aan naar de daar gebruikte host).

- [ ] **Stap 5.2: run → RED**
```bash
npx vitest run __tests__/git/compare-diff.test.ts
```
Verwacht: FAIL — `fetchCompareDiff` bestaat niet.

- [ ] **Stap 5.3: implementatie in `src/git/pr.ts`** (achteraan):

```ts
// =========================================================================
// fetchCompareDiff — Phase 3: unified diff van een commit-range via de
// Forgejo WEB-route (/{owner}/{repo}/compare/{base}...{head}.diff).
// Bewust NIET via forgejoFetch: die hangt aan /api/v1, en de API-compare
// produceert alléén JSON (geen raw diff; `.diff` op het API-pad is 404).
// De web-route kent géén token-auth: een private repo geeft 404 → caller
// valt terug op de PR-diff (API + token) of rolt de claim terug.
// =========================================================================

export async function fetchCompareDiff(opts: {
  repoUrl: string
  baseSha: string
  headSha: string
}): Promise<string | { error: string }> {
  if (!opts.baseSha || !opts.headSha || opts.baseSha === opts.headSha) {
    return { error: 'fetchCompareDiff: lege range (base/head ontbreekt of base === head)' }
  }
  let repoRef
  try {
    repoRef = parseForgejoRemoteUrl(opts.repoUrl)
  } catch (err) {
    return { error: `fetchCompareDiff: ${(err as Error).message.slice(0, 300)}` }
  }
  const url = `https://${repoRef.host}/${repoRef.owner}/${repoRef.repo}/compare/${opts.baseSha}...${opts.headSha}.diff`
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) {
      return { error: `Forgejo compare-diff failed: ${res.status}` }
    }
    const text = await res.text()
    if (!text.startsWith('diff --git')) {
      return { error: `Forgejo compare-diff: geen unified diff in response: ${text.slice(0, 120)}` }
    }
    return text
  } catch (err) {
    return { error: `Forgejo compare-diff failed: ${(err as Error).message.slice(0, 300)}` }
  }
}
```
Import-check: `parseForgejoRemoteUrl` staat in `src/git/forgejo-rest.ts` — voeg toe aan de bestaande import-lijst bovenin `pr.ts` als die hem nog niet importeert.

- [ ] **Stap 5.4: run → GREEN; volledige suite; commit**
```bash
npx vitest run __tests__/git/compare-diff.test.ts && npm test
git add src/git/pr.ts __tests__/git/compare-diff.test.ts
git commit -m "feat(mcp): fetchCompareDiff via Forgejo web-.diff-route (Phase 3)"
```

---

### Taak 6: [mcp] `submit_review`-sink (TDD)

**Files:**
- Create: `src/tools/submit-review.ts`
- Modify: registratieplek — zoek `registerPostPrReviewTool(` (de server-setup) en registreer ernaast
- Test: `__tests__/tools/submit-review.test.ts` (nieuw; spiegel de mock-aanpak van `__tests__/tools/post-pr-review.test.ts`)

- [ ] **Stap 6.1: failing tests** — cases (volg de prisma-mock-stijl van post-pr-review.test.ts exact):
1. job niet gevonden / andere eigenaar → `Job not found`, geen upsert.
2. kind buiten {SPEC_REVIEW, TASK_REVIEW} (bv. PR_REVIEW) → error, geen upsert.
3. SPEC_REVIEW zonder `doc_id` → `Job has no doc_id`.
4. TASK_REVIEW zonder `task_id` → `Job has no task_id`.
5. SPEC_REVIEW happy path → `reviewLog.upsert` aangeroepen met `where: { review_job_id }`, `create.doc_id` = job.doc_id, `create.doc_revision_id` = de gemockte `current_revision_id` (revisie-pin op submit-moment), én `claudeJob.update` met summary `SPEC_REVIEW CHANGES_REQUESTED (2 findings): …`.
6. TASK_REVIEW happy path → upsert met `task_id` + `sprint_task_execution_id` van de nieuwste DONE-executie (mock `sprintTaskExecution.findFirst`); geen executie → `sprint_task_execution_id: null`.
7. upsert gooit → tool-result is een error (withToolErrors-pad), géén `claudeJob.update`.

- [ ] **Stap 6.2: run → RED** (`npx vitest run __tests__/tools/submit-review.test.ts`; module bestaat niet).

- [ ] **Stap 6.3: implementatie `src/tools/submit-review.ts`** (volledig):

```ts
// MCP-tool: schrijft het verdict van een SPEC_REVIEW/TASK_REVIEW-job naar de
// generieke ReviewLog en zet een verdict-trace op ClaudeJob.summary. De job
// is de autoriteit: kind + target komen uit de jób, nooit uit de input.
// Upsert op review_job_id → retry-idempotent (1 verdict-rij per job; her-
// review-historie = meerdere jobs). Een DB-fout faalt de tool (geen stil
// verlies — Phase 2-principe). Model: post-pr-review.ts.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

export const inputSchema = z.object({
  job_id: z.string().min(1),
  verdict: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REJECTED'] as const),
  findings: z.array(z.object({
    severity: z.string().min(1),
    ref: z.string().optional(),
    message: z.string().min(1),
  })),
  summary: z.string().min(1).max(65_535),
  review_log: z.object({}).passthrough().optional(),
})

export async function handleSubmitReview(
  { job_id, verdict, findings, summary }: z.infer<typeof inputSchema>,
) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    const job = await prisma.claudeJob.findUnique({
      where: { id: job_id },
      select: {
        id: true,
        user_id: true,
        kind: true,
        product_id: true,
        doc_id: true,
        task_id: true,
        doc: { select: { current_revision_id: true } },
      },
    })
    if (!job || job.user_id !== auth.userId) {
      return toolError('Job not found')
    }
    if (job.kind !== 'SPEC_REVIEW' && job.kind !== 'TASK_REVIEW') {
      return toolError('Job is not a SPEC_REVIEW/TASK_REVIEW job')
    }

    let docRevisionId: string | null = null
    let executionId: string | null = null
    if (job.kind === 'SPEC_REVIEW') {
      if (!job.doc_id) return toolError('Job has no doc_id')
      // Revisie-pin op submit-moment (spec §6): de dán geldende current_revision_id.
      docRevisionId = job.doc?.current_revision_id ?? null
    } else {
      if (!job.task_id) return toolError('Job has no task_id')
      const execution = await prisma.sprintTaskExecution.findFirst({
        where: { task_id: job.task_id, status: 'DONE' },
        orderBy: { created_at: 'desc' },
        select: { id: true },
      })
      executionId = execution?.id ?? null
    }

    const row = {
      kind: job.kind,
      product_id: job.product_id,
      doc_id: job.kind === 'SPEC_REVIEW' ? job.doc_id : null,
      doc_revision_id: docRevisionId,
      task_id: job.kind === 'TASK_REVIEW' ? job.task_id : null,
      sprint_task_execution_id: executionId,
      verdict,
      findings,
      summary,
    }
    await prisma.reviewLog.upsert({
      where: { review_job_id: job.id },
      create: { review_job_id: job.id, ...row },
      update: row,
    })

    await prisma.claudeJob.update({
      where: { id: job.id },
      data: { summary: `${job.kind} ${verdict} (${findings.length} findings): ${summary.slice(0, 280)}` },
    })

    return toolJson({ ok: true, verdict, findings_count: findings.length })
  })
}

export function registerSubmitReviewTool(server: McpServer) {
  server.registerTool(
    'submit_review',
    {
      title: 'Submit a review verdict (ReviewLog)',
      description:
        'Persist the verdict of a SPEC_REVIEW/TASK_REVIEW job into the generic ' +
        'ReviewLog and record a verdict-trace on the job. The job is the ' +
        'authority: kind and target (doc_id/task_id) come from the job, never ' +
        'from the input. Idempotent per job (upsert on review_job_id). A DB ' +
        'failure fails the tool (never a silent success). Forbidden for demo accounts.',
      inputSchema,
    },
    handleSubmitReview,
  )
}
```
Let op het `findings`-Json-veld: geef de array direct door; als de Prisma-types klagen, cast naar `Prisma.InputJsonValue` met `import type { Prisma } from '@prisma/client'`.

- [ ] **Stap 6.4: registreren** — zoek het bestand dat `registerPostPrReviewTool` aanroept (grep), importeer en roep `registerSubmitReviewTool(server)` ernaast aan.

- [ ] **Stap 6.5: run → GREEN; suite; commit**
```bash
npx vitest run __tests__/tools/submit-review.test.ts && npm test
git add src/tools/submit-review.ts __tests__/tools/submit-review.test.ts
git add <registratiebestand>
git commit -m "feat(mcp): submit_review-sink — generieke ReviewLog-upsert (Phase 3)"
```

---

### Taak 7: [mcp] SPEC_REVIEW-payload-tak + CLAIMABLE (TDD)

**Files:**
- Modify: `src/tools/wait-for-job.ts` — (a) `CLAIMABLE_STANDALONE_KINDS` (regel ~323), (b) outer job-select in `getFullJobContext` (+`doc_id`), (c) nieuwe tak direct ná de PR_REVIEW-tak (vóór `if (job.source === 'MANUAL')`)
- Test: `__tests__/tools/wait-for-job-spec-review.test.ts` (nieuw; spiegel `wait-for-job-pr-review.test.ts`)

- [ ] **Stap 7.1: failing tests** — cases:
1. claim-SQL bevat beide nieuwe kinds (spiegel de bestaande CLAIMABLE-test in wait-for-job-pr-review.test.ts).
2. SPEC_REVIEW-job zonder `doc_id` → rollbackClaim + null.
3. doc bestaat niet → rollback + null.
4. `folder !== 'SPECS'` → rollback + null.
5. doc zonder `current_revision`/content → rollback + null.
6. happy path → payload bevat `kind: 'SPEC_REVIEW'`, `spec_doc.{id,slug,folder,title,status,revision_id,revision,content_md}`, `instruction` uit `manual_drafts[0].prompt_md`, `doc_index`, `product`, `prompt_text: ''`.

- [ ] **Stap 7.2: run → RED.**

- [ ] **Stap 7.3: implementatie**

(a) regel ~323:
```ts
const CLAIMABLE_STANDALONE_KINDS = "('IDEA_GRILL', 'IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN', 'PLAN_CHAT', 'PR_REVIEW', 'SPEC_REVIEW', 'TASK_REVIEW')"
```
(b) géén query-wijziging nodig voor `doc_id`: de outer job-query in `getFullJobContext` (regel ~685) gebruikt `include`, dus alle scalars (incl. het nieuwe `doc_id` na schema-regeneratie) komen automatisch mee. Alleen relevant als iemand de query ooit naar expliciete `select` omzet.
(c) nieuwe tak, ná het `if (job.kind === 'PR_REVIEW') { … }`-blok:

```ts
  if (job.kind === 'SPEC_REVIEW') {
    if (!job.doc_id) {
      await rollbackClaim(job.id)
      return null
    }
    const doc = await prisma.productDoc.findUnique({
      where: { id: job.doc_id },
      select: {
        id: true,
        slug: true,
        folder: true,
        title: true,
        status: true,
        current_revision: { select: { id: true, revision: true, content_md: true } },
      },
    })
    if (!doc || doc.folder !== 'SPECS' || !doc.current_revision?.content_md) {
      await rollbackClaim(job.id)
      return null
    }
    const instruction = job.manual_drafts[0]?.prompt_md ?? ''
    return {
      job_id: job.id,
      kind: 'SPEC_REVIEW',
      source: job.source,
      status: 'claimed',
      config,
      doc_index: docIndex,
      spec_doc: {
        id: doc.id,
        slug: doc.slug,
        folder: doc.folder,
        title: doc.title,
        status: doc.status,
        revision_id: doc.current_revision.id,
        revision: doc.current_revision.revision,
        content_md: doc.current_revision.content_md,
      },
      instruction,
      product: {
        id: job.product.id,
        name: job.product.name,
        repo_url: job.product.repo_url,
        definition_of_done: job.product.definition_of_done,
      },
      repo_url: job.product.repo_url,
      prompt_text: '', // runner is gezaghebbend: getKindPromptText(kind, runtime)
    }
  }
```

- [ ] **Stap 7.4: run → GREEN; suite; commit**
```bash
npx vitest run __tests__/tools/wait-for-job-spec-review.test.ts && npm test
git add src/tools/wait-for-job.ts __tests__/tools/wait-for-job-spec-review.test.ts
git commit -m "feat(mcp): SPEC_REVIEW getFullJobContext-tak + CLAIMABLE_STANDALONE +2 (Phase 3)"
```

---

### Taak 8: [mcp] `resolveTaskImplContext` + TASK_REVIEW-payload-tak (TDD)

**Files:**
- Create: `src/lib/task-review-context.ts`
- Modify: `src/tools/wait-for-job.ts` (tak ná SPEC_REVIEW, vóór MANUAL)
- Test: `__tests__/lib/task-review-context.test.ts` + `__tests__/tools/wait-for-job-task-review.test.ts` (nieuw)

- [ ] **Stap 8.1: failing tests `task-review-context.test.ts`** — cases:
1. DONE-executie aanwezig → executie wint (plan_snapshot/sha's van de executie; `pr_url` van de sprint-job, met impl-job-pr_url als fallback; `execution_id` gezet).
2. geen executie, wel TASK_IMPLEMENTATION-job → job-velden, `execution_id: null`.
3. geen van beide → alles null.

- [ ] **Stap 8.2: implementatie `src/lib/task-review-context.ts`** (volledig):

```ts
// Phase 3 (TASK_REVIEW): nieuwste implementatie-context van een task.
// DONE-SprintTaskExecution wint van de TASK_IMPLEMENTATION-job-velden:
// executie-sha's zijn in prod 100% gevuld, job-sha's ~36-42% (spec §5).

import { prisma } from '../prisma.js'

export type TaskImplContext = {
  plan_snapshot: string | null
  base_sha: string | null
  head_sha: string | null
  pr_url: string | null
  execution_id: string | null
}

export async function resolveTaskImplContext(taskId: string): Promise<TaskImplContext> {
  const execution = await prisma.sprintTaskExecution.findFirst({
    where: { task_id: taskId, status: 'DONE' },
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      plan_snapshot: true,
      base_sha: true,
      head_sha: true,
      sprint_job: { select: { pr_url: true } },
    },
  })
  const implJob = await prisma.claudeJob.findFirst({
    where: { task_id: taskId, kind: 'TASK_IMPLEMENTATION' },
    orderBy: { created_at: 'desc' },
    select: { plan_snapshot: true, base_sha: true, head_sha: true, pr_url: true },
  })

  if (execution) {
    return {
      plan_snapshot: execution.plan_snapshot ?? null,
      base_sha: execution.base_sha ?? null,
      head_sha: execution.head_sha ?? null,
      pr_url: execution.sprint_job?.pr_url ?? implJob?.pr_url ?? null,
      execution_id: execution.id,
    }
  }
  if (implJob) {
    return {
      plan_snapshot: implJob.plan_snapshot,
      base_sha: implJob.base_sha,
      head_sha: implJob.head_sha,
      pr_url: implJob.pr_url,
      execution_id: null,
    }
  }
  return { plan_snapshot: null, base_sha: null, head_sha: null, pr_url: null, execution_id: null }
}
```

- [ ] **Stap 8.3: failing tests `wait-for-job-task-review.test.ts`** — cases (mock prisma + `fetchCompareDiff` + `fetchPrDiff` + `resolveTaskImplContext` zoals de PR_REVIEW-test `resolvePrLinkedPlan` mockt):
1. geen `task_id` → rollback + null.
2. task niet gevonden → rollback + null.
3. sha's aanwezig + compare slaagt → `task_diff` = compare-resultaat, `impl.diff_source: 'compare'`; **diff-repo-assert**: `fetchCompareDiff` aangeroepen met `task.repo_url` als die gezet is, anders `product.repo_url` (spec §5, cross-repo).
4. `base_sha === head_sha` → compare wordt NIET aangeroepen; met `pr_url` → PR-fallback (`diff_source: 'pr'`).
5. compare faalt (bv. private-repo-404) + `pr_url` aanwezig → PR-fallback.
6. geen diff-bron (geen sha's, geen pr_url, of beide falen) → rollback + null.
7. happy-path payload: `task.{id,title,status,implementation_plan,acceptance_criteria}`, `impl.{plan_snapshot,base_sha,head_sha,pr_url,execution_id,diff_source}`, `task_diff`, `instruction`, `prompt_text: ''`.

- [ ] **Stap 8.4: implementatie van de tak** (ná de SPEC_REVIEW-tak):

```ts
  if (job.kind === 'TASK_REVIEW') {
    if (!job.task_id) {
      await rollbackClaim(job.id)
      return null
    }
    const task = await prisma.task.findUnique({
      where: { id: job.task_id },
      select: {
        id: true,
        title: true,
        status: true,
        implementation_plan: true,
        repo_url: true,
        story: { select: { acceptance_criteria: true } },
      },
    })
    if (!task) {
      await rollbackClaim(job.id)
      return null
    }
    const impl = await resolveTaskImplContext(task.id)
    // Diff-repo: task-override wint (spec §5 — cross-repo-taken; zelfde
    // bucket-regel als de PR-hergebruik-logica in update-job-status.ts).
    const diffRepoUrl = task.repo_url ?? job.product.repo_url

    let taskDiff: string | null = null
    let diffSource: 'compare' | 'pr' | null = null
    if (diffRepoUrl && impl.base_sha && impl.head_sha && impl.base_sha !== impl.head_sha) {
      const compared = await fetchCompareDiff({
        repoUrl: diffRepoUrl,
        baseSha: impl.base_sha,
        headSha: impl.head_sha,
      })
      if (typeof compared === 'string') {
        taskDiff = compared
        diffSource = 'compare'
      }
    }
    if (!taskDiff && impl.pr_url) {
      const prDiff = await fetchPrDiff({ prUrl: impl.pr_url })
      if (typeof prDiff === 'string') {
        taskDiff = prDiff
        diffSource = 'pr'
      }
    }
    if (!taskDiff) {
      // Een implementatie-review zonder diff is zinloos (spec §5/§10).
      await rollbackClaim(job.id)
      return null
    }

    const instruction = job.manual_drafts[0]?.prompt_md ?? ''
    return {
      job_id: job.id,
      kind: 'TASK_REVIEW',
      source: job.source,
      status: 'claimed',
      config,
      doc_index: docIndex,
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        implementation_plan: task.implementation_plan,
        acceptance_criteria: task.story?.acceptance_criteria ?? null,
      },
      impl: {
        plan_snapshot: impl.plan_snapshot,
        base_sha: impl.base_sha,
        head_sha: impl.head_sha,
        pr_url: impl.pr_url,
        execution_id: impl.execution_id,
        diff_source: diffSource,
      },
      task_diff: taskDiff,
      instruction,
      product: {
        id: job.product.id,
        name: job.product.name,
        repo_url: job.product.repo_url,
        definition_of_done: job.product.definition_of_done,
      },
      repo_url: diffRepoUrl,
      prompt_text: '',
    }
  }
```
Imports bovenin wait-for-job.ts: `fetchCompareDiff` (uit `../git/pr.js`, naast `fetchPrDiff`) + `resolveTaskImplContext` (uit `../lib/task-review-context.js`).

- [ ] **Stap 8.5: run → GREEN; suite; commit**
```bash
npx vitest run __tests__/lib/task-review-context.test.ts __tests__/tools/wait-for-job-task-review.test.ts && npm test
git add src/lib/task-review-context.ts src/tools/wait-for-job.ts __tests__/lib/task-review-context.test.ts __tests__/tools/wait-for-job-task-review.test.ts
git commit -m "feat(mcp): TASK_REVIEW-tak — impl-context-resolutie + compare/PR-diff-keten (Phase 3)"
```

---

### Taak 9: [mcp] volledige verify + PR

- [ ] **Stap 9.1:** `npm test` — verwacht: alles groen (baseline ≥712 + nieuwe tests). Draai ook de parity-/enum-drift-gates als die in `npm test` zitten (zo niet: `npx vitest run __tests__` dekt alles).
- [ ] **Stap 9.2:** `npx tsc --noEmit` (of `npm run typecheck` als dat script bestaat) — verwacht: 0 errors.
- [ ] **Stap 9.3:** push + PR via de Forgejo-API: titel `feat(mcp): SPEC_REVIEW + TASK_REVIEW — generieke review-pijplijn (Phase 3)`; body: korte samenvatting + verwijzing naar spec/plan-docs in de branch + Claude-Code-footer. **→ codex-review via s4m-queue → merge-gate.**

---

### Taak 10: [workers] vendor-bump + kinds/validatie/context-patch (TDD)

**Files:**
- Modify: `vendor/scrum4me-shared` (bump), `lib/manual-job-draft.ts`, `lib/manual-jobs/validation.ts`, `lib/manual-jobs/context-patch.ts`
- Test: volg de bestaande testbestanden naast deze modules (zoek `*.test.ts` naast/onder `lib/manual-jobs/`)

- [ ] **Stap 10.1: worktree + bump + baseline**
```bash
cd ~/Development/scrum4me-workers && git fetch origin
git worktree add ~/Development/scrum4me-workers-phase3 -b feat/codex-spec-task-review-phase3 origin/main
cd ~/Development/scrum4me-workers-phase3 && npm install
cd vendor/scrum4me-shared && git fetch origin && git checkout <SHARED_SHA> && cd ../..
bash scripts/gen-schema.sh > /dev/null && npx prisma generate
npm run verify
```
Verwacht: baseline groen (≥491 tests).

- [ ] **Stap 10.2: failing tests** voor validatie + context-patch:
1. `validateManualJobInput({ kind: 'SPEC_REVIEW', … })` zonder `docSlug` → fieldError `docSlug`; met ongeldige slug (`'Foo Bar'`) → fieldError; met geldige slug → ok.
2. `validateManualJobInput({ kind: 'TASK_REVIEW', … })` zonder `taskId` → fieldError `taskId`; met → ok.
3. beide kinds passeren de kind-allowlist (geen 'Onbekend handmatig jobtype').
4. `validateContextPatchShape('SPEC_REVIEW', {})` → error over docSlug; met geldige `docSlug` → ok.
5. `validateContextPatchShape('TASK_REVIEW', {})` → error over taskId; met `taskId` → ok.
6. `buildManualJobLaunchPreview` met kind SPEC_REVIEW + docSlug → `context.docSlug` aanwezig; met kind TASK_REVIEW + taskId → `context.taskId` aanwezig (bestaand generiek gedrag — borg het met een test).

- [ ] **Stap 10.3: run → RED.**

- [ ] **Stap 10.4: implementatie**

`lib/manual-jobs/validation.ts`:
```ts
/** ProductDoc-slug (kebab-case, zoals @db.VarChar(80) slugs in de DB). */
export const DOC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
```
MANUAL_JOB_KINDS (in dít bestand én in `lib/manual-job-draft.ts` — **beide arrays**, Phase 2-les):
```ts
const MANUAL_JOB_KINDS = [
  'TASK_IMPLEMENTATION',
  'IDEA_GRILL',
  'IDEA_MAKE_PLAN',
  'IDEA_REVIEW_PLAN',
  'PLAN_CHAT',
  'PR_REVIEW',
  'SPEC_REVIEW',
  'TASK_REVIEW',
] as const satisfies readonly [ClaudeJobKind, ...ClaudeJobKind[]]
```
`ManualJobValidationInput` + `docSlug?: unknown`. Regels ná het PR_REVIEW-blok:
```ts
  if (input.kind === 'SPEC_REVIEW') {
    if (isBlank(input.docSlug)) {
      addFieldError(result, 'docSlug', 'Doc-slug is verplicht voor een spec-review.')
    } else if (!DOC_SLUG_PATTERN.test((input.docSlug as string).trim())) {
      addFieldError(result, 'docSlug', 'Doc-slug moet kebab-case zijn (a-z, 0-9, koppeltekens).')
    }
  }
  if (input.kind === 'TASK_REVIEW' && isBlank(input.taskId)) {
    addFieldError(result, 'taskId', 'Task is verplicht voor een task-review.')
  }
```

`lib/manual-job-draft.ts`: `ManualJobDraftInput` + `docSlug?: string`; zod-schema + `docSlug: optionalTrimmedString`; in `buildManualJobLaunchPreview` het context-object uitbreiden:
```ts
    ...(input.kind === 'SPEC_REVIEW' && input.docSlug ? { docSlug: input.docSlug } : {}),
```
(`taskId` zit al generiek in het context-object — niet dupliceren.)

`lib/manual-jobs/context-patch.ts`: importeer `DOC_SLUG_PATTERN`; takken ná het PR_REVIEW-blok:
```ts
  } else if (kind === 'SPEC_REVIEW') {
    if (!isNonEmptyString(context.docSlug)) {
      errors.push('docSlug is verplicht (niet-lege string) voor spec-review.')
    } else if (!DOC_SLUG_PATTERN.test((context.docSlug as string).trim())) {
      errors.push('docSlug moet kebab-case zijn (a-z, 0-9, koppeltekens).')
    }
  } else if (kind === 'TASK_REVIEW') {
    if (!isNonEmptyString(context.taskId)) {
      errors.push('taskId is verplicht (niet-lege string) voor task-review.')
    }
  }
```

- [ ] **Stap 10.5: run → GREEN; commit**
```bash
npm run verify
git add vendor/scrum4me-shared prisma lib/manual-job-draft.ts lib/manual-jobs/validation.ts lib/manual-jobs/context-patch.ts <testbestanden>
git commit -m "feat(workers): SPEC_REVIEW/TASK_REVIEW kinds + docSlug-validatie + context-patch (Phase 3)"
```
(Welke gegenereerde prisma-bestanden meegaan: volg wat `git status` toont en wat Phase 2 #38 committe.)

---

### Taak 11: [workers] templates + editor-mapping + rehydratie (TDD)

**Files:**
- Modify: `lib/manual-jobs/templates.ts`, `components/jobs/manual-job-draft-editor.tsx`
- Test: bestaande template-/editor-testbestanden (zoek tests die `pr-review`-template of `inputValuesForSavedDraft` dekken en spiegel)

- [ ] **Stap 11.1: failing tests:**
1. template `spec-review` bestaat, kind SPEC_REVIEW, `defaultRuntime: 'codex'`, `defaultAdapter: 'codex_cli'`, `defaultCapability: 'review'`, niet-lege `promptSections`, velden `product_id` + `doc_slug` (required) + `instruction`.
2. template `task-review` idem met veld `task_id` (type `task_ref`, required).
3. rendered prompt van beide templates is niet-leeg met ingevulde velden (Phase 2-les: lege prompt blokkeert de save).
4. rehydratie: saved draft met `context.docSlug` → editor-inputValues `doc_slug` gevuld (spiegel de PR_REVIEW-rehydratie-test).

- [ ] **Stap 11.2: implementatie `templates.ts`**

`ManualJobTemplateKind` += `'SPEC_REVIEW' | 'TASK_REVIEW'`.

```ts
const specReviewSections: ManualJobPromptSection[] = [
  {
    id: 'doel',
    label: 'Doel',
    required: true,
    template: 'Review het spec-document met slug: {doc_slug}\n\n{instruction}',
  },
  {
    id: 'context',
    label: 'Context',
    required: true,
    template: 'Product: {product_name}\nRuntime: {runtime}',
  },
  {
    id: 'output',
    label: 'Output',
    required: true,
    template:
      'Leg een verdict (APPROVED / CHANGES_REQUESTED / REJECTED) met findings vast via submit_review.',
  },
]

const taskReviewSections: ManualJobPromptSection[] = [
  {
    id: 'doel',
    label: 'Doel',
    required: true,
    template: 'Onafhankelijke implementatie-review van de geselecteerde task tegen plan + acceptatiecriteria.\n\n{instruction}',
  },
  {
    id: 'context',
    label: 'Context',
    required: true,
    template: 'Product: {product_name}\nRuntime: {runtime}',
  },
  {
    id: 'output',
    label: 'Output',
    required: true,
    template:
      'Leg een verdict (APPROVED / CHANGES_REQUESTED / REJECTED) met findings vast via submit_review.',
  },
]
```

Template-objecten (in `manualJobTemplates`, ná `pr-review`; zelfde shape):
```ts
  {
    id: 'spec-review',
    version: 1,
    changelog: 'Initial Phase 3 spec-review template.',
    label: 'Spec-review (codex)',
    description: 'Laat codex een SPECS-ProductDoc beoordelen; verdict naar de ReviewLog.',
    kind: 'SPEC_REVIEW',
    defaultRuntime: 'codex',
    allowedRuntimes: [DEFAULT_MANUAL_RUNTIME, 'codex'],
    defaultAdapter: 'codex_cli',
    allowedAdapters: [DEFAULT_MANUAL_ADAPTER, 'codex_cli'],
    defaultCapability: 'review',
    fields: [
      { name: 'product_id', label: 'Product', type: 'product', required: true },
      {
        name: 'doc_slug',
        label: 'Doc-slug (folder SPECS)',
        type: 'string',
        required: true,
        placeholder: 'mijn-feature-design',
      },
      {
        name: 'instruction',
        label: 'Instructie',
        type: 'text',
        required: false,
        defaultValue: 'Beoordeel volledigheid, consistentie, ambiguïteit en scope.',
      },
    ],
    promptSections: specReviewSections,
  },
  {
    id: 'task-review',
    version: 1,
    changelog: 'Initial Phase 3 task-review template.',
    label: 'Task-review (codex)',
    description: 'Laat codex een task-diff tegen plan + acceptatie beoordelen; verdict naar de ReviewLog.',
    kind: 'TASK_REVIEW',
    defaultRuntime: 'codex',
    allowedRuntimes: [DEFAULT_MANUAL_RUNTIME, 'codex'],
    defaultAdapter: 'codex_cli',
    allowedAdapters: [DEFAULT_MANUAL_ADAPTER, 'codex_cli'],
    defaultCapability: 'review',
    fields: [
      { name: 'product_id', label: 'Product', type: 'product', required: true },
      { name: 'task_id', label: 'Task', type: 'task_ref', required: true },
      {
        name: 'instruction',
        label: 'Instructie',
        type: 'text',
        required: false,
        defaultValue: 'Toets dekking van het plan, scope-creep, kwaliteit en tests.',
      },
    ],
    promptSections: taskReviewSections,
  },
```
NB: controleer of de `task_ref`-picker in de editor kind-onafhankelijk werkt (hij bestaat voor TASK_IMPLEMENTATION). Filtert hij op kind, breid dan de conditie uit naar TASK_REVIEW — de bestaande editor-test rond `selectedTaskRef` wijst de plek.

- [ ] **Stap 11.3: editor-mapping + rehydratie** (`components/jobs/manual-job-draft-editor.tsx`)

In het `draft`-memo (zoek `prUrl: template.kind === 'PR_REVIEW'`):
```ts
    docSlug: template.kind === 'SPEC_REVIEW' ? (stringFromValue(inputValues.doc_slug) || undefined) : undefined,
```
In `inputValuesForSavedDraft` (zoek de PR_REVIEW-rehydratieregel):
```ts
  if (draft.kind === 'SPEC_REVIEW' && typeof draft.context.docSlug === 'string' && draft.context.docSlug.trim().length > 0) {
    nextValues.doc_slug = draft.context.docSlug
  }
```
(`taskId`-rehydratie is al generiek: `if (draft.context.taskId) nextValues.task_id = …`.)

- [ ] **Stap 11.4: run → GREEN; commit**
```bash
npm run verify
git add lib/manual-jobs/templates.ts components/jobs/manual-job-draft-editor.tsx <testbestanden>
git commit -m "feat(workers): spec-review + task-review templates + editor-keten (Phase 3)"
```

---

### Taak 12: [workers] enqueue-resolutie + KIND_LABELS + verify + PR (TDD)

**Files:**
- Modify: `actions/manual-jobs.ts`, `components/jobs/job-card.tsx`, `components/jobs/jobs-column.tsx`
- Test: bestaande enqueue-/action-tests (zoek de tests rond `readPrUrlFromLaunchPreview`/enqueue en spiegel)

- [ ] **Stap 12.1: failing tests (save→enqueue, spec §8):**
1. SPEC_REVIEW-draft zonder docSlug in launch-preview → enqueue weigert.
2. SPEC_REVIEW met docSlug die niet bestaat (of in een andere folder dan SPECS) → weigert met 'Geen SPECS-doc…'.
3. SPEC_REVIEW happy path → `claudeJob.create` met `doc_id` = het gevonden doc-id én `task_id: null`; **assert dat de lookup de compound-unique-vorm gebruikt** (`where: { product_id_folder_slug: { … } }`).
4. TASK_REVIEW zonder taskId → weigert; met onbekende task → 'Task niet gevonden…'; happy path → `task_id` gezet, `doc_id: null`.
5. `readDocSlugFromLaunchPreview` weigert strings die niet aan `DOC_SLUG_PATTERN` voldoen (raw-context-bypass-guard, zelfde patroon als `readPrUrlFromLaunchPreview`).

- [ ] **Stap 12.2: implementatie `actions/manual-jobs.ts`**

Helper (naast `readPrUrlFromLaunchPreview`; importeer `DOC_SLUG_PATTERN`):
```ts
function readDocSlugFromLaunchPreview(json: Prisma.JsonValue | null): string | null {
  if (!json || typeof json !== 'object') return null
  const context = (json as { context?: unknown }).context
  if (!context || typeof context !== 'object') return null
  const docSlug = (context as { docSlug?: unknown }).docSlug
  if (typeof docSlug !== 'string') return null
  const trimmed = docSlug.trim()
  if (trimmed.length === 0) return null
  // Guard tegen raw-context-editor-bypass (zelfde patroon als prUrl).
  return DOC_SLUG_PATTERN.test(trimmed) ? trimmed : null
}
```

In de transactie:
```ts
    const taskId = draft.kind === 'TASK_IMPLEMENTATION' || draft.kind === 'TASK_REVIEW'
      ? readTaskIdFromLaunchPreview(draft.launch_preview_json)
      : null
```
```ts
    const docSlug = draft.kind === 'SPEC_REVIEW'
      ? readDocSlugFromLaunchPreview(draft.launch_preview_json)
      : null
    let docId: string | null = null
    if (draft.kind === 'SPEC_REVIEW') {
      if (!docSlug) return { type: 'error', error: 'Doc-slug is verplicht voor een spec-review.' }
      // Compound unique (spec §8): @@unique([product_id, folder, slug]).
      const doc = await tx.productDoc.findUnique({
        where: { product_id_folder_slug: { product_id: draft.product_id, folder: 'SPECS', slug: docSlug } },
        select: { id: true },
      })
      if (!doc) return { type: 'error', error: 'Geen SPECS-doc met deze slug voor dit product.' }
      docId = doc.id
    }
```
Task-existence-guard uitbreiden (de bestaande `if (draft.kind === 'TASK_IMPLEMENTATION')`-check):
```ts
    if (draft.kind === 'TASK_IMPLEMENTATION' || draft.kind === 'TASK_REVIEW') {
      if (!taskId) {
        return {
          type: 'error',
          error: draft.kind === 'TASK_REVIEW'
            ? 'Task is verplicht voor een task-review.'
            : 'Task is verplicht voor handmatige task-implementatie.',
        }
      }
      const task = await tx.task.findFirst({
        where: { id: taskId, product_id: draft.product_id, product: { user_id: admin.userId, archived: false } },
        select: { id: true },
      })
      if (!task) return { type: 'error', error: 'Task niet gevonden voor dit product.' }
    }
```
`claudeJob.create`-data: vervang `task_id: null,` door
```ts
        task_id: draft.kind === 'TASK_REVIEW' ? taskId : null,
        doc_id: docId,
```
(TASK_IMPLEMENTATION blijft bewust `task_id: null` — byte-identiek bestaand gedrag; alleen TASK_REVIEW bindt de task aan de job. De `notifyPayload` blijft ongewijzigd.)

- [ ] **Stap 12.3: KIND_LABELS** — in `components/jobs/job-card.tsx` (regel ~33) en `components/jobs/jobs-column.tsx` (regel ~15), ná `PR_REVIEW`:
```ts
  SPEC_REVIEW: 'Spec-review',
  TASK_REVIEW: 'Task-review',
```
(`Record<ClaudeJobKind, string>` dwingt dit af — typecheck is de RED.)

- [ ] **Stap 12.4: volledige verify + PR**
```bash
npm run verify
git add actions/manual-jobs.ts components/jobs/job-card.tsx components/jobs/jobs-column.tsx <testbestanden>
git commit -m "feat(workers): enqueue-resolutie docSlug→doc_id + taskId→task_id + KIND_LABELS (Phase 3)"
git push -u origin feat/codex-spec-task-review-phase3
```
PR via API: `feat(workers): SPEC_REVIEW + TASK_REVIEW manual-enqueue (Phase 3)`. **→ codex-review via s4m-queue → merge-gate.**

---

### Taak 13: [rollout] deploys in bindende volgorde (user-gated, via s4m-queue)

Alles via queue-tasks naar `scrum4me-server:claude` (154) resp. `max2:claude`; geen SSH. Elke stap pas na expliciete gebruikers-autorisatie.

- [ ] **Stap 13.1:** web deployen + migreren (154; bestaande web-deploy-flow). Verifieer: `npx prisma migrate status` clean; `SELECT 1 FROM pg_enum WHERE enumlabel IN ('SPEC_REVIEW','TASK_REVIEW')` → 2 rijen; tabel `review_logs` bestaat.
- [ ] **Stap 13.2 (consumer-regel):** workers-image herbouwen + recreaten (154, ops-flow `update_scrum4me_workers`). Verifieer: draaiende Prisma-client kent beide kinds (Phase 2-methode: grep in `/app/node_modules/.prisma/client/`).
- [ ] **Stap 13.3:** docker no-op-check: bevestig op de docker-repo-master dat `bin/run-one-job.ts` geen kind-allowlist heeft die SPEC_REVIEW/TASK_REVIEW blokkeert en dat worktree-attach TASK_IMPLEMENTATION-only is. Wijziging nodig → STOP, rapporteer (dit plan voorziet géén docker-PR).
- [ ] **Stap 13.4:** beide `agent-codex`-workers herbouwen naar de mcp-merge-sha **mét cache-bust** (154 + max2) en healthy melden.

---

### Taak 14: [canary A] SPEC_REVIEW (GATE)

- [ ] **Stap 14.1:** seed vanaf 154 (queue-task): op het canary-product een wegwerp-ProductDoc in folder SPECS met geplante gebreken — minstens één TBD, één interne tegenspraak (sectie A zegt X, sectie C zegt niet-X), één dubbelzinnige eis. Daarna een `SPEC_REVIEW`/`CODEX`/`MANUAL`-job met `doc_id` + gekoppelde manual-draft (zelfde seed-structuur als `scripts/seed-codex-canary.ts` — maak hiervoor een seed-script-variant of seed via de workers-UI).
- [ ] **Stap 14.2:** volg de job (max2 of 154, read-only watch). **GO ⇔** job DONE + `review_logs`-rij (kind SPEC_REVIEW, `doc_id` + `doc_revision_id` gepind, verdict CHANGES_REQUESTED/REJECTED, findings raken de geplante gebreken) + summary-trace `SPEC_REVIEW <verdict> (n findings): …` + fleet ongestoord.
- [ ] **Stap 14.3:** NO-GO → run-log vastleggen, fix-forward, herseeden (bekende mechaniek). Wegwerp-doc na GO archiveren/verwijderen.

### Taak 15: [canary B] TASK_REVIEW (GATE)

- [ ] **Stap 15.1:** kies vanaf 154 een DONE-task **mét DONE-`SprintTaskExecution`** waar `base_sha IS NOT NULL AND head_sha IS NOT NULL AND base_sha <> head_sha` (spec §9; executie-vulling is 100%); op een publiek repo (web-route!). Seed een `TASK_REVIEW`/`CODEX`/`MANUAL`-job met `task_id` + draft.
- [ ] **Stap 15.2:** **GO ⇔** job DONE + `review_logs`-rij (task gepind, `sprint_task_execution_id` gezet, verdict + findings consistent met de diff) + summary-trace + `diff_source` benoemd in de review-summary + fleet ongestoord. Dit pint ook de web-`.diff`-route live.
- [ ] **Stap 15.3:** GO → Phase 3 afronden: DB-doc `architecture/codex-review-worker` bijwerken (rev 3), memory-track bijwerken, worktrees opruimen.

---

## Zelf-review-notities (spec-dekking)

- §4 schema → Taak 1/2; §5 payload-takken + diff-keten → Taken 7/8 (incl. `task.repo_url ?? product.repo_url`, `base!==head`, private-404→PR-fallback); §6 sink/upsert/revisie-pin → Taak 6; §7 prompts → Taak 4; §8 workers-ketens incl. compound-unique + save→enqueue-tests → Taken 10-12; §9 volgorde/consumer-regel/canaries → Taken 13-15; §10 error-paden → testcases in Taken 5-8; §12 TDD + volgorde → opbouw van dit plan.
- Bewust NIET gedaan: `notifyPayload.task_id` aanpassen (bestaand gedrag), TASK_IMPLEMENTATION `task_id: null` repareren (buiten scope), PR_REVIEW migreren naar ReviewLog (§13 out-of-scope), docker-wijzigingen (no-op-check in Taak 13.3).
