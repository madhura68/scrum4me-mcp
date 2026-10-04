# PR-review: plan vinden via PR-beschrijving en commits — Implementatieplan

**Status:** concept, wacht op akkoord van JP. Geen spec: de wijziging blijft binnen één
module plus de PR-reviewprompt van deze repo.

## Doel

JP: *"zoek uit waarom de PR-review die door een job wordt uitgevoerd altijd zegt: geen
gekoppeld plan gevonden"* → gekozen oplossing **A + B**: de PR-review krijgt het plan van
het werk mee, ook als de PR interactief is gemaakt.

**Oorzaak (gemeten 2026-10-04).** `resolvePrLinkedPlan` (`src/lib/pr-linked-plan.ts`) kent
twee routes: een `TASK_`/`SPRINT_IMPLEMENTATION`-job met exact dezelfde `pr_url`, of een
`Pbi.pr_url` met een `PbiDoc(role=PLAN)`. Interactief gemaakte PR's hebben geen van
beide. Over de laatste 60 dagen: 787 PR_REVIEW-jobs op 549 PR's; 3 met een
implementatiejob, 29 met PBI+PLAN-doc → **~4 % krijgt een plan**. De reviewer volgt dan
`src/prompts/pr/review.codex.md:26` en schrijft de bekende zin.

**Wat al beschikbaar is maar niet wordt gelezen:**
- **A — PR-beschrijving.** Recente PR's noemen het werk al: Scrum4Me#297 → `PBI-178`,
  `ST-1629`, `docs/plans/M43-landingspagina-showcase.md`; Ops-dashboard#280 → `PBI-24`,
  `ST-073`, `T-193`, `docs/plans/M44-vis-ops-en-media.md`; scrum4me-mcp#180 → `T-1972`.
  `getPullRequestState` haalt de beschrijving (`body`) al op, maar geeft hem niet door.
- **B — commits.** `log_commit` legt hashes vast in `story_logs` (1669 COMMIT-regels in
  60 dagen, ~half volledig 40 tekens, ~half 7 tekens). Proef op de 25 recentste PR's:
  6 matchen via een commit op een story.

**Eerst bruikbaar resultaat:** op de echte database en Forgejo geeft de nieuwe resolver
voor Scrum4Me#297, Ops-dashboard#280 en scrum4me-mcp#180 een gevuld `linked_plan`
(proef in Taak 4, vóór de promptwijziging en de uitrol).

**Hoe het zichtbaar wordt:** de reviewcomment van `s4m-codex-reviewer` op een nieuwe PR
met codes in de beschrijving zegt "plan gekoppeld via …" en toetst plan-conformiteit.

**Niet-doelen:**
- Geen nieuwe afspraak voor PR-beschrijvingen (optie C) en geen repobestand (optie D).
- Geen schemawijziging, geen migratie, geen nieuw tooltje.
- Geen wijziging aan de bestaande twee routes of hun volgorde.
- Geen cross-product-lookup: codes worden alleen binnen het product van de job opgezocht.
- Geen paginatie over meer dan 50 commits (zie Risico's).

## Ontwerpkeuzes

1. **Volgorde:** implementatiejob → `Pbi.pr_url` (beide ongewijzigd) → **A: verwijzingen
   in de PR-beschrijving** → **B: commit-hashes** → `null`. B draait alleen als A niets
   bruikbaars oplevert; dat houdt de uitkomst voorspelbaar en de payload klein.
2. **Productscope:** codes zijn uniek per `(product_id, code)`. Alle lookups filteren op
   `job.product_id`. Gecontroleerd: PR_REVIEW-jobs hangen aan het product van de repo
   (bijv. Scrum4Me → SCRUM4ME, scrum4me-mcp → SC2).
3. **Wat een verwijzing oplevert:**
   - `T-<n>` → taak: titel, `implementation_plan`, `story.acceptance_criteria`.
   - `ST-<n>` → story: titel, `acceptance_criteria` plus de plannen van zijn taken.
   - `PBI-<n>` → de nieuwste `PbiDoc(role=PLAN)`-revisie (zelfde query als de bestaande
     PBI-route, maar dan op code in plaats van `pr_url`).
   - `docs/…/*.md`-pad met `/plans/` of `/specs/` erin → bestandsinhoud op `head_sha`
     uit dezelfde repo (Forgejo raw-endpoint, zoals `src/dispatch/sources.ts:30`).
   - Mijlpaalcodes zoals `M43` worden genegeerd (geen DB-entiteit).
4. **B levert stories op**, niet taken: `story_logs` heeft geen `task_id`-kolom. Per
   gematchte story dezelfde inhoud als bij `ST-<n>`. Matching: een opgeslagen hash van
   ≥ 7 tekens die een prefix is van een PR-commit-SHA, binnen het product.
5. **Payloadvorm** (uitbreiding van `LinkedPlan`, bestaande velden blijven):
   - `source: 'job' | 'pbi' | 'pr_refs' | 'commits'`
   - `stories?: Array<{ code, title, acceptance_criteria, tasks: Array<{ code, title, implementation_plan }> }>`
   - `plan_docs?: Array<{ ref, content_md, truncated }>` — `ref` is het pad of de PBI-code
   - `references: string[]` — wat er gematcht is, zodat de reviewer het kan noemen
   Losse taken (`T-<n>`) worden onder hun story gegroepeerd.
6. **Grenzen:** max 8 stories, max 8 taken per story, max 3 plan-docs; elk tekstveld
   wordt afgekapt op 20 000 tekens met `truncated: true` (plan-docs) of een markering
   `…[afgekapt]` (taakplannen). Max 20 codes uit de beschrijving.
7. **Best-effort blijft:** elke Forgejo- of DB-fout in A of B valt terug op de volgende
   route; de bestaande `try/catch` in `wait-for-job.ts` blijft het vangnet.
8. **Padvalidatie:** alleen relatief, eindigt op `.md`, geen `..`-segment, geen `://`,
   ≤ 200 tekens; segmenten via `encodePathSegment`. Alleen de repo van de PR.

## Bestanden

| Bestand | Wijziging |
|---|---|
| `src/lib/pr-refs.ts` (nieuw) | `extractPrRefs(text)` — pure parser |
| `src/git/pr.ts` | `PrInfo.body`; `listPullRequestCommitShas`; `fetchRepoFileAtRef` |
| `src/lib/pr-linked-plan.ts` | routes A en B, uitgebreide `LinkedPlan`, grenzen |
| `src/tools/wait-for-job.ts` | `product_id`, `body` en `head_sha` doorgeven aan de resolver |
| `src/prompts/pr/review.codex.md`, `src/prompts/pr/review.md` | nieuwe velden, regel voor gedeeltelijke dekking |
| `scripts/probe-pr-linked-plan.ts` (nieuw) | alleen-lezen proef op echte DB + Forgejo |
| `__tests__/lib/pr-refs.test.ts` (nieuw), `__tests__/lib/pr-linked-plan.test.ts`, `__tests__/tools/wait-for-job-pr-review.test.ts`, test voor `src/git/pr.ts` | tests |

## Global constraints

- TypeScript NodeNext: relatieve imports mét `.js`.
- Testidioom zoals `__tests__/lib/pr-linked-plan.test.ts` (`vi.mock` op `../../src/prisma.js`)
  en `__tests__/tools/wait-for-job-pr-review.test.ts` (mocks op `src/git/pr.js`,
  `src/lib/pr-linked-plan.js`).
- Verificatie per taak: `npx vitest run <testbestand>`, daarna
  `npm run typecheck && npm run typecheck:tests`. Commit per taak, geen push tot de
  uitroltaak.

---

### Taak 1 — Verwijzingsparser `src/lib/pr-refs.ts`

**Interface:** `extractPrRefs(text: string): { task_codes: string[]; story_codes: string[]; pbi_codes: string[]; doc_paths: string[] }`
— ontdubbeld, in volgorde van voorkomen, elk lijstje max 20.

**Regels:** codes op woordgrens: `\bT-\d+\b`, `\bST-\d+\b`, `\bPBI-\d+\b`, exact zoals
geschreven (`ST-073` blijft `ST-073`; de DB slaat nullen op). Paden volgens ontwerpkeuze 8,
alleen met `/plans/` of `/specs/` erin. Markdown-links en backticks rond paden worden gestript.

**Acceptatie:** tests met geschoonde, echte beschrijvingen van Scrum4Me#297, Scrum4Me#292,
Ops-dashboard#280, scrum4me-mcp#180 en scrum4me-docker#106 (geen verwijzingen) geven exact
de verwachte lijsten. Negatieve gevallen: `docs/../x.md`, `https://…/plan.md`,
`M43`, `ST-1629abc`, `docs/INDEX.md` (geen plans/specs).

### Taak 2 — Forgejo-helpers in `src/git/pr.ts`

- `PrInfo` krijgt `body: string` (`pr.body ?? ''`); bestaande aanroepers blijven werken.
- `listPullRequestCommitShas({ prUrl }): Promise<string[] | { error }>` —
  `GET /repos/{o}/{r}/pulls/{i}/commits?limit=50`, alleen `sha`-velden.
- `fetchRepoFileAtRef({ prUrl, path, ref }): Promise<string | { error }>` —
  `GET /repos/{o}/{r}/raw/{path}?ref={sha}` via `forgejoFetch`; 404 → `{ error }`.

**Acceptatie:** unittests met gemockte `callForgejo`/`forgejoFetch`: juiste URL
(gecodeerde segmenten, `ref`-parameter), foutpad geeft `{ error }`, nooit een throw.

### Taak 3 — Resolver-routes A en B in `src/lib/pr-linked-plan.ts`

**Interface:** `resolvePrLinkedPlan(job: { id; pr_url; product_id }, pr?: { body: string; head_sha: string | null })`.
Zonder `pr` gedraagt hij zich als nu (achterwaarts compatibel voor bestaande tests).

**Gedrag:** ontwerpkeuzes 1–7. Route A: `extractPrRefs(pr.body)` → batch-queries
(`task.findMany`/`story.findMany`/`pbi.findMany` met `product_id` + `code: { in }`) →
plan-docs ophalen alleen als `head_sha` bekend is. Levert A minstens één story,
taak, of plan-doc met inhoud → `source: 'pr_refs'`. Route B: commit-SHA's ophalen →
kandidaat-prefixen (lengte 7–40) → `storyLog.findMany({ type: 'COMMIT', commit_hash: { in }, story: { product_id } })` →
stories → `source: 'commits'`.

In `wait-for-job.ts` de al opgehaalde `prInfo` doorgeven (`body`, `headSha`) plus
`job.product.id`; geen extra Forgejo-call voor de beschrijving.

**Acceptatie (tests):**
- bestaande routes winnen nog altijd van A en B;
- A: taakcode groepeert onder zijn story; storycode neemt taakplannen mee; PBI-code
  neemt de PLAN-revisie; pad wordt op `head_sha` gelezen; codes van een ander product
  matchen niet (query bevat `product_id`);
- A levert niets bruikbaars (onbekende codes, lege velden) → B draait;
- B: 7-tekenhash matcht volledige SHA; hash van een ander product matcht niet;
- grenzen: afkappen en tellingen zoals ontwerpkeuze 6;
- Forgejo-fout in A of B → volgende route, geen throw;
- `wait-for-job-pr-review.test.ts`: resolver krijgt `product_id`, `body`, `head_sha`.

### Taak 4 — Praktijkproef op echte data (vóór prompt en uitrol)

`scripts/probe-pr-linked-plan.ts`: alleen lezen; neemt de N recentste distinct
`pr_url`'s van PR_REVIEW-jobs, roept per PR dezelfde code aan als `wait-for-job`
(`getPullRequestState` + `resolvePrLinkedPlan`) en print per PR: `source`, `references`,
aantal tekens. Draait lokaal met de MCP-`DATABASE_URL` en `FORGEJO_TOKEN`; print geen
inhoud, geen tokens.

**Acceptatie:**
- Scrum4Me#297, Ops-dashboard#280 en scrum4me-mcp#180 krijgen `source: 'pr_refs'`
  met de verwachte verwijzingen;
- over de 25 recentste PR's: aantal met plan vóór/na rapporteren aan JP
  (nulmeting B: 6/25 via commits);
- geen PR leidt tot een exception of een payload boven ~100 000 tekens voor `linked_plan`.

Valt de dekking tegen of blijkt een grens verkeerd, eerst bijsturen en JP melden vóór Taak 5.

### Taak 5 — Reviewprompts bijwerken

`review.codex.md` en `review.md`:
- invoerveld `linked_plan` beschrijven met `source`, `references`, `stories`, `plan_docs`;
- bij een plan: kop "plan gekoppeld via <source>: <references>";
- **gedeeltelijke dekking:** een story kan over meerdere PR's lopen. Ontbrekende delen van
  het plan zijn een opmerking, geen blokkerende finding, tenzij de PR zegt het geheel
  af te ronden of de diff het plan tegenspreekt;
- de bestaande zin bij `linked_plan: null` blijft letterlijk staan.

**Acceptatie:** bestaande prompt-/kind-prompt-tests groen; diff van beide prompts
beperkt tot bovenstaande punten.

### Taak 6 — Verificatie, PR en uitrol

1. `npm test && npm run typecheck && npm run typecheck:tests` groen (deze repo heeft geen `verify`-script).
2. Push + PR op Forgejo — pas na akkoord van JP.
3. Na merge: vaststellen welke worker-stack de PR_REVIEW-jobs claimt
   (`claude_jobs.worker_instance_id` van recente PR_REVIEW-jobs) en die image herbouwen
   met de nieuwe `MCP_GIT_REF` via de bestaande deploy-flow van scrum4me-docker.
   `~/Development/scrum4me-mcp-stable` op de Mac bijwerken (`pull --ff-only` + `npm ci`).
4. **Gate:** de eerstvolgende PR met codes in de beschrijving krijgt een reviewcomment
   met "plan gekoppeld via …". Comment-URL vastleggen.
5. Productdoc over de PR-review (zoek met `search_product_docs "pr review linked plan"`)
   aanvullen met de vier routes en hun volgorde.

## Risico's

- **Verkeerde koppeling:** een beschrijving noemt "zie ook ST-12" voor ander werk. De
  reviewer krijgt dan een plan dat niet bij de diff past. Beperkt door de regel voor
  gedeeltelijke dekking en `references` in de body; JP ziet het meteen.
- **> 50 commits:** route B ziet alleen de eerste pagina. Bewust; route A dekt grote PR's
  meestal al.
- **Payloadgrootte:** grenzen uit ontwerpkeuze 6; Taak 4 meet het echte maximum.
- **Prompt- en codeversie lopen samen** omdat beide in deze repo en dezelfde image zitten.
