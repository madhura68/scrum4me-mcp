# PR-review: plan vinden over productgrenzen heen — Implementatieplan

**Status:** concept, wacht op akkoord van JP. Vervolg op
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

Gecombineerd stijgt de dekking dus van **41 naar ongeveer 71 van de 100**. `task.repo_url` wordt al
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
- Geen producten buiten de toegang van de eigenaar van de review-job.
- De bestaande routes 1 en 2 en de A-route binnen het eigen product veranderen niet.

## Ontwerpkeuzes

1. **Productscope = toegang van de job-eigenaar.** De kandidaten zijn producten waarvan
   `job.user_id` eigenaar of lid is (`Product.user_id` of `ProductMember`), zoals in
   `src/access.ts` (`userCanAccessProduct`). Is het token gescoped (`getTokenScopedProducts`), dan
   alleen die producten. `job.user_id` is beschikbaar in `getFullJobContext`.
2. **Route B (commits) zoekt in alle toegankelijke producten,** in plaats van alleen het eigen
   product. Een commit-SHA identificeert het werk ondubbelzinnig. De kans op een botsing met een
   prefix van minstens 7 hex-tekens op ~3000 logs is verwaarloosbaar. Dit vervangt het huidige
   B-filter, want het eigen product zit in de toegankelijke set.
3. **Nieuwe stap A×: codes in andere producten,** alleen als A binnen het eigen product niets
   bruikbaars opleverde. Per code die in het eigen product niet bestaat:
   - **precies één match** in een toegankelijk ander product → gebruiken;
   - **meerdere matches** → alleen de match met een bevestigend signaal: de `repo_url` van de taak
     (of van een taak van de story) is de repo van de PR, of de story heeft een `COMMIT`-log met een
     hash uit deze PR. Blijft er niet precies één over, dan vervalt de code.
   - De commit-SHA's van de PR worden alleen opgehaald als dat nodig is voor die beslechting.
   - Hergebruik de groepering, PLAN-docs en het budget van route A.
4. **Volgorde:** routes 1 en 2 → A (eigen product) → A× → B (toegankelijke producten) → `null`.
   A× komt vóór B, omdat de beschrijving zegt wát het werk is. B blijft het vangnet zonder codes.
5. **Herkomst zichtbaar maken.** Een story uit een ander product krijgt het veld `product`
   (de productnaam). In `references` staat zo'n verwijzing als `T-1972 (Scrum4Me)`. De reviewer
   ziet zo dat het plan van elders komt en kan een verkeerde koppeling herkennen.
6. **Beslispunt K1, standaard "ja":** mag een unieke match zonder bevestigend signaal gebruikt
   worden? In de meting gaat het om 2 van de 30 PR's (#180 en #177). Het risico is een code die
   in de beschrijving iets anders betekent en toevallig precies één keer elders bestaat. Dat
   risico is klein: lage codes zoals `T-1` bestaan in veel producten en vallen dus als
   dubbelzinnig af, en de herkomst staat in de review. Zegt JP "nee", dan vereist A× altijd een
   signaal.
7. **Best-effort blijft:** een fout in A× of B valt door naar de volgende stap. Het budget van
   100 000 tekens geldt ongewijzigd voor alles wat A, A× en B opleveren.

## Bestanden

| Bestand | Wijziging |
|---|---|
| `src/lib/pr-linked-plan.ts` | `accessibleProductIds(userId)`, stap A× (`resolvePlanViaCrossProductRefs`), B over toegankelijke producten, `product`-label op stories |
| `src/tools/wait-for-job.ts` | `user_id` meegeven aan de resolver |
| `src/prompts/pr/review.codex.md`, `src/prompts/pr/review.md` | herkomstregel: noem het product als het plan uit een ander product komt |
| `scripts/probe-pr-linked-plan.ts` | `user_id` meegeven; kolom `product` |
| `__tests__/lib/pr-linked-plan.test.ts`, `__tests__/tools/wait-for-job-pr-review.test.ts` | tests |

## Global constraints

- TypeScript NodeNext: relatieve imports mét `.js`.
- Testidioom als in `__tests__/lib/pr-linked-plan.test.ts`: `vi.mock` op prisma en `src/git/pr.js`.
  Gebruik `toStrictEqual` waar het om exacte output gaat.
- Bestaande routes en de A-route binnen het eigen product geven byte-gelijke output.
- Per taak: `npx vitest run <testbestand>`, daarna `npm run typecheck && npm run typecheck:tests`.
  Commit per taak; push en PR alleen met akkoord van JP.

---

### Taak 1 — Productscope en route B over toegankelijke producten

**Interface:** `accessibleProductIds(userId: string): Promise<string[]>`. Dat zijn de producten
waarvan de gebruiker eigenaar of lid is, doorsneden met de token-scope als die er is. Een lege
token-scope betekent geen beperking, zoals in `src/access.ts`.

`ReviewJob` krijgt `user_id?`. `resolvePlanViaCommits` filtert op
`story: { product_id: { in: ids } }`. Zonder `user_id` valt hij terug op alleen het eigen product
(achterwaarts compatibel). Een story uit een ander product dan `job.product_id` krijgt `product`
(naam) mee.

**Acceptatie (tests):**
- B vindt een story in een toegankelijk ander product en zet `product`;
- B vindt niets in een product waar de gebruiker geen toegang toe heeft (staat niet in de `in`-lijst);
- zonder `user_id` hetzelfde gedrag als nu;
- `references` noemt de herkomst.

### Taak 2 — Stap A×: codes in andere producten

**Interface:** `resolvePlanViaCrossProductRefs(job, pr)`. `resolvePrLinkedPlan` roept hem aan
tussen A en B.

**Gedrag:** ontwerpkeuzes 3, 5 en 6.
- Batch-queries per soort code over `product_id: { in: ids, not: job.product_id }`, alleen voor
  codes die in het eigen product niet bestaan.
- Beslechting met `repo_url` (taak, of taken van de story) tegen de repo van de PR, genormaliseerd
  zonder `.git` en hoofdletters. Daarna pas de commit-SHA's (`listPullRequestCommitShas`, lazy).
- Het resultaat gaat via dezelfde `assembleWithinBudget` met `source: 'pr_refs'`.

**Acceptatie (tests):**
- unieke match in een ander product → plan, met `product` en de herkomst in `references`;
- twee matches waarvan één met `repo_url` = repo van de PR → die ene;
- twee matches waarvan één met een PR-commit in zijn `story_logs` → die ene, en de SHA's worden
  pas dan opgehaald;
- twee matches zonder signaal → code vervalt, door naar B;
- een code die in het eigen product bestaat wordt hier niet opnieuw gezocht;
- een product zonder toegang telt niet mee;
- K1 "nee"-variant als aparte test van de beslisfunctie, zodat het besluit één regel blijft.

### Taak 3 — Praktijkproef (vóór prompt en uitrol)

Breid `scripts/probe-pr-linked-plan.ts` uit. `user_id` komt van de PR_REVIEW-job, of van de
eigenaar van het product. Toon per PR de herkomst (`product`).

**Acceptatie:**
- `scrum4me-mcp#180` → `pr_refs` met `T-1972 (Scrum4Me)`;
- `scrum4me-docker#104` → `pr_refs` (T-1973) of `commits`, met herkomst Scrum4Me;
- `--recent 100`: dekking > 65 (nulmeting 41), en een lijst van alle koppelingen die via A×
  zonder signaal zijn gemaakt. JP beoordeelt die steekproefsgewijs (K1);
- een PR waarvan het plan in het eigen product staat, verandert niet (vergelijk met de stand vóór
  de wijziging);
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
- **Toegang:** zonder `user_id`-filter zou een review plannen van een product van een andere
  gebruiker kunnen lezen. Ontwerpkeuze 1 is daarom verplicht en getest. Nu hebben alle
  PR_REVIEW-jobs dezelfde eigenaar, maar er zijn twee gebruikers met producten.
- **Uniciteit slijt** naarmate producten groeien. Dan worden meer codes dubbelzinnig en vallen ze
  terug op de signalen. Dat is veilig: hooguit minder dekking, nooit een verkeerde keuze.

## Review record

Formele review-loop (fase `plan`), gestart op verzoek van JP op 2026-10-04. Dispatch bedient alleen
het Scrum4Me-product (IDEA-233), dus op besluit van JP via de **listener-fallback**: `mac:codex` en
`mac:claude`, door JP gearmd.
