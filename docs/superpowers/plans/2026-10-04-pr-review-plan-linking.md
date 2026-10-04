# PR-review: plan vinden via PR-beschrijving en commits — Implementatieplan

**Status:** plan-review dubbel GO (ronde 2, 2026-10-04); wacht op akkoord van JP voor de ceremonie. Geen spec: de wijziging blijft binnen één
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
   - `references?: string[]` — wat er gematcht is, zodat de reviewer het kan noemen.
     Alleen gezet door `pr_refs` en `commits`; de bestaande routes `job`/`pbi` blijven
     byte-gelijk en laten het veld weg.
   - `omitted?: string[]` — verwijzingen die door het budget (keuze 6) zijn weggevallen.
   Losse taken (`T-<n>`) worden onder hun story gegroepeerd.
6. **Eén totaalbudget voor A en B:** `JSON.stringify(linked_plan).length` ≤ 100 000
   tekens. Het resultaat wordt in vaste volgorde gevuld:
   1. per story titel + `acceptance_criteria`;
   2. `implementation_plan` van expliciet genoemde taken (`T-<n>`);
   3. plan-docs (eerst paden, dan PBI-plannen), in volgorde van voorkomen;
   4. `implementation_plan` van de overige taken van genoemde of gematchte stories.

   Elk tekstveld wordt eerst afgekapt op 20 000 tekens (`truncated: true` bij plan-docs,
   markering `…[afgekapt]` bij taakplannen). Past een item niet meer in het restbudget, dan
   wordt het tot het restbudget afgekapt; alles daarna gaat naar `omitted`. Het budget
   geldt voor het **geserialiseerde** resultaat: escaping (`\n`, `\"`), sleutels, markeringen,
   `truncated` en `omitted` tellen mee. Reserveer vaste ruimte voor die metadata, kap af door
   het geserialiseerde item te meten (afkappen, opnieuw meten, inkorten), en controleer aan
   het eind de totale `JSON.stringify`-lengte. Plan-docs worden pas opgehaald als ze aan de
   beurt zijn in de vulvolgorde; is het budget op, dan volgt geen fetch meer. De bestaande
   routes `job`/`pbi` krijgen geen budget (ongewijzigd gedrag); Taak 4 meet alleen hun
   grootte. Uit de beschrijving telt per lijst (taken, stories, PBI's, paden) max 20
   verwijzingen.
7. **Best-effort blijft:** elke Forgejo- of DB-fout in A of B valt terug op de volgende
   route; de bestaande `try/catch` in `wait-for-job.ts` blijft het vangnet.
8. **Padvalidatie:** alleen relatief, eindigt op `.md`, geen `..`-segment, geen `://`,
   ≤ 200 tekens; segmenten via `encodePathSegment`. Alleen de repo van de PR.

## Bestanden

| Bestand | Wijziging |
|---|---|
| `src/lib/pr-refs.ts` (nieuw) | `extractPrRefs(text)` — pure parser |
| `src/git/pr.ts` | `PrInfo.body`; `listPullRequestCommitShas`; `fetchRepoFileAtRef` |
| `src/lib/pr-linked-plan.ts` | routes A en B, uitgebreide `LinkedPlan`, totaalbudget |
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
Routes A en B zijn ook los geëxporteerd, `resolvePlanViaPrRefs(job, pr)` en
`resolvePlanViaCommits(job, pr)`. `resolvePrLinkedPlan` roept ze zelf aan, en de proef in
Taak 4 gebruikt dezelfde functies: productie en proef delen één implementatie.

**Gedrag:** ontwerpkeuzes 1–8. Route A: `extractPrRefs(pr.body)` → batch-queries
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
- budget: een invoer met meerdere stories, lange taakplannen en drie plan-docs blijft
  onder `JSON.stringify(linked_plan).length` ≤ 100 000, vult in de volgorde van
  ontwerpkeuze 6 en zet de weggevallen verwijzingen in `omitted` (RED-controle: de test
  faalt zonder budget). De fixtures bevatten `\n` en `"`, zodat escaping meetelt;
- `job`/`pbi`-routes geven exact hetzelfde object als vóór de wijziging (geen
  `references`, geen budget). Assert met `toStrictEqual`, niet met het `toMatchObject` uit de
  bestaande tests: dat negeert extra sleutels;
- Forgejo-fout in A of B → volgende route, geen throw;
- `wait-for-job-pr-review.test.ts`: resolver krijgt `product_id`, `body`, `head_sha`.

### Taak 4 — Praktijkproef op echte data (vóór prompt en uitrol)

`scripts/probe-pr-linked-plan.ts`: alleen lezen. Invoer: expliciete PR-URL's als
argumenten, en/of `--recent N` (de N recentste distinct `pr_url`'s van PR_REVIEW-jobs).
`product_id` komt van de PR_REVIEW-job van die URL; zonder job via een match op
`Product.repo_url`; zonder beide meldt de proef "geen job/product" voor die PR in plaats van
hem over te slaan. Per PR roept hij dezelfde code aan als `wait-for-job`
(`getPullRequestState` + `resolvePrLinkedPlan`) en print hij: `source`, `references`,
`omitted`, aantal tekens, en of route B óók iets had gevonden als A al raak was (zodat
de meerwaarde van B zichtbaar is; via `resolvePlanViaCommits` uit Taak 3). Draait lokaal via `tsx` met de MCP-`DATABASE_URL` en
`FORGEJO_TOKEN`; print geen inhoud en geen tokens. Het script valt buiten beide
tsconfig-includes; de `tsx`-run in deze taak is zijn controle.

**Acceptatie:**
- `probe https://git.jp-visser.nl/janpeter/Scrum4Me/pulls/297 …/Ops-dashboard/pulls/280
  …/scrum4me-mcp/pulls/180`: alle drie `source: 'pr_refs'` met de verwachte verwijzingen;
- `--recent 25`: aantal met plan vóór/na rapporteren aan JP (nulmeting B: 6/25 via commits);
- geen PR leidt tot een exception; geen A/B-resultaat boven het budget van ontwerpkeuze 6;
  de grootste `job`/`pbi`-payload wordt gerapporteerd.

Valt de dekking tegen of blijkt een grens verkeerd, eerst bijsturen en JP melden vóór Taak 5.

### Taak 5 — Reviewprompts bijwerken

`review.codex.md` en `review.md`:
- invoerveld `linked_plan` beschrijven met `source`, `references?`, `omitted?`, `stories`,
  `plan_docs`;
- bij een plan: kop "plan gekoppeld via <source>" plus de `references` als die er zijn;
- **gedeeltelijke dekking:** een story kan over meerdere PR's lopen. Ontbrekende delen van
  het plan zijn een opmerking, geen blokkerende finding, tenzij de PR zegt het geheel
  af te ronden of de diff het plan tegenspreekt;
- **plan-conformiteit herformuleren** zodat die regel niet botst met bestaande tekst:
  `review.codex.md:12` ("correct en volledig") en `:16` ("plan-conform" als voorwaarde
  voor `APPROVED`), en `review.md:3`. Plan-conform betekent: geen tegenspraak met het
  plan, en niets ontbreekt van wat de PR zelf zegt af te ronden;
- de bestaande zin bij `linked_plan: null` blijft letterlijk staan.

**Acceptatie:** bestaande prompt-/kind-prompt-tests groen; diff van beide prompts
beperkt tot bovenstaande punten; geen resterende eis van "volledig" plan-conform
(`grep -n "volledig" src/prompts/pr/`).

### Taak 6 — Verificatie, PR en uitrol

1. `npm test && npm run typecheck && npm run typecheck:tests` groen (deze repo heeft geen `verify`-script).
2. Push + PR op Forgejo — pas na akkoord van JP.
3. Na merge: vaststellen welke worker-stack de PR_REVIEW-jobs claimt
   (`claude_jobs.worker_instance_id` van recente PR_REVIEW-jobs) en die image herbouwen
   met de nieuwe `MCP_GIT_REF` via de bestaande deploy-flow van scrum4me-docker.
   `~/Development/scrum4me-mcp-stable` op de Mac bijwerken (`pull --ff-only` + `npm ci`).
4. **Gate:** de eerstvolgende PR met codes in de beschrijving krijgt een reviewcomment
   met "plan gekoppeld via …". Comment-URL vastleggen.
5. Productdoc op SC2: er bestaat nog geen doc over de PR-review (gecontroleerd met
   `search_product_docs`). Maak er een in ARCHITECTURE met de vier routes, hun volgorde
   en het budget.

## Risico's

- **Verkeerde koppeling:** een beschrijving noemt "zie ook ST-12" voor ander werk. De
  reviewer krijgt dan een plan dat niet bij de diff past. Beperkt door de regel voor
  gedeeltelijke dekking en `references` in de body; JP ziet het meteen.
- **> 50 commits:** route B ziet alleen de eerste pagina. Bewust; route A dekt grote PR's
  meestal al.
- **Payloadgrootte:** A en B zijn begrensd door het totaalbudget van ontwerpkeuze 6. De
  bestaande routes en `pr_diff` blijven onbegrensd zoals nu; Taak 4 rapporteert hun
  grootste waarde.
- **Prompt- en codeversie lopen samen** omdat beide in deze repo en dezelfde image zitten.

## Review record

Formele review-loop (fase `plan`), gestart op verzoek van JP op 2026-10-04. Bedoeld waren
twee dispatch-jobs (`QUEUE_REVIEW`, `runtime: CODEX` en `runtime: CLAUDE`). Die gaven
allebei `DISPATCH_NOT_FOUND`: dispatch bedient alleen het Scrum4Me-product (allowlist,
profielen en managed workers; uitgewerkt in IDEA-233). Op besluit van JP lopen de rondes
daarom via de **listener-fallback**: `mac:codex` en `mac:claude`, door JP gearmd.

### Ronde 1 — revisie 1 @ `2ffc27ab`

- **Verzoeken:** `mac:codex` `7345d882-2bab-4f08-a35c-933bb6a4925b` (antwoord
  `25cf7649`), `mac:claude` `8ec1ccfa-73bb-4937-bfb9-4dae9e349094` (antwoord `9b8217fc`).
  Pins: plan `d62cf207…`, `CLAUDE.md` `df60a45f…`, phase-2-spec `38bbdf0f…`, alle op
  `2ffc27ab`. Presence vooraf: beide `beschikbaar`.
- **Uitslag:** codex 0 BLOCKER / 1 MAJOR / 1 MINOR → **NO-GO**; claude 0 / 0 / 4 MINOR →
  **GO**.
- **Bepalende bevinding (convergent):** de limieten per veld vermenigvuldigen in plaats van
  te begrenzen (tot ~1,3–1,5 M tekens), terwijl Taak 4 ~100 000 als grens noemt. Codex MAJOR,
  claude MINOR. Geverifieerd → **geaccepteerd**: ontwerpkeuze 6 is nu één totaalbudget
  (`JSON.stringify(linked_plan).length` ≤ 100 000) met vaste vulvolgorde en `omitted`, plus
  een budgettest met RED-controle in Taak 3. De routes `job`/`pbi` blijven onbegrensd en
  ongewijzigd; Taak 4 meet hun grootte.
- **Overige bevindingen, allemaal geverifieerd en geaccepteerd:**
  - `references` verplicht botst met de ongewijzigde routes (codex + claude) → optioneel,
    alleen gezet door `pr_refs`/`commits`; test dat `job`/`pbi` byte-gelijk blijven.
  - Regel voor gedeeltelijke dekking botst met `review.codex.md:12` ("volledig") en `:16`,
    en `review.md:3` (claude) → Taak 5 herformuleert die regels, met grep-acceptatie.
  - De proef hoeft de drie acceptatie-PR's niet te bevatten (claude) → Taak 4 accepteert
    expliciete URL's, met productafleiding via de job of `repo_url`, en meldt "geen
    job/product".
  - Codelimiet stond twee keer anders (claude) → per lijst max 20.
  - Taak 6.5 veronderstelde een bestaande productdoc (claude) → nieuwe doc in ARCHITECTURE.
  - Proefscript valt buiten de tsconfig-includes (claude) → expliciet: de `tsx`-run is
    zijn controle.
  - Optioneel (claude): de proef rapporteert ook of B iets had gevonden als A al raak was →
    overgenomen, kost één kolom.
- **Afgewezen:** geen.
- **Scope-delta:** geen werk toegevoegd buiten de opdracht. Het budget vervangt de
  veldlimieten; de proef krijgt expliciete invoer en één extra kolom. Het eerste bruikbare
  resultaat en de praktijkproef (Taak 4) blijven gelijk en op dezelfde plek.

### Ronde 2 — revisie 2 @ `f51754dc`

- **Verzoeken:** `mac:codex` `6db0c1a1-0f66-4f2c-b7b4-e6fab364c7e3` (antwoord
  `c2a71171`), `mac:claude` `4af68b50-3fac-4dfb-91b6-005158064dc9` (antwoord `87b062f4`).
  Pins: plan `d31bf3ed…`, `CLAUDE.md` `df60a45f…`, phase-2-spec `38bbdf0f…`, alle op
  `f51754dc`. Presence vooraf: beide `beschikbaar`.
- **Uitslag:** codex 0 / 0 / 0 → **GO**; claude 0 / 0 / 3 MINOR → **GO**. **Dubbel GO.**
- **Reparaties uit ronde 1:** volgens beide reviewers hebben alle vijf standgehouden.
- **MINOR-bevindingen (claude), geverifieerd en na het dubbele GO verwerkt:**
  - Het budget moet op het geserialiseerde resultaat gemeten worden (escaping, metadata), en
    plan-docs moeten lazy opgehaald worden → toegevoegd aan ontwerpkeuze 6; de budgettest
    gebruikt fixtures met `\n` en `"`.
  - De test "exact hetzelfde object" kan met het `toMatchObject`-idioom (test:38/44/49/74/89)
    geen extra sleutels vangen → `toStrictEqual` voorgeschreven.
  - De B-kolom in de proef vereist een los aanroepbare route B → Taak 3 exporteert
    `resolvePlanViaPrRefs` en `resolvePlanViaCommits`; de proef gebruikt die.
  - Deze drie zijn MINOR-verduidelijkingen binnen het bestaande ontwerp, zonder nieuwe scope.
    Er volgde geen delta-ronde; JP kan er een vragen.
- **Afgewezen:** geen.
- **Scope-delta:** geen. Eerste bruikbare resultaat en praktijkproef ongewijzigd.

**Fase `plan` afgerond (dubbel GO).** Volgende stap: de ceremonie (sprint, PBI, story, taken
op SC2), pas na akkoord van JP. Technisch GO autoriseert geen uitvoering, merge of deployment.
