# Phase 1 — plan-review op codex — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Een `agent-codex`-fleet-worker draait `IDEA_REVIEW_PLAN`-jobs als autonome actieve-verbeteraar (3-ronde-herschrijf, geen mens-gate), admin-selecteerbaar in de workers-UI, bewezen via een seed-canary.

**Architecture:** Runtime-bewuste promptselectie in mcp (`getKindPromptText(kind, runtime)`) wijst `(IDEA_REVIEW_PLAN, CODEX)` naar een nieuwe codex-portable prompt; de docker-runner (gezaghebbend) geeft de runtime door; workers maakt codex selecteerbaar voor deze template + zet een correct `requested_model`-snapshot. Hergebruikt de bestaande payload-tak, sink (`update_idea_plan_reviewed`) en runtime-claim-routing (Phase 0, live).

**Tech Stack:** Node 22 + tsx; vitest (mcp + workers); `@openai/codex` CLI `0.137.0-alpha.4`; Prisma 7; Docker multi-stage (Phase 0).

**Spec (dubbel-GO):** `docs/superpowers/specs/2026-06-08-codex-plan-review-phase1-design.md` — scrum4me-server:claude operationeel GO + mac:codex bron-review GO (round-2).

**Repos & branches:** mcp → `feat/codex-plan-review-phase1` (deze worktree, off `origin/main`); docker → nieuwe worktree off `origin/master`; workers → nieuwe worktree off `origin/main`. De docker-image-build pint `MCP_GIT_REF` op de mcp-branch tot die merget.

---

## Grounded facts (verbatim geverifieerd 2026-06-08)

- **mcp `src/lib/kind-prompts.ts`**: `getKindPromptText(kind)` (regel 34) + `getIdeaPromptText(kind)` (regel 46) zijn **kind-only**; `cache: Partial<Record<ClaudeJobKind,string>>` (regel 16) is op kind gekeyd; `KIND_TO_PROMPT_PATH` (regel 25-32) bevat `IDEA_REVIEW_PLAN: 'idea/review-plan.md'`. `loadPrompt(rel)` (regel 18) leest `src/prompts/<rel>`.
- **mcp `src/worker-runtime.ts`**: `export type WorkerRuntime = 'CLAUDE' | 'CODEX'`; `getWorkerRuntimeFromEnv()`.
- **mcp `src/tools/update-idea-plan-reviewed.ts`**: input `{ idea_id, review_log (passthrough), approval_status?: 'pending'|'approved'|'rejected' }`; `approved` → `PLAN_REVIEWED`, anders → `PLAN_REVIEW_FAILED` (regel 17-40); `IdeaLog`-summary leest `reviewLog.approval?.status || 'pending'` (regel 114-118).
- **mcp `src/prompts/idea/review-plan.md`**: bestaande Claude-prompt — 3-ronde + `ask_user_question`-gate + `update_idea_plan_md` per ronde. **Blijft ongewijzigd** (Claude-pad).
- **docker `bin/run-one-job.ts` (origin/master:364)**: `const promptText = getKindPromptText(ctx.kind).replace('$PAYLOAD_PATH', payloadPath)`; daarna `const cwd = worktreePath ?? '/opt/agent'` (:365) en `if (runtime === 'CODEX') { args = buildCodexArgs({ promptText, cwd }) }` (:367-370). `runtime` is in scope (Phase 0).
- **workers `actions/manual-jobs.ts:98`**: `const snapshot = snapshotFromConfig(resolveJobConfig({ kind: draft.kind }, product))`; gespreid in `claudeJob.create` (regel 100-115). `draft.runtime` is `'CLAUDE'|'CODEX'` (uppercase; check op regel 87).
- **mcp `src/lib/job-config.ts:253-259`**: `snapshotFromConfig` → `{ requested_model, requested_thinking_budget, requested_permission_mode }` (NIET `model_id`). `ClaudeJob.model_id` wordt door de worker gezet via `update_job_status` (`update-job-status.ts:853-855`).
- **workers `lib/manual-jobs/templates.ts`**: `WorkerRuntime` uit `@/lib/job-runtime` is `'claude'|'codex'` (lowercase); `DEFAULT_MANUAL_RUNTIME = 'claude'` (regel 68); `idea-review-plan`-template op regel 335-381, `allowedRuntimes: [DEFAULT_MANUAL_RUNTIME]` op **regel 343**.
- **workers test**: vitest; `__tests__/actions/manual-jobs.test.ts` mockt `prisma` + `resolveJobConfig`/`snapshotFromConfig` via `@shared/job-config` (echte impl); CLAUDE-enqueue assert `requested_model: 'claude-haiku-4-5-20251001'` (regel 119), CODEX-enqueue-test op regel 215-254.
- **mcp `scripts/seed-codex-canary.ts`**: patroon voor de seed (Phase 0).

---

## File structure

| Repo | Bestand | Verantwoordelijkheid |
|---|---|---|
| mcp | Create `src/prompts/idea/review-plan.codex.md` | codex-portable autonome review-prompt |
| mcp | Modify `src/lib/kind-prompts.ts` | runtime-bewuste prompt-selectie (compound cache-key) |
| mcp | Test `__tests__/lib/kind-prompts.test.ts` | TDD selectie |
| mcp | Create `scripts/seed-idea-review-codex-canary.ts` | seed IDEA_REVIEW_PLAN+CODEX met rijk plan_md |
| docker | Modify `bin/run-one-job.ts` | `getKindPromptText(ctx.kind, runtime)` |
| workers | Modify `actions/manual-jobs.ts` | `requested_model`-override voor CODEX |
| workers | Modify `__tests__/actions/manual-jobs.test.ts` | TDD override |
| workers | Modify `lib/manual-jobs/templates.ts` | `idea-review-plan` codex-selecteerbaar |

**Cross-repo volgorde:** mcp-PR (Task 1-4) eerst → docker-PR (Task 5, pint `MCP_GIT_REF`) → workers-PR (Task 6-7) → canary (Task 8). Elke PR codex-gereviewd; merges door de gebruiker geautoriseerd.

---

## Task 1: mcp — codex-portable review-prompt

**Files:**
- Create: `src/prompts/idea/review-plan.codex.md`

Work from `/Users/janpetervisser/Development/scrum4me-mcp-codex-plan-review` (branch `feat/codex-plan-review-phase1`). Dit is een prompt-/content-bestand (geen unit-test; de selectie-test in Task 2 verifieert dat het laadt en de juiste discriminators bevat).

- [ ] **Step 1: Create `src/prompts/idea/review-plan.codex.md`** met exact deze inhoud:

````markdown
# Review-Plan-prompt voor IDEA_REVIEW_PLAN-jobs (Codex-runtime, autonoom)

> Deze prompt wordt door de docker-runner meegegeven aan `codex exec` voor een
> `IDEA_REVIEW_PLAN`-job met runtime=CODEX. Iteratieve review met **actieve
> plan-revisie** en een **autonoom verdict** (geen mens-goedkeuringsvraag).

Runtime: CODEX. Je bent een **plan-review-orchestrator** voor een Scrum4Me-idee.

## Context

Lees het payload-bestand op `$PAYLOAD_PATH` (JSON). Daarin staan onder meer:
- `idea.id`, `idea.code`
- `idea.plan_md`: het te reviewen plan-document (YAML frontmatter + body)
- `idea.grill_md`: scope / acceptatie / risico uit de grill-fase
- `product`: gekoppeld product (`definition_of_done`, repo-context)
- `doc_index`: bestaande ProductDocs per folder

Lees relevante docs met `mcp__scrum4me__get_product_doc({ product_id, folder, slug })`;
`mcp__scrum4me__search_product_docs` voor full-text; `mcp__scrum4me__list_product_docs`
voor de volledige index. Gebruik je eigen bestands-tools om repo-bestanden in de
werkmap te lezen (er zijn geen Claude-specifieke tool-namen nodig).

## Doel

Drie iteratieve review-rondes. Na elke ronde herschrijf je het plan en persisteer je
de herziene versie via `mcp__scrum4me__update_idea_plan_md`. De review werkt op
convergentie af (< 5% wijziging twee rondes achtereen). **Je bepaalt zelf het verdict
— er is geen mens-goedkeuringsvraag.**

## Setup (voor ronde 0)

1. Lees `idea.plan_md` volledig (uit het payload-bestand).
2. Lees `idea.grill_md` voor scope/acceptatie-context.
3. Laad codex (verplicht): lees in de werkmap `docs/patterns/**` (patronen),
   `docs/architecture/**` (systeemdesign) en `CLAUDE.md` (hardstop-regels — nooit
   schenden). Gebruik je eigen bestands-tools.
4. Initialiseer `review_log`:
   { "plan_file": "<idea.code>", "created_at": "<now>", "rounds": [],
     "approval": { "status": "pending" } }

## Review-rondes

- **Ronde 0 — Structuur & Syntax**: YAML parseable; verplichte velden (`pbi.title`,
  `stories`, `tasks`); priority 1-4; geen lege strings; markdown intact. Herschrijf:
  corrigeer structuur/formatting.
- **Ronde 1 — Logica & Patronen**: stories volgen uit grill-criteria; tasks concreet
  (bestandsnamen/commando's); patronen uit `docs/patterns/` gevolgd; `verify_required`
  coherent; dependency-cascades geadresseerd. Herschrijf: vul gaten, maak specifieker.
- **Ronde 2 — Risico & Edge Cases**: grote taken gesplitst; refactors met
  undo-strategie; schema-changes met migratie-taken; type-checking expliciet;
  concurrency/error-handling per actie; feature-flags voor grote changes. Herschrijf:
  voeg mitigatie toe, split taken.

## Plan-revisie (na elke ronde — verplicht)

1. Sla de huidige versie op als `plan_before` in `review_log.rounds[N]`.
2. Herschrijf `plan_md` met de gevonden verbeteringen.
3. Bereken `diff_pct = changed_lines / total_lines * 100`.
4. Sla `plan_after` + `issues` + `score` + `diff_pct` op in `review_log.rounds[N]`.
5. Persisteer via `mcp__scrum4me__update_idea_plan_md({ idea_id: <idea.id>, plan_md: <herziene tekst> })`.
   **Als deze call faalt**: log het als een `error`-severity issue in
   `review_log.rounds[N].issues` en zet `review_log.plan_write_failed = true`.
   Een schrijffout blokkeert `approved` (zie Verdict).

## Convergentie

Na ronde 1+: als `diff_pct_this_round < 5` EN `prev_round_diff_pct < 5` → CONVERGED.
Sla op: `review_log.convergence = { stable_at_round: N, final_diff_pct, convergence_metric: "plan_stability" }`.
Stop bij convergentie of na ronde 2 (max 3 rondes).

## Verdict (autonoom — geen mens-goedkeuring)

Bepaal `approval_status`:
- `approved` ⇔ het plan is **geconvergeerd** EN er staan **geen `error`-severity issues**
  open na de laatste ronde EN `review_log.plan_write_failed` is niet gezet.
- anders `rejected`.

**Verdict-sync (verplicht):** zet `review_log.approval.status` gelijk aan
`approval_status` en `review_log.approval.timestamp` op nu. Zonder deze sync toont het
auditlog "Status: pending" terwijl de idee al getransitioneerd is.

Sluit af:
1. `mcp__scrum4me__update_idea_plan_reviewed({ idea_id: <idea.id>, review_log, approval_status })`
2. `mcp__scrum4me__update_job_status({ job_id: <job.id>, status: 'done', summary: review_log.summary })`

(De sink transitioneert de idee: `approved` → `PLAN_REVIEWED`, anders → `PLAN_REVIEW_FAILED`.)

## Output-format review_log (strikt JSON)

{
  "plan_file": "IDEA-016",
  "created_at": "ISO8601",
  "rounds": [
    { "round": 0, "role": "Structure Review", "focus": "YAML/format/syntax",
      "plan_before": "<plan_md voor>", "plan_after": "<plan_md na>",
      "issues": [ { "category": "structure|logic|risk|pattern",
                    "severity": "error|warning|info", "suggestion": "wat te fixen" } ],
      "score": 75, "plan_diff_lines": 12, "converged": false, "timestamp": "ISO8601" }
  ],
  "convergence": { "stable_at_round": 2, "final_diff_pct": 2.1, "convergence_metric": "plan_stability" },
  "plan_write_failed": false,
  "approval": { "status": "approved|rejected", "timestamp": "ISO8601" },
  "summary": "1-2 zinnen: X rondes, Y% eindwijziging, verdict"
}

## Foutgevallen

- **Plan parse-fout**: `mcp__scrum4me__update_job_status({ job_id, status: 'failed', error: 'plan_parse_failed' })` — stop.
- **`update_idea_plan_md` mislukt**: log als `error`-severity issue + `plan_write_failed = true`
  (blokkeert `approved`). Bij herhaalde/laatste-ronde schrijffout: roep
  `update_idea_plan_reviewed(..., approval_status: 'rejected')` met de faal-reden, of faal de job.

## Aannames & Limieten

- Geen directe model-switching; alle rondes draaien op het codex-model. De rollen
  (structuur/logica/risico) worden strikt gescheiden gehouden.
- Repo is leesbaar in de werkmap; gebruik je eigen bestands-tools.
- Max 3 rondes (0-2). Per ronde max 10 issues gelogd (overige → samenvatting).
````

- [ ] **Step 2: Verify discriminators** — Run:
```bash
cd /Users/janpetervisser/Development/scrum4me-mcp-codex-plan-review
grep -c "Runtime: CODEX" src/prompts/idea/review-plan.codex.md   # expect >= 1
grep -c "ask_user_question" src/prompts/idea/review-plan.codex.md # expect 0
```
Expected: first ≥1, second 0. (These are the markers Task 2's test asserts.)

- [ ] **Step 3: Commit**
```bash
git add src/prompts/idea/review-plan.codex.md
git commit -m "feat(codex): codex-portable IDEA_REVIEW_PLAN prompt (autonomous, no human gate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: mcp — runtime-bewuste prompt-selectie (TDD)

**Files:**
- Modify: `src/lib/kind-prompts.ts`
- Test: `__tests__/lib/kind-prompts.test.ts`

- [ ] **Step 1: Write the failing test** — create `__tests__/lib/kind-prompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { getKindPromptText, getIdeaPromptText } from '../../src/lib/kind-prompts.js'

describe('getKindPromptText runtime-awareness', () => {
  it('returns the codex variant for (IDEA_REVIEW_PLAN, CODEX)', () => {
    const text = getKindPromptText('IDEA_REVIEW_PLAN', 'CODEX')
    expect(text).toContain('Runtime: CODEX')
    expect(text).not.toContain('ask_user_question')
  })

  it('returns the existing Claude prompt for (IDEA_REVIEW_PLAN, CLAUDE)', () => {
    const text = getKindPromptText('IDEA_REVIEW_PLAN', 'CLAUDE')
    expect(text).toContain('ask_user_question')
  })

  it('defaults to CLAUDE when runtime is omitted (back-compat)', () => {
    expect(getKindPromptText('IDEA_REVIEW_PLAN')).toBe(getKindPromptText('IDEA_REVIEW_PLAN', 'CLAUDE'))
  })

  it('uses the shared prompt for non-overridden kinds regardless of runtime', () => {
    expect(getKindPromptText('PLAN_CHAT', 'CODEX')).toBe(getKindPromptText('PLAN_CHAT', 'CLAUDE'))
    expect(getKindPromptText('TASK_IMPLEMENTATION', 'CODEX')).toBe(getKindPromptText('TASK_IMPLEMENTATION', 'CLAUDE'))
  })

  it('getIdeaPromptText threads runtime through', () => {
    expect(getIdeaPromptText('IDEA_REVIEW_PLAN', 'CODEX')).toBe(getKindPromptText('IDEA_REVIEW_PLAN', 'CODEX'))
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`getKindPromptText` neemt nog geen 2e arg; CODEX-call geeft de Claude-prompt → `toContain('Runtime: CODEX')` faalt).
Run: `npx vitest run __tests__/lib/kind-prompts.test.ts`

- [ ] **Step 3: Rewrite `src/lib/kind-prompts.ts`** naar:

```ts
// Loader voor embedded prompts per ClaudeJob-kind (+ optionele runtime-variant).
//
// De .md-bestanden in src/prompts/<kind>/ worden meegebakken zodat elke runner ze
// kan inlezen zonder externe plugin-dependency. De docker-runner leest de juiste
// prompt via getKindPromptText(ctx.kind, runtime) en geeft die door als prompt.
//
// Variabele-vervanging ($PAYLOAD_PATH) gebeurt door de runner zelf.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ClaudeJobKind } from '@prisma/client'
import type { WorkerRuntime } from '../worker-runtime.js'

const cache = new Map<string, string>()

function loadPrompt(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/lib/kind-prompts.ts → src/lib → src → src/prompts/<rel>
  const path = join(here, '..', 'prompts', rel)
  return readFileSync(path, 'utf8')
}

const KIND_TO_PROMPT_PATH: Partial<Record<ClaudeJobKind, string>> = {
  IDEA_GRILL: 'idea/grill.md',
  IDEA_MAKE_PLAN: 'idea/make-plan.md',
  IDEA_REVIEW_PLAN: 'idea/review-plan.md',
  TASK_IMPLEMENTATION: 'task/implementation.md',
  SPRINT_IMPLEMENTATION: 'sprint/implementation.md',
  PLAN_CHAT: 'plan-chat/chat.md',
}

// Runtime-specifieke overrides. Ontbreekt een (runtime, kind)-override, dan valt de
// selectie terug op KIND_TO_PROMPT_PATH (= het bestaande, runtime-neutrale pad).
const RUNTIME_PROMPT_OVERRIDES: Partial<Record<WorkerRuntime, Partial<Record<ClaudeJobKind, string>>>> = {
  CODEX: {
    IDEA_REVIEW_PLAN: 'idea/review-plan.codex.md',
  },
}

export function getKindPromptText(kind: ClaudeJobKind, runtime: WorkerRuntime = 'CLAUDE'): string {
  const rel = RUNTIME_PROMPT_OVERRIDES[runtime]?.[kind] ?? KIND_TO_PROMPT_PATH[kind]
  if (!rel) return ''
  const key = `${runtime}:${kind}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const text = loadPrompt(rel)
  cache.set(key, text)
  return text
}

// Back-compat re-export voor de idea-kinds + PLAN_CHAT; threadt runtime door.
export function getIdeaPromptText(kind: ClaudeJobKind, runtime: WorkerRuntime = 'CLAUDE'): string {
  if (
    kind !== 'IDEA_GRILL' &&
    kind !== 'IDEA_MAKE_PLAN' &&
    kind !== 'IDEA_REVIEW_PLAN' &&
    kind !== 'PLAN_CHAT'
  ) return ''
  return getKindPromptText(kind, runtime)
}
```

- [ ] **Step 4: Run — expect PASS** (5 cases). Run: `npx vitest run __tests__/lib/kind-prompts.test.ts`
- [ ] **Step 5: Run the full suite — no regression** (`getIdeaPromptText`-call-sites in `wait-for-job.ts` blijven werken met de default `CLAUDE`). Run: `npx vitest run` — verwacht groen, geen nieuwe failures.
- [ ] **Step 6: Typecheck** — `npx tsc --noEmit` passes.
- [ ] **Step 7: Commit**
```bash
git add src/lib/kind-prompts.ts __tests__/lib/kind-prompts.test.ts
git commit -m "feat(codex): runtime-aware prompt selection (compound cache key)

(IDEA_REVIEW_PLAN, CODEX) -> review-plan.codex.md; all other (kind, runtime)
combinations unchanged; runtime defaults to CLAUDE so existing call-sites are
byte-identical.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: mcp — seed-script voor de canary

**Files:**
- Create: `scripts/seed-idea-review-codex-canary.ts`

- [ ] **Step 1: Create `scripts/seed-idea-review-codex-canary.ts`** met exact deze inhoud (rijk, bewust-verbeterbaar `plan_md` + `grill_md` zodat de 3-ronde-herschrijf bijt — spec §4/§8 P2-2):

```ts
// seed-idea-review-codex-canary.ts — create one claimable IDEA_REVIEW_PLAN CODEX
// job for the Phase 1 canary, against a throwaway PLAN_READY idea whose plan_md is
// deliberately improvable (so the 3-round rewrite has real work to do).
// Usage: CANARY_PRODUCT_ID=<id> npx tsx scripts/seed-idea-review-codex-canary.ts
import { prisma } from '../src/prisma.js'

const PLAN_MD = `---
pbi:
  title: Add CSV export to the report page
stories:
  - title: Export current report as CSV
    tasks:
      - title: add export button
      - title: wire the download
---

# Plan

Add a CSV export to the report page. The button calls an endpoint that returns the
rows. Probably reuse the existing query. Add a column header row. Should be quick.
`

const GRILL_MD = `## Scope
Admin report page only. CSV must reflect the same filters as the on-screen table.

## Acceptance
- Clicking Export downloads a .csv with the currently filtered rows.
- The header row matches the visible columns.
- Large exports (10k+ rows) do not block the UI.

## Risks
- Filter state must be passed to the export, not re-derived.
- Encoding / delimiter for non-ASCII content.
`

async function main() {
  const productId = process.env.CANARY_PRODUCT_ID
  if (!productId) throw new Error('CANARY_PRODUCT_ID env is required')
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, user_id: true, name: true },
  })
  if (!product) throw new Error(`product ${productId} not found`)

  const idea = await prisma.idea.create({
    data: {
      user_id: product.user_id,
      product_id: product.id,
      code: `CODEXPLANREVIEW-${Date.now()}`,
      title: 'Codex Phase 1 plan-review canary',
      status: 'PLAN_READY',
      plan_md: PLAN_MD,
      grill_md: GRILL_MD,
    },
    select: { id: true, code: true },
  })

  const job = await prisma.claudeJob.create({
    data: {
      user_id: product.user_id,
      product_id: product.id,
      idea_id: idea.id,
      kind: 'IDEA_REVIEW_PLAN',
      status: 'QUEUED',
      runtime: 'CODEX',
      source: 'SYSTEM',
      required_capability: 'review',
    },
    select: { id: true },
  })

  console.log(JSON.stringify({ ok: true, idea: idea.code, idea_id: idea.id, job_id: job.id, product: product.name }))
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` passes (Prisma-accessors + enum-literals geverifieerd tegen de generated client: `kind: 'IDEA_REVIEW_PLAN'`, `runtime: 'CODEX'`, `source: 'SYSTEM'`, `status: 'QUEUED'`, `required_capability: 'review'`).
- [ ] **Step 3: Commit**
```bash
git add scripts/seed-idea-review-codex-canary.ts
git commit -m "chore(codex): seed an IDEA_REVIEW_PLAN CODEX canary with an improvable plan_md

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: mcp — PR + codex review

- [ ] **Step 1: Push + open PR** (`feat/codex-plan-review-phase1` → `main`) via de Forgejo-API (token via `--config` process-substitution). Body: codex-prompt + runtime-bewuste selectie (getest) + seed; referenties naar spec + plan.
- [ ] **Step 2: Vraag codex-review** aan via de s4m-queue (`push --to mac:codex --type review_request`, body single-quoted zonder backtick/$/apostrophe), `cwd = /Users/janpetervisser/Development`. Verwerk bevindingen tot GO.
- [ ] **Step 3: Merge** na expliciete gebruiker-autorisatie. Daarna is `MCP_GIT_REF` voor de docker-build `main`.

---

## Task 5: docker — runtime doorgeven aan de prompt-selectie

**Files:**
- Modify: `bin/run-one-job.ts`

Maak een geisoleerde docker-worktree off `origin/master` (branch `feat/codex-plan-review-phase1`). **Geen unit-test-harness** — verificatie = tsx-load + de canary (Task 8) + code-review.

- [ ] **Step 1: Edit `bin/run-one-job.ts`** — verander de prompt-regel (origin/master:364) van:
```ts
    const promptText = getKindPromptText(ctx.kind).replace('$PAYLOAD_PATH', payloadPath)
```
naar:
```ts
    const promptText = getKindPromptText(ctx.kind, runtime).replace('$PAYLOAD_PATH', payloadPath)
```
(`runtime` is al in scope — Phase 0; bewezen door `if (runtime === 'CODEX')` op :367.)

- [ ] **Step 2: Verify it loads under tsx** (geen docker tsc). Run:
```bash
cd <docker-worktree>
SCRUM4ME_WORKER_RUNTIME=CODEX node --import tsx --eval "import('./bin/run-one-job.ts').catch(e=>{console.error(String(e).slice(0,200));process.exit(0)})" 2>&1 | head -5
```
Expected: importeert zonder syntax-/resolutie-fout (vroege exit op ontbrekende DB/auth-env is OK; `Cannot find module '/opt/scrum4me-mcp/...'` is verwacht op de mac — die paden bestaan alleen in de image). **Bindende gate: de canary (Task 8).**

- [ ] **Step 3: Commit + PR + codex-review + merge** (zelfde discipline als Task 4). De image-build pint `MCP_GIT_REF` op de mcp-branch tot Task 4 gemerged is; daarna `main`.
```bash
git add bin/run-one-job.ts
git commit -m "feat(codex): pass runtime to getKindPromptText for codex prompt selection

run-one-job is the authoritative prompt source for CODEX (buildCodexArgs); thread
the worker runtime into getKindPromptText so IDEA_REVIEW_PLAN+CODEX gets the
codex-portable prompt.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: workers — `requested_model`-override voor CODEX (TDD)

**Files:**
- Modify: `actions/manual-jobs.ts`
- Test: `__tests__/actions/manual-jobs.test.ts`

Maak een geisoleerde workers-worktree off `origin/main` (branch `feat/codex-plan-review-phase1`).

- [ ] **Step 1: Write the failing test** — voeg toe aan de bestaande `describe('enqueueManualJobAction', …)` in `__tests__/actions/manual-jobs.test.ts`:

```ts
  it('snapshots requested_model as codex-default for CODEX (not the product Claude model)', async () => {
    process.env.SCRUM4ME_ENABLE_CODEX_WORKERS = 'true'
    mockDraftFindUnique.mockResolvedValue({
      id: 'draft-1',
      user_id: 'admin1',
      product_id: 'prod-1',
      title: 'Codex review',
      kind: 'IDEA_REVIEW_PLAN',
      runtime: 'CODEX',
      required_capability: 'review',
      status: 'DRAFT',
    })
    const { enqueueManualJobAction } = await import('@/actions/manual-jobs')

    const result = await enqueueManualJobAction('draft-1')

    expect(result.ok).toBe(true)
    expect(mockJobCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runtime: 'CODEX',
        requested_model: 'codex-default',
      }),
    })
  })
```

- [ ] **Step 2: Run — expect FAIL** (zonder override krijgt de CODEX-job `requested_model: 'claude-haiku-4-5-20251001'` uit `product.preferred_model`).
Run: `npx vitest run __tests__/actions/manual-jobs.test.ts -t "codex-default"`

- [ ] **Step 3: Edit `actions/manual-jobs.ts:98`** — verander:
```ts
    const snapshot = snapshotFromConfig(resolveJobConfig({ kind: draft.kind }, product))
```
naar:
```ts
    const snapshot = {
      ...snapshotFromConfig(resolveJobConfig({ kind: draft.kind }, product)),
      // CODEX kiest zelf zijn model; vervang het misleidende Claude-snapshot-label.
      // requested_model is het queue-time config-veld (geen migratie; model_id is het
      // runtime/usage-veld dat de worker later via update_job_status zet).
      ...(draft.runtime === 'CODEX' ? { requested_model: 'codex-default' } : {}),
    }
```

- [ ] **Step 4: Run — expect PASS.** Run: `npx vitest run __tests__/actions/manual-jobs.test.ts`
Expected: het nieuwe test-geval slaagt **en** "queues a job from a saved draft" (CLAUDE) blijft groen (`requested_model: 'claude-haiku-4-5-20251001'` ongewijzigd).
- [ ] **Step 5: Commit**
```bash
git add actions/manual-jobs.ts __tests__/actions/manual-jobs.test.ts
git commit -m "feat(codex): snapshot requested_model=codex-default for CODEX manual jobs

Override the queue-time requested_model snapshot for CODEX so the board does not
show a misleading Claude model; never writes a fake model_id (that is the runtime
usage field). Workers-only; no @shared change, no migration.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: workers — codex selecteerbaar voor `idea-review-plan` + gate-env

**Files:**
- Modify: `lib/manual-jobs/templates.ts`

- [ ] **Step 1: Edit `lib/manual-jobs/templates.ts:343`** — alléén in het `idea-review-plan`-template-object (id op regel 336), verander:
```ts
    allowedRuntimes: [DEFAULT_MANUAL_RUNTIME],
```
naar:
```ts
    allowedRuntimes: [DEFAULT_MANUAL_RUNTIME, 'codex'],
```
(`WorkerRuntime` is `'claude'|'codex'` lowercase; `defaultRuntime` blijft `DEFAULT_MANUAL_RUNTIME` = `'claude'`. **Raak de andere templates niet aan** — regels 220/260/301/389/426 blijven `[DEFAULT_MANUAL_RUNTIME]`.)

- [ ] **Step 2: Verify only one template changed** — Run:
```bash
cd <workers-worktree>
grep -n "allowedRuntimes: \[DEFAULT_MANUAL_RUNTIME, 'codex'\]" lib/manual-jobs/templates.ts
```
Expected: precies **één** regel (343).

- [ ] **Step 3: Run verify** — Run: `npm run verify` (lint + typecheck + vitest). Expected: groen.
- [ ] **Step 4: Commit**
```bash
git add lib/manual-jobs/templates.ts
git commit -m "feat(codex): allow codex runtime for the idea-review-plan template

Only the idea-review-plan template gets allowedRuntimes += 'codex'; defaultRuntime
stays claude. The SCRUM4ME_ENABLE_CODEX_WORKERS gate still applies at enqueue.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: PR + codex-review + merge** (Task 6 + Task 7 in één workers-PR). Na merge: zet/bevestig `SCRUM4ME_ENABLE_CODEX_WORKERS=true` op de workers/web-env (nodig voor het UI-pad; de seed-canary niet — spec §8 P3-2). Dit is een ops-env-stap, geen code.

---

## Task 8: host — seed-canary + UI-pad (via s4m-queue, gegate)

Dit draait op een fleet-host (154/max2) — niet de mac. Phase 0 is live; de canary bewijst alléén de Phase 1-prompt + de schrijftools-keten. **Prereq:** mcp-PR (Task 4) gemerged of `MCP_GIT_REF` op de mcp-branch gepind; docker-PR (Task 5) gebouwd. Dispatch als s4m-queue-task naar `scrum4me-server:claude`, gegate, stap voor stap.

- [ ] **Step 1: Build de agent-codex-image** met `MCP_GIT_REF` op de Phase 1-mcp-ref. **Build-gotcha (spec §12 P3-3):** bouw de `agent-codex`-service **zonder** `--target`-flag (de target staat in de compose-service-def) en mét cache-bust — `docker compose build --target codex` faalt op een unknown flag, en zonder cache-bust blijft de mcp-clone-laag gecached.
- [ ] **Step 2: Seed** — `CANARY_PRODUCT_ID=cmopqumt9000004joksfaf3wc npx tsx /opt/scrum4me-mcp/scripts/seed-idea-review-codex-canary.ts` → een `IDEA_REVIEW_PLAN`/`CODEX`/`QUEUED`-job met het rijke `plan_md`. (Product = scrum4me-docker, Phase-0-product, niet-verstorend.)
- [ ] **Step 3: Laat `agent-codex` claimen** (draait al op scale 1 op 154 én max2; doorgaans claimt **max2 HIGH_P** — elke agent-codex bewijst de prompt; wil je 154-lokaal bewijs, forceer `required_capability=LOW_P` of pauzeer max2). Observeer de run-log.
- [ ] **Step 4: GO ⇔ alle:** job → `DONE`; idea → `PLAN_REVIEWED` (of `PLAN_REVIEW_FAILED` mét reden); `plan_review_log` gevuld (rondes + convergence + summary); `review_log.approval.status` == `approval_status` (géén "Status: pending" in het `IdeaLog`); `plan_md` **substantieel herzien** t.o.v. de seed (zichtbare `update_idea_plan_md`-schrijf); 0 auth/MCP-fouten; geen hang; de Claude-`worker-idea`-fleet liep ongestoord door.
- [ ] **Step 5: UI-pad** — met `SCRUM4ME_ENABLE_CODEX_WORKERS=true` queue't een admin de `idea-review-plan`-template met runtime=codex → identiek resultaat (bewijst template/gate/`requested_model`-snapshot).
- [ ] **Step 6: NO-GO →** run-log vastleggen, fix-forward in de juiste repo (vrijwel zeker `review-plan.codex.md`), canary herhalen. Niet door naar fase 2 tot de canary `DONE` is.

---

## Self-review

**Spec-coverage (§2-§8):** codex-prompt (§3/§5) → Task 1 ✓; runtime-bewuste selectie + getIdeaPromptText (§4 mcp) → Task 2 ✓; rijk seed (§4/§8 P2-2) → Task 3 ✓; mcp-PR (§12) → Task 4 ✓; docker runtime-doorgifte, runner gezaghebbend (§4 docker / P1-2) → Task 5 ✓; `requested_model`-override niet `model_id` (§4 workers / P1-1) → Task 6 ✓; template allowedRuntimes + gate-env (§4 workers / §8 P3-2) → Task 7 ✓; verdict-sync (P2-3) → Task 1 (prompt) + Task 8 Step 4 (canary-assertie) ✓; plan-write-fout blokkeert approved (P2-4) → Task 1 (prompt) + Task 8 Step 4 ✓; seed-first canary + claimer-tier + product_id + no-op rescale (§8) → Task 8 ✓; cross-repo volgorde (§12) → Task 4→5→7→8 ✓. **Out-of-scope** (spec §13: spec/PR/task-review, auto-dispatch, Claude-prompt, schema/migratie/shared, override-parity) → geen taak, correct.

**Placeholder-scan:** geen TBD/TODO. Elke code-/content-stap toont de volledige inhoud. Task 5 Step 2's tsx-load is best-effort op de mac (de `/opt/scrum4me-mcp`-imports resolven alleen in de image) — expliciet gemarkeerd, bindende gate = de canary.

**Type-consistentie:** `getKindPromptText(kind, runtime: WorkerRuntime = 'CLAUDE')` (Task 2) wordt identiek aangeroepen in Task 5; `WorkerRuntime` = `'CLAUDE'|'CODEX'` (mcp) vs `'claude'|'codex'` (workers-template, Task 7) — bewust onderscheiden en beide correct toegepast; `requested_model` (Task 6) matcht `snapshotFromConfig`-output; de prompt-discriminators `Runtime: CODEX` / géén `ask_user_question` (Task 1) matchen de test-asserties (Task 2).
