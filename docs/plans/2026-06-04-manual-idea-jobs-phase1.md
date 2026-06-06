---
title: "Manual idea-jobs fase 1: grill → plan handoff + instruction-sturing"
status: draft
author: claude
date: 2026-06-04
verified: 2026-06-06
audit_verdict: done
---

# Manual idea-jobs — fase 1

## Doel (fase 1)
Vanuit de manual job-editor een **idee kiezen**, **grill** draaien (werkt `grill_md`
van dat echte idee bij), dan **plan** draaien (pakt diezelfde `grill_md` op, schrijft
`plan_md`), en de uitkomst analyseren via het bestaande Ops-dashboard (worker-logs +
insights). Geen sandbox. De vrije `instruction` moet het agent-gedrag mee sturen.
(Sprint-batch = fase 2.)

## Bevindingen (waarom dit nodig is)
- Een MANUAL idea-job heeft **`job.idea_id = null`** — bewust (commit `3a54ffc`
  "keep null") zodat de idee-lifecycle-cascades niet vuren (een mislukte test mag
  het echte idee niet op `*_FAILED` zetten; `update_job_status` keyt op `job.idea_id`).
- `getFullJobContext`'s **MANUAL-branch geeft geen `idea`-context** (alleen
  `manual_draft`), dus `grill.md`/`make-plan.md` — die `payload.idea` verwachten —
  vinden niets en grijpen naar `get_idea_context` (niet allowlisted) → fouten.
- De draft's `launch_preview_json` bevat **wél** `context.ideaId` (grondwaarheid uit
  DB), maar **niet** `instruction` — de V2-`inputValues.instruction` overleeft de
  V2→draft-plumbing niet.

## Ontwerp-beslissingen
- **`job.idea_id` blijft null.** mcp laadt de idea via `launch_preview.context.ideaId`,
  niet via de FK → geen revert van `3a54ffc`, geen fail-cascade. Lees-/schrijf-koppeling
  op de inhoud (`grill_md`/`plan_md`) zónder lifecycle-koppeling.
- **Instruction stuurt via de payload** (bewezen patroon: de `doc_index`-prompt-regel
  wordt in productie echt opgepakt). De runner blijft ongewijzigd.
- **Analyse** = bestaand Ops-dashboard. Geen werk.

## Scope (4 stukken, 2 repos)
| # | Repo | Stuk | Fase-1-volgorde |
|---|---|---|---|
| 1 | mcp | MANUAL-branch laadt `idea`-context (uit `context.ideaId`) | **eerst** |
| 2 | mcp | `grill.md`/`make-plan.md` honoreren `payload.instruction` | **eerst** |
| 3 | workers | V2-plumbing: persisteer `instruction` (+ `constraints`) in de draft | daarna |
| 4 | workers | raw-payload-editor (inputValues hand-editen vóór enqueue) | daarna |

Stuk 1+2 zijn de schone kritieke unblock (idea-handoff werkt meteen, raakt codex' V2-werk niet).

---

## Stuk 1 — mcp: MANUAL-branch laadt idea-context

**Bestand:** `src/tools/wait-for-job.ts` (`getFullJobContext`, de `if (job.source === 'MANUAL')`-branch ~701).
**Helper:** nieuw `src/lib/manual-idea-context.ts` (leesbaar + los testbaar).

- Idea-kinds = `IDEA_GRILL | IDEA_MAKE_PLAN | IDEA_REVIEW_PLAN`.
- Lees `ideaId`/`instruction` veilig uit `draft.launch_preview_json` (Json/unknown):
  `launch_preview_json.context.ideaId` (string) en `.context.instruction` (string|undefined).
- Bij een idea-kind + aanwezige `ideaId`: laad de idea met dezelfde includes als de
  SYSTEM idea-branch en map naar dezelfde shape:
  ```ts
  const idea = await prisma.idea.findUnique({
    where: { id: ideaId },
    include: {
      pbi: { select: { id: true, code: true, title: true } },
      plan_doc: { select: { current_revision: { select: { content_md: true } } } },
      grill_doc: { select: { current_revision: { select: { content_md: true } } } },
    },
  })
  // map → { id, code, title, description,
  //   grill_md: idea.grill_doc?.current_revision?.content_md ?? idea.grill_md,
  //   plan_md:  idea.plan_doc?.current_revision?.content_md  ?? idea.plan_md,
  //   status, product_id }
  ```
- Voeg aan het MANUAL-return-object toe (naast de bestaande velden):
  `idea: <mapped|null>`, `pbi: idea?.pbi ?? null`, `instruction: <string|null>`.
- Best-effort: faalt het laden, dan `idea: null` (breekt de claim niet). `job.idea_id`
  ongemoeid (blijft null).

**Test** `__tests__/lib/manual-idea-context.test.ts` (mocked prisma): leest ideaId+instruction
uit launch_preview; laadt+mapt idea (grill_md uit revision, fallback legacy); idea-kind
zonder ideaId → null; non-idea-kind → geen idea-load.

## Stuk 2 — mcp: prompts honoreren `instruction`

**Bestanden:** `src/prompts/idea/grill.md`, `src/prompts/idea/make-plan.md`.
Voeg in de payload-velden-uitleg toe:
> - `instruction` (optioneel): aanvullende sturing van de gebruiker. Als aanwezig,
>   volg deze bovenop de standaard-werkwijze van deze prompt.

En in de Werkwijze een regel: "Als `payload.instruction` aanwezig is, weeg die mee in je
vragen/plan."

**Verificatie:** `grep -l instruction src/prompts/idea/{grill,make-plan}.md`; volledige suite groen.

---

## Stuk 3 — workers: persisteer `instruction` (+ constraints) in de draft  (fase-1, daarna)
De draft-creatie bouwt `launch_preview_json.context` met alleen `ideaId`. Breid uit zodat
`context.instruction` (en `context.constraints`) uit de V2-`inputValues` worden meegenomen,
zodat mcp (stuk 1) ze kan lezen. Raakt codex' V2-plumbing — afstemmen/duidelijk afbakenen.

## Stuk 4 — workers: raw-payload-editor  (fase-1, daarna)
Een "raw"-modus in `manual-job-draft-editor.tsx`: de `inputValues` als JSON hand-editen vóór
enqueue, met live preview van de resulterende `launch_preview` + validatie.

---

## Buiten scope (fase 2)
- Sprint-batch manual jobs.
- `job.idea_id`-FK persisteren / lifecycle-koppeling (bewust null gehouden).
- Sandbox-product / data-isolatie.

## Resultaat na stuk 1+2
Manual `IDEA_GRILL` op een gekozen idee → leest `idea`, draait `grill.md` (gestuurd door
`instruction` zodra stuk 3 de instruction persisteert) → schrijft `grill_md`. Manual
`IDEA_MAKE_PLAN` → leest de bijgewerkte `grill_md` → schrijft `plan_md`. Analyse via dashboard.
(Tot stuk 3 er is: idea-handoff werkt al; instruction-sturing volgt zodra de workers-kant 'm bewaart.)
