# PR-review: plan vinden over productgrenzen heen — Implementatieplan

**Status:** plan-review dubbel GO (ronde 2, 2026-10-04); K1 = ja (JP); ceremonie gedaan op SC2 (S-2026-10-04-2, PBI-33, ST-053, T-163…T-167); wacht op uitvoeropdracht. Vervolg op
`docs/superpowers/plans/2026-10-04-pr-review-plan-linking.md` (ST-052, live sinds `a843a79`).
Geen spec: de wijziging blijft binnen de plan-lookup van de PR-review en de reviewprompts.

## Doel

JP: *"maak een plan voor productoverschrijdend zoeken"*. ST-052 zoekt codes en commits alleen
binnen het product van de review-job. Werk voor een repo dat in de sprint van een ánder product
is gepland, krijgt zo geen plan. Het typische geval: werk voor scrum4me-mcp, -docker of -workers
dat in een Scrum4Me-sprint staat (T-1972 voor scrum4me-mcp#180).

**Meting (2026-10-04, 100 recentste PR's met een PR_REVIEW-job, code op `a843a79`):**

| | aantal |
|---|---|
| plan gevonden binnen het eigen product (huidige routes) | 41 |
| zonder plan | 59 |
| daarvan: een code bestaat in precies één ánder product | 23 |
| daarvan: `repo_url` van de gevonden taak (of van een taak van de gevonden story) = repo van de PR | 20 |
| daarvan: een PR-commit staat in `story_logs` van een ander product | 22 |
| daarvan: te koppelen via unieke code óf commit | **30** |
| daarvan: code alleen dubbelzinnig (meerdere producten); alle 7 hebben wel een commit- of `repo_url`-signaal | 7 |

Gecombineerd stijgt de dekking dus van **41 naar ongeveer 71 van de 100**. De meting zocht in alle
producten; op één demoproduct van de andere gebruiker na (Scrum4MeDemo) zijn ze allemaal van de
job-eigenaar, dus het eigenaarsfilter van ontwerpkeuze 1 verandert de uitkomst hoogstens
ten gunste (minder dubbelzinnigheid). `task.repo_url` wordt al
veel gebruikt: 567 van de 2236 taken in de laatste 90 dagen.

**Eerst bruikbaar resultaat:** de proef geeft `scrum4me-mcp#180` (T-1972, product Scrum4Me) en
`scrum4me-docker#104` (T-1973) een plan, en over de 100 recentste PR's komt de dekking boven 65.
Dat gebeurt vóór de promptwijziging en de uitrol.

**Zichtbaar:** de review van zo'n PR meldt "plan gekoppeld via pr_refs" of "via commits" en noemt
het product waar het plan vandaan komt.

**Niet-doelen:**
- Geen planpaden uit een andere repo. "Plan: Scrum4Me `docs/plans/…`" in een Ops-dashboard-PR
  blijft ongelezen.
- Geen nieuwe afspraak voor PR-beschrijvingen (zoals `SCRUM4ME/T-1972`) en geen schemawijziging.
- Geen producten die niet van de eigenaar van de review-job zijn (ook niet als die eigenaar er lid van is).
- De bestaande routes 1 en 2 en de A-route binnen het eigen product veranderen niet.

## Ontwerpkeuzes

1. **Productscope = producten van de job-eigenaar.** De kandidaten zijn producten met
   `Product.user_id = job.user_id`, doorsneden met de token-scope (`getTokenScopedProducts`, zie
   `src/access.ts`; `[]` = geen beperking). `ProductMember` telt bewust **niet** mee. Een lid van
   andermans product zou dat plan anders in een Forgejo-comment kunnen trekken die lezers van de
   PR-repo zien, zonder dat zij toegang tot dat product hebben. Alle gemeten doelen zijn eigen
   producten van de job-eigenaar. `job.user_id` is beschikbaar in `getFullJobContext`
   (`findUnique` met `include`).
2. **Volgorde: het eigen product gaat altijd vóór andere producten.**
   1. routes 1 en 2 (ongewijzigd);
   2. A in het eigen product (ongewijzigd);
   3. **B in het eigen product** (ongewijzigd);
   4. **A×**: codes in andere producten;
   5. **B×**: commits in andere producten;
   6. `null`.

   Elke PR die nu een plan in zijn eigen product krijgt (via A of B), houdt zo exact dezelfde
   output. Geen van de 30 doel-PR's heeft een plan in het eigen product, dus de gemeten winst
   blijft. A× komt vóór B×, omdat de beschrijving zegt wát het werk is.
3. **A×: codes in andere producten.** Alleen voor codes die in het eigen product niet bestaan; A×
   vraagt dat zelf op met één batch-query per soort code. Per code:
   - **precies één match** in een kandidaat-product → gebruiken (zie K1);
   - **meerdere matches** → alleen de match met een bevestigend signaal: de `repo_url` van de taak
     (of van een taak van de story) is de repo van de PR, of de story heeft een `COMMIT`-log met een
     hash uit deze PR. Blijft er niet precies één over, dan vervalt de code.
   - `repo_url` wordt vergeleken als `{host, owner, repo}`, via `parseForgejoRemoteUrl` (taak) tegen
     `parseForgejoPrUrl` (PR). De remoteparser kent https en SSH; de PR-parser leest de https-PR-URL.
     Geen nieuwe URL-ondersteuning.
4. **Commit-SHA's één keer per resolve.** De SHA's van de PR worden lazy opgehaald, pas bij de
   eerste stap die ze nodig heeft (B in het eigen product), en daarna hergebruikt door A× en B×.
   Verder deelt B in het eigen product niets met de nieuwe stappen. `resolvePlanViaCommits` houdt
   zijn eigen query, en B× krijgt een aparte query over `candidateProductIds()`, pas na A×. Zo kan
   een fout in de kandidaat- of token-lookup B in het eigen product nooit meenemen. Eén commit kan
   bij meerdere stories of producten gelogd zijn; B× neemt ze dan allemaal mee, elk met zijn eigen
   herkomst.
5. **Interne identiteit op id, niet op code.** Codes zijn alleen uniek per product. In de
   productoverschrijdende paden (A×, B×) groeperen collector en `assembleWithinBudget` op story- en
   task-id. Dat geldt voor de groepering, `placed`, `explicitTasks` en het deduplicatie van B×. De
   id's komen niet in de output, en de bestaande paden (A en B in het eigen product) blijven
   byte-gelijk.
6. **Herkomst zichtbaar.** Een story uit een ander product krijgt het veld `product` (de
   productnaam); de assembler neemt dat veld mee. In `references` staat zo'n verwijzing als
   `T-1972 (Scrum4Me)`, en `omitted` gebruikt dezelfde labels, zodat twee keer `ST-1` te
   onderscheiden blijft. De budgetreservering rekent met die definitieve weergave, labels
   inbegrepen. `JSON.stringify(linked_plan).length` ≤ 100 000 blijft bindend.
7. **Beslispunt K1 — besloten: "ja" (JP, 2026-10-04):** mag een unieke match zonder bevestigend signaal gebruikt
   worden? In de meting gaat het om 2 van de 30 PR's (#180 en #177). Het risico is een code die
   in de beschrijving iets anders betekent en toevallig precies één keer elders bestaat. Dat
   risico is klein: lage codes zoals `T-1` bestaan in veel producten en vallen dus als
   dubbelzinnig af, en de herkomst staat in de review. Beide reviewers van ronde 1 vonden "ja"
   verdedigbaar. Zegt JP "nee", dan vereist A× altijd een signaal, en vervalt de acceptatie voor
   #180 via `pr_refs` (zie Taak 3). De beslissing is één functie, zodat de keuze één regel blijft.
8. **Best-effort blijft:** een fout in A× of B× valt door naar de volgende stap.

## Bestanden

| Bestand | Wijziging |
|---|---|
| `src/lib/pr-linked-plan.ts` | `candidateProductIds(userId, ownProductId)`, gedeelde SHA-cache per resolve, stappen A× en B×, interne id-sleutels, `product`-label door de assembler |
| `src/tools/wait-for-job.ts` | `user_id` meegeven aan de resolver |
| `src/prompts/pr/review.codex.md`, `src/prompts/pr/review.md` | herkomstregel: noem het product als het plan uit een ander product komt |
| `scripts/probe-pr-linked-plan.ts` | `user_id` meegeven; kolom `product` |
| `__tests__/lib/pr-linked-plan.test.ts`, `__tests__/tools/wait-for-job-pr-review.test.ts` | tests |

## Global constraints

- TypeScript NodeNext: relatieve imports mét `.js`.
- Testidioom als in `__tests__/lib/pr-linked-plan.test.ts`: `vi.mock` op prisma en `src/git/pr.js`.
  Gebruik `toStrictEqual` waar het om exacte output gaat.
- Routes 1–2 en A en B binnen het eigen product geven byte-gelijke output.
- Per taak: `npx vitest run <testbestand>`, daarna `npm run typecheck && npm run typecheck:tests`.
  Commit per taak; push en PR alleen met akkoord van JP.

---

### Taak 1 — Productscope, SHA-cache en id-sleutels

**Interfaces:**
- `candidateProductIds(userId: string, ownProductId: string): Promise<string[]>`: producten met
  `user_id = userId`, zonder het eigen product, doorsneden met `getTokenScopedProducts()` als die
  niet leeg is.
- `ReviewJob` krijgt `user_id?`. `wait-for-job.ts` geeft `job.user_id` mee. Zonder `user_id`
  worden A× en B× overgeslagen; het gedrag is dan exact dat van ST-052.
- Een per-resolve-context met lazy `listPullRequestCommitShas`. Het tweede gebruik doet geen
  tweede Forgejo-call.
- De story- en task-selects in de productoverschrijdende paden halen `id` en `product_id` (plus de
  productnaam) op. De assembler sleutelt intern op id en neemt `product` mee.

**Acceptatie (tests):**
- `candidateProductIds`: producten van een andere eigenaar en producten waarvan de gebruiker
  alleen lid is, vallen af;
- token-scope: de gebruiker bezit twee producten, het token staat er één toe → het andere valt af;
  `[]` betekent geen beperking;
- de SHA's worden maximaal één keer per resolve opgehaald (spy op `listPullRequestCommitShas`);
- de kandidaat-lookup gooit een fout → de uitkomst van B in het eigen product blijft ongewijzigd;
- de bestaande tests voor A en B in het eigen product blijven ongewijzigd groen met `toStrictEqual`.

### Taak 2 — Stappen A× en B×

**Interfaces:** `resolvePlanViaCrossProductRefs(job, pr, ctx)` en
`resolvePlanViaCrossProductCommits(job, ctx)`. `resolvePrLinkedPlan` roept ze in de volgorde van
ontwerpkeuze 2 aan, ná B in het eigen product.

**Gedrag:** ontwerpkeuzes 3 tot en met 7. Het resultaat gaat via `assembleWithinBudget` met
`source: 'pr_refs'` (A×) of `'commits'` (B×).

**Acceptatie (tests):**
- volgorde: een PR met een gelogde commit in het eigen product én een code die alleen elders
  bestaat → het resultaat van B in het eigen product, byte-gelijk aan nu (`toStrictEqual`);
- A×, unieke match in een ander product → plan met `product`, en `references` met herkomst;
- A×, twee matches waarvan één met `repo_url` = repo van de PR (https-taak tegen PR, en SSH-taak
  tegen PR) → die ene;
- A×, twee matches waarvan één met een PR-commit in zijn `story_logs` → die ene;
- A×, twee matches zonder signaal → code vervalt, door naar B×;
- A×, een code die in het eigen product bestaat → niet elders gezocht;
- **dezelfde storycode in twee producten:** B× met twee verschillende PR-commits bij `ST-1` in
  product X en `ST-1` in product Y → twee stories, elk met de eigen taken en acceptatiecriteria en
  de juiste herkomst; A× met unieke taakcodes onder `ST-1` in X en Y → niet gemengd;
- budget met lange productnamen in de labels → ≤ 100 000;
- K1 "nee"-variant als aparte test van de beslisfunctie;
- een product van een andere eigenaar telt in A× en B× niet mee.

### Taak 3 — Praktijkproef (vóór prompt en uitrol)

Breid `scripts/probe-pr-linked-plan.ts` uit. `user_id` komt van de PR_REVIEW-job, of van de
eigenaar van het product. Toon per PR de herkomst (`product`) en de stap (A, B, A× of B×). De proef
meldt aan het begin of het lokale token gescoped is: een gescoped token zou de dekking lager tonen
dan op de ongescopete productieworkers.

**Acceptatie:**
- `scrum4me-mcp#180` → `pr_refs` met `T-1972 (Scrum4Me)`. Dit hangt af van K1 = "ja"; bij "nee"
  vervalt dit punt en blijft #180 zonder plan;
- `scrum4me-docker#104` → `pr_refs` (T-1973) of `commits`, met herkomst Scrum4Me;
- `--recent 100`: dekking > 65. De nulmeting is 41, met de resolver van ST-052 (A en B binnen het
  eigen product), niet alleen routes 1–2. Daarnaast een lijst van alle koppelingen via A× zonder
  signaal; JP beoordeelt die steekproefsgewijs (K1);
- elke PR die vóór de wijziging een plan in het eigen product kreeg, geeft exact dezelfde output.
  De proef draait elke PR twee keer: zonder `user_id` (= ST-052-gedrag) en met. Hij print per run
  `sha256(JSON.stringify(linked_plan))`, dus geen inhoud. Elke PR met een plan in de eerste run
  heeft in de tweede dezelfde hash;
- geen exception en niets boven het budget.

Valt de dekking tegen of zit er een foute koppeling tussen: eerst bijsturen en JP melden, vóór
Taak 4.

### Taak 4 — Prompts en productdoc

- Beide prompts: komt een story uit een ander product (`product` gezet), noem dat in de body,
  bijvoorbeeld "plan gekoppeld via pr_refs (product Scrum4Me)". Verder geen wijzigingen.
- Productdoc ARCHITECTURE/pr-review-linked-plan: nieuwe revisie met de productscope, A× en B over
  producten.

**Acceptatie:** prompt- en kind-prompt-tests groen; `git diff src/prompts/pr/` alleen de
herkomstregel.

### Taak 5 — Verificatie, PR, uitrol en live-check

1. `npm test && npm run typecheck && npm run typecheck:tests` groen.
2. Push en PR op Forgejo met akkoord van JP. De beschrijving noemt de story, de taken en dit planpad.
3. Na merge, op opdracht van JP, hetzelfde recept als ST-052. Wacht eerst op de main-CI.
   - srv: `pin_mcp_to_main` → `update_codex_worker`;
   - max2: `pin_mcp_to_main` → `redeploy_codex_worker`;
   - Mac: `scrum4me-mcp-stable` bijwerken.
4. Live-check: de eerstvolgende PR in een repo waarvan het werk in een Scrum4Me-sprint staat
   (mcp, docker, workers) krijgt "plan gekoppeld via … (product Scrum4Me)". Leg de comment-URL vast.

## Risico's

- **Verkeerde koppeling via een unieke code** (K1). Beperkt door de dubbelzinnigheidsregel en de
  zichtbare herkomst, en gemeten in Taak 3.
- **Meer databasewerk per review:** hooguit drie extra batch-queries en, bij dubbelzinnigheid,
  één Forgejo-call. Dat is te verwaarlozen naast de diff-fetch.
- **Toegang:** zonder eigenaarsfilter zou een review plannen van een product van een andere
  gebruiker kunnen lezen en in een comment kunnen zetten. Ontwerpkeuze 1 beperkt daarom tot
  eigen producten plus de token-scope, en dat is getest. Nu hebben alle PR_REVIEW-jobs dezelfde
  eigenaar, maar er zijn twee gebruikers met producten.
- **Uniciteit slijt** naarmate producten groeien. Dan worden meer codes dubbelzinnig en vallen ze
  terug op de signalen. Dat is veilig: hooguit minder dekking, nooit een verkeerde keuze.

## Review record

Formele review-loop (fase `plan`), gestart op verzoek van JP op 2026-10-04. Dispatch bedient alleen
het Scrum4Me-product (IDEA-233), dus op besluit van JP via de **listener-fallback**: `mac:codex` en
`mac:claude`, door JP gearmd.

### Ronde 1 — revisie 1 @ `b0fbc851`

- **Verzoeken:** `mac:codex` `7d795ba3-96fb-4378-afd9-abd118dfd238` (antwoord `520ffa53`),
  `mac:claude` `d0409026-67dc-47c1-aa45-916ffd9283a4` (antwoord `13f02bb7`). Pins: plan
  `e8f44248…`, `CLAUDE.md` `df60a45f…`, voorganger `88bd535a…`, alle op `b0fbc851`. Presence
  vooraf: codex `beschikbaar`, claude `bezig` (toch gepusht).
- **Uitslag:** codex 0 BLOCKER / 1 MAJOR / 1 MINOR → **NO-GO**; claude 0 / 1 / 4 → **NO-GO**.
- **Bepalende bevindingen, geverifieerd en geaccepteerd:**
  - **Volgorde (claude MAJOR).** Een verbrede B en A× vóór B veranderden de uitkomst van de
    bestaande B in het eigen product (`pr-linked-plan.ts:133`, `:259`), tegen de eigen eis van
    byte-gelijkheid in. Fix: volgorde A(eigen) → B(eigen) → A× → B× (ontwerpkeuze 2). De SHA's
    worden één keer per resolve opgehaald (ontwerpkeuze 4).
  - **Identiteit op code (codex MAJOR, claude MINOR).** Groepering, `placed` en `explicitTasks`
    sleutelen op code (`:201-215`, `:263-265`, `:349-372`), en codes zijn alleen uniek per product.
    Fix: in A×/B× intern op id sleutelen (ontwerpkeuze 5), met tests voor dezelfde storycode in
    twee producten.
- **Overige bevindingen, allemaal geaccepteerd:**
  - De budgetreservering telde kale codes, terwijl `references` labels krijgt (claude) → reserveren
    met de definitieve weergave.
  - Lidmaatschap als kandidaat kon andermans plan in een comment lekken (claude) → alleen eigen
    producten (ontwerpkeuze 1).
  - De token-scope was niet apart getest (codex) → test met twee eigen producten, waarvan het
    token er één toestaat.
  - `repo_url`-vergelijking zonder SSH-vormen (claude) → `parseForgejoRemoteUrl` tegen
    `parseForgejoPrUrl`.
  - A× moet zelf weten welke codes in het eigen product bestaan (claude) → één batch-query.
  - Proef met gescoped lokaal token (claude) → de proef meldt de scope.
  - Nulmeting = de ST-052-resolver, niet alleen routes 1–2 (codex) → in Taak 3 verduidelijkt.
  - Het label moet door de assembler (codex) → ontwerpkeuze 6.
  - De acceptatie voor #180 hangt af van K1 (claude) → in Taak 3 vermeld.
- **K1:** beide reviewers vinden "ja" verdedigbaar. Het besluit blijft bij JP.
- **Afgewezen:** geen.
- **Scope-delta:** geen nieuw doel of subsysteem. Wél strenger: alleen eigen producten in plaats
  van eigenaar of lid. Het eerste bruikbare resultaat en de praktijkproef blijven gelijk.

### Ronde 2 — revisie 2 @ `0879b13b`

- **Verzoeken:** `mac:codex` `f4d3dc4f-eb37-41c1-8f46-3ac4cdc9e3ff` (antwoord `12f28347`),
  `mac:claude` `cc3b46b1-0bb7-4891-9274-804995fc12d4` (antwoord `b3647264`). Pins: plan
  `e3b4cd32…`, `CLAUDE.md` `df60a45f…`, voorganger `88bd535a…`, alle op `0879b13b`.
- **Uitslag:** codex 0 / 0 / 1 MINOR → **GO**; claude 0 / 0 / 2 MINOR → **GO**. **Dubbel GO.**
- **Reparaties uit ronde 1:** claude vond alle zeven standgehouden; codex zes standgehouden en
  één gedeeltelijk (de parsertekst, zie hieronder).
- **MINOR-bevindingen, geverifieerd en na het dubbele GO verwerkt:**
  - De gecombineerde B/B×-query koppelde B in het eigen product aan de kandidaat- en token-lookup
    (claude) → geschrapt. B in het eigen product houdt zijn eigen query; test "kandidaat-lookup
    gooit → B(eigen) ongewijzigd".
  - De vergelijking "zelfde output" was met de proef zonder inhoud niet uitvoerbaar, en het gedrag
    zonder `user_id` was weggevallen (claude) → hash-vergelijking per PR met en zonder `user_id`;
    zonder `user_id` worden A× en B× overgeslagen.
  - Alleen de remoteparser kent SSH (codex, `forgejo-rest.ts:117-129` tegen `:157-165`) → tekst
    gecorrigeerd.
  - Polish (claude): `omitted` gebruikt dezelfde labels als `references`.
  - Er volgde geen delta-ronde: het zijn verduidelijkingen en één schrapping binnen het ontwerp.
    JP kan er alsnog een vragen.
- **Afgewezen:** geen.
- **Scope-delta:** kleiner. De gecombineerde query is geschrapt. Eerste bruikbare resultaat en
  praktijkproef ongewijzigd.

**Fase `plan` afgerond (dubbel GO).** Open: het besluit van JP over K1. Daarna volgt de
ceremonie op SC2, alleen met akkoord van JP. Technisch GO autoriseert geen uitvoering, merge of
deployment.

### Besluit en ceremonie — 2026-10-04

**K1 = ja (JP):** een unieke match in een ander product mag zonder bevestigend signaal gebruikt
worden. De acceptatie voor `scrum4me-mcp#180` via `pr_refs` geldt dus. Daarna is de ceremonie op
SC2 uitgevoerd, op akkoord van JP:
- sprint `S-2026-10-04-2`;
- PBI-33, gekoppeld aan productdoc PLANS/pr-review-cross-product (revisie 1, rol PLAN);
- story ST-053;
- taken T-163 tot en met T-167 (Taak 1–5, in planvolgorde).

**Hardstop:** uitvoeren pas na een aparte uitvoeropdracht van JP.
