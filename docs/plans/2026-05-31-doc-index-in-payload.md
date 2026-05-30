---
title: "Doc-index in job-payload (worker doc-discovery)"
status: draft
author: claude
date: 2026-05-31
---

# Doc-index in de job-payload

## Probleem

Workers (vooral de plan-worker, IDEA_MAKE_PLAN) komen slecht aan de juiste
documentatie. Waarneming uit een live run (IDEA-103): de agent deed 3 blinde
`search_product_docs`-FTS-calls — één met een ongeldige folder `"design"` — kreeg
0 hits, en riep `list_product_docs` nooit aan. Tegelijk heeft het product
(SCRUM4ME) álle 9 folders aan en ~78 active docs (18 patterns, 14 plans, 13 adr,
13 runbooks, 9 architecture, …). De bottleneck is **discovery**: de worker weet
niet wélke docs bestaan of wáár te kijken, en gokt folders/zoektermen.

## Doel

`getFullJobContext` injecteert een compacte **`doc_index`** in elke job-payload:
per folder een vaste "wat hoort hier"-beschrijving + de live active doc-titels
(met `folder`+`slug` als directe handle voor `get_product_doc`). De worker ziet
bij het lezen van `$PAYLOAD_PATH` meteen welke docs bestaan en leest de relevante
gericht, i.p.v. blind te FTS-zoeken.

Beslissingen (vastgelegd in brainstorm 2026-05-31):
- **Mechanisme:** push (in de payload), niet pull (geen nieuwe on-demand tool).
- **Scope:** alle job-kinds (idea grill/plan/review + task + sprint + de
  manual/orchestrator/plan_chat-branches; allemaal hebben een product).
- **Granulariteit:** per folder beschrijving + active doc-titels + slug.
- **Prompt:** één regel toevoegen aan de kind-prompts zodat de agent het veld kent.

## Data-shape (`doc_index` in payload.json)

```jsonc
"doc_index": {
  "product_id": "cmohrysyj0000rd17clnjy4tc",
  "folders": [
    {
      "folder": "patterns",
      "description": "Herbruikbare code- en gebruikspatronen, conventies en do/don't.",
      "doc_count": 18,
      "docs": [
        { "title": "MD3 styling tokens", "slug": "md3-styling-tokens" }
        // … tot de cap
      ],
      "truncated": false
    }
    // architecture, adr, runbooks, … — folders met 0 active docs worden weggelaten
  ],
  "hint": "Active docs only. Lees er één met get_product_doc({product_id, folder, slug}); full-text via search_product_docs."
}
```

`null` (of weggelaten) wanneer het product geen active docs heeft.

## Componenten (alle in `scrum4me-mcp`)

### 1. `src/lib/product-doc-folders.ts` — folder-beschrijvingen
Voeg een geëxporteerde map toe (1 regel per van de 9 folders). Gespiegeld van
Scrum4Me's canonieke taxonomie (zelfde DRY-noot als de bestaande mappings in dit
bestand).

```ts
export const PRODUCT_DOC_FOLDER_DESCRIPTIONS: Record<ProductDocFolderApi, string> = {
  adr: 'Architecture Decision Records: vastgelegde keuzes met context, alternatieven en consequenties.',
  architecture: 'Systeem- en service-ontwerp: componenten, grenzen, data-flow, integraties.',
  grills: 'Resultaten van idee-grill-sessies: probleemverkenning, scope-afbakening, beslissingen.',
  patterns: "Herbruikbare code- en gebruikspatronen, conventies en do/don't.",
  plans: 'Implementatieplannen per PBI/idee: stories en taken.',
  runbooks: 'Operationele procedures: deploy, incident-respons, onderhoud.',
  specs: 'Functionele en technische specificaties van features.',
  manual: 'Eindgebruikers- en producthandleiding.',
  api: "API-referentie: endpoints, schema's, contracten.",
}
```

### 2. `src/lib/doc-index.ts` (nieuw) — `buildDocIndex`
Eén query op `product_docs`, groeperen per folder, beschrijving eraan, cap.

```ts
export interface DocIndexDoc { title: string; slug: string }
export interface DocIndexFolder {
  folder: ProductDocFolderApi
  description: string
  doc_count: number      // totaal active in deze folder (vóór cap)
  docs: DocIndexDoc[]     // tot DOC_INDEX_FOLDER_CAP, op updated_at desc
  truncated: boolean
}
export interface DocIndex {
  product_id: string
  folders: DocIndexFolder[]
  hint: string
}

export const DOC_INDEX_FOLDER_CAP = 40

export async function buildDocIndex(productId: string): Promise<DocIndex | null>
```

Logica:
- Lees `product.enabled_doc_folders`; geen product of geen enabled folders → `null`.
- `prisma.productDoc.findMany({ where: { product_id, status: 'active', folder: { in: enabledDb } }, select: { folder, slug, title, updated_at }, orderBy: [{folder:'asc'},{updated_at:'desc'}] })`.
- Groepeer per folder; per folder `doc_count` = totaal, `docs` = eerste `DOC_INDEX_FOLDER_CAP` (op updated_at desc), `truncated = doc_count > cap`.
- Folders met 0 active docs weglaten.
- Map DB-folder → API-folder (bestaande `productDocFolderToApi`), beschrijving uit `PRODUCT_DOC_FOLDER_DESCRIPTIONS`.
- `folders` leeg → `null` (niets te tonen).
- Pure t.o.v. prisma; los testbaar met mocked prisma (zoals `resolve-entity.test.ts`).

### 3. `src/tools/wait-for-job.ts` — injectie in `getFullJobContext`
`claude_jobs.product_id` is gezet voor álle relevante kinds (idea/task/sprint),
en `job.product.id` is al in de `include`. Bereken de index daarom **één keer**
direct na de bestaande `if (!job) return null` + `resolveJobConfig`, best-effort:

```ts
const docIndex = await buildDocIndex(job.product.id).catch((err) => {
  console.warn(`[wait-for-job] buildDocIndex failed for ${job.product.id}:`, err)
  return null
})
```

Spread vervolgens `doc_index: docIndex` in **elk** teruggegeven object
(MANUAL, ORCHESTRATOR, PLAN_CHAT, IDEA_*, SPRINT_IMPLEMENTATION, TASK_IMPLEMENTATION).
Een `buildDocIndex`-fout mag het claimen nooit breken (vandaar `.catch`).

### 4. Kind-prompts — één regel (push-aankondiging)
Voeg aan de payload-context-uitleg van elke kind-prompt onder `src/prompts/`
(make-plan.md, grill.md, review-plan.md, task/implementation.md,
sprint/implementation.md, plan-chat/chat.md) één regel toe, bijv.:

> `doc_index`: bestaande ProductDocs per folder (met beschrijving + titels). Lees
> relevante docs met `get_product_doc({product_id, folder, slug})` vóór je begint;
> gebruik `search_product_docs` voor full-text en `list_product_docs` voor de
> volledige index (bij `truncated`).

(In make-plan.md past dit in het `$PAYLOAD_PATH`-veldenlijstje rond regel 18-26.)

## Regels / randgevallen
- **Active-only** (geen draft/archived) — anders 53 draft-plans + 44 draft-grills als ruis.
- Alleen **enabled_doc_folders** (consistent met search/list defaults).
- Folder met 0 active docs → weggelaten; geen docs totaal → `doc_index: null`.
- Cap **40 docs/folder** (updated_at desc) + `truncated` + `doc_count`.
- **Primair product only** (v1). Idea-`secondary_products` en cross-repo `task.repo_url` → buiten scope.
- Best-effort: index-fout breekt `getFullJobContext` niet.
- Payload-impact: ~active docs × ~60 chars (SCRUM4ME ~78 ≈ ~5KB); cap dekt uitschieters.

## Test
- `__tests__/lib/doc-index.test.ts` (mocked prisma): groepering per folder; active-only filter; enabled-folder filter; cap + `truncated`/`doc_count`; beschrijving gekoppeld; lege input → `null`; folder→API-mapping.
- `getFullJobContext`-context-tests: bestaande blijven groen; nieuw: `doc_index` aanwezig in een TASK- en een SPRINT-context; een gegooide `buildDocIndex` levert `doc_index: null` zonder dat de context faalt.
- `tsc --noEmit` clean; volledige suite groen.

## Buiten scope
- Pull-tool (`get_doc_index`) of prompt-zware variant.
- Multi-product (secondary products, cross-repo task-repo).
- Draft/archived docs in de index.
- Semantische/embedding-ranking (search_product_docs doet al FTS).

## Self-review
- Placeholders: geen — shape, signatures, folder-beschrijvingen en wiring zijn concreet.
- Consistentie: `product_id`+`folder`+`slug` matchen `get_product_doc`'s inputschema; folder-enum = bestaande `PRODUCT_DOC_FOLDERS_API`.
- Scope: één repo (scrum4me-mcp), één implementatieplan; geschikt.
- Ambiguïteit: productId-bron = `job.product.id` voor alle branches (sprint-job heeft ook `product_id`); cap/`truncated` expliciet.
