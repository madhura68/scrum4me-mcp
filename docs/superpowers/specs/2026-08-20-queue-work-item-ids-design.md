# Work-item-ids op queue-berichten — design

**Datum:** 2026-08-20
**Status:** vastgesteld (JP akkoord 2026-08-20, brainstormsessie)
**Aanleiding:** Queue-berichten die over een sprint, story of taak gaan zijn daar nu niet
aan te koppelen. JP wil optionele sprint-/story-/task-ids op s4m-queue-berichten, en in een
tweede fase tools om berichten op die ids terug te vinden.
**Raakt:** `scrum4me-mcp` (alleen dit repo).
**Raakt niet:** `s4m-queue` (migraties, CLI, archief-pariteitscontract), `Scrum4Me`,
`scrum4me-workers`, `scrum4me-shared` — zie §2.

---

## 1. Probleem

Een agent die via `queue_push` een taak of review uitzet die bij een Scrum4Me-werkitem
hoort, kan die koppeling nergens machineleesbaar kwijt. In de praktijk staat het item
hooguit als proza in `body` of `meta.task.objective`. Gevolg: "welke queue-berichten
horen bij story X" is niet te beantwoorden zonder alle berichten te lezen.

De consumenten van die vraag zijn uitsluitend **agents via de MCP** (vastgesteld in de
brainstorm). Het Scrum4Me-web/dashboard en ad-hoc-SQL zijn expliciet géén doelgroep;
dat besluit stuurt de opslagkeuze in §2.

## 2. Besluiten

1. **Opslag in `meta`, geen schema-wijziging.** De ids landen in één canoniek blok
   `meta.work_item` op de bestaande `meta Json`-kolom van `agent_message`. Daarmee
   blijven buiten schot: de s4m-queue-DDL (`001_init.sql` e.v.), het kolom-
   pariteitscontract met `agent_message_archive`, en de s4m-queue-CLI. Alleen dit
   repo wijzigt.
2. **Top-level parameters op `queue_push`** (optie A uit de brainstorm): drie optionele
   Zod-parameters `sprint_id`, `story_id`, `task_id`. Zelfdocumenterend in de
   tool-listing; de caller hoeft `meta.work_item` niet te kennen. De tool schrijft het
   blok zelf, ná validatie.
3. **Afleiden + valideren** (§4): de tool vult de hiërarchie omhoog aan vanuit het
   meest specifieke id en weigert inconsistente of onbestaande ids met een
   `VALIDATION_ERROR`.
4. **Fase 2 is één nieuwe read-only tool** `queue_find_by_work_item` over **alle
   adressen** (§5), naast de bestaande adres-gescopete `queue_list`.
5. **Eén spec, twee uitvoeringsfasen.** Fase 1: ids meesturen. Fase 2: terugvinden.
   Fase 2 is dankzij de afleiding klein en kan direct na fase 1.

## 3. Het `meta.work_item`-blok

```jsonc
"work_item": {
  "product_id": "cm…",   // altijd afgeleid, nooit input
  "sprint_id":  "cm…",   // optioneel — ontbreekt als de taak/story niet in een sprint zit
  "story_id":   "cm…",   // optioneel
  "task_id":    "cm…"    // optioneel
}
```

- Ids zijn de bestaande cuid-strings uit de Scrum4Me-tabellen (zelfde Postgres-DB;
  de Prisma-client van dit repo kent `Sprint`, `Story` en `Task` al).
- Alleen gegeven én afgeleide velden worden geschreven; er komen geen `null`-velden in
  het blok. Zonder één van de drie parameters wordt het blok in het geheel niet
  geschreven — bestaand gedrag verandert dan met nul bytes.
- Het blok staat **naast** `meta.task`, niet erin: het geldt voor álle request-types,
  ook `info`.
- **Een caller-geleverd `meta.work_item` gaat nooit ongevalideerd door.** `queue_push`
  haalt de sleutels `sprint_id`/`story_id`/`task_id` uit zo'n blok, voegt ze samen
  met de top-level parameters en stuurt de vereniging door dezelfde resolver (§4);
  spreken parameter en blok elkaar tegen, dan is dat een gewone inconsistentie →
  `VALIDATION_ERROR`. Overige sleutels in het blok (incl. een meegegeven
  `product_id`) vervallen — `product_id` wordt altijd afgeleid, nooit overgenomen.
  Op het MCP-pad is elk opgeslagen `work_item`-blok dus resolver-output; er bestaat
  geen tweede klasse "handgemaakte" blokken. (De rest van meta buiten `meta.task`
  en `meta.work_item` blijft pass-through; `meta.task` wordt door `validateTaskMeta`
  tot bekende velden teruggebracht.) Rijen die buiten de MCP om zijn geschreven
  kunnen wel een niet-canoniek blok dragen — hoe fase 2 daarmee omgaat staat in §5.

## 4. Afleiding en validatie in `queue_push`

Vanuit het meest specifieke gegeven id wordt de hiërarchie omhoog aangevuld:

| Input | Afgeleid |
|---|---|
| `task_id` | `story_id` (uit `Task.story_id`), `sprint_id` (uit **`Story.sprint_id`** — kan ontbreken), `product_id` (uit **`Story.product_id`**) |
| `story_id` | `sprint_id` (kan ontbreken — `Story.sprint_id` is nullable), `product_id` |
| `sprint_id` | `product_id` |

**Sprint én product komen bij een taak uit de Story, niet uit de Task-kolommen.**
`Task.sprint_id` én `Task.product_id` zijn gedenormaliseerde kopieën
("denormalized — erf van story", `src/tools/create-task.ts:91-92`) zonder constraint
die ze gelijk houdt aan de Story; de sprintflow selecteert op de story
(`src/lib/dispatch/sprint-run.ts:40`, `src/tools/update-task-status.ts:63-67`) en de
bestaande access-helper leest het product ook via de story
(`userCanAccessTask`, `src/access.ts:20-26`). Een lege of stale Task-kolom mag een
taakbericht dus niet zijn sprint-tag kosten of de productguard (§5) ondermijnen.
De hele afleiding voor `task_id` is één `findUnique` met `include: { story }` —
de story draagt `sprint_id` én `product_id`.

Regels:

- **Onbestaand id** → `VALIDATION_ERROR: <veld> not found`.
- **Inconsistentie** bij meerdere gegeven ids → `VALIDATION_ERROR` met beide kanten
  benoemd (bv. "task_id X hoort bij story Y, niet bij gegeven story_id Z"). Vergeleken
  wordt na afleiding: de afgeleide waarde moet exact gelijk zijn aan de gegeven waarde.
  Ontbreekt een afgeleide waarde (taak zonder sprint) terwijl `sprint_id` wél gegeven
  is, dan is dat óók een inconsistentie.
- Validatie draait **vóór** de insert; een fout laat geen rij en geen NOTIFY achter.
- De DB-reads zijn drie enkelvoudige `findUnique`s (hooguit; meestal één) — geen
  transactie nodig, het is een leescheck.

**Bijeffect dat fase 2 draagt:** een taak-getagd bericht draagt door de afleiding
automatisch ook zijn story- en sprint-id. Zoeken op story vindt dus óók de
taakberichten van die story, zonder join-logica.

## 5. Fase 2 — `queue_find_by_work_item`

Nieuwe tool, read-only en niet-claimend (annotaties als `queue_list`:
`readOnlyHint`, `idempotentHint`), maar **niet** gescopet op het eigen adres:
traceability over agents heen was de expliciete wens.

Input (Zod):

- `sprint_id`, `story_id`, `task_id` — alle optioneel, **minstens één vereist**
  (refine-check). Meerdere gegeven ids werken als AND-filter.
- `include_archived: boolean = false` — standaard alleen `archived_at IS NULL`.

Gedrag:

- Filter via jsonb-pad op de actieve tabel:
  `meta -> 'work_item' ->> '<veld>' = <id>` per gegeven id (Prisma:
  `meta: { path: ['work_item', '<veld>'], equals: <id> }`).
- **Directe replies komen mee:** rijen met `in_reply_to` ∈ gevonden ids worden
  toegevoegd, óók als ze zelf geen `work_item` dragen (replies via `queue_done`
  krijgen het blok niet; de request-rij is de bron van waarheid). Eén niveau diep —
  reply-types zijn terminaal, kettingen bestaan niet. **De reply-query krijgt
  hetzelfde `include_archived`-predicaat als de match-query:** `queue_archive`
  werkt op subtrees vanaf een willekeurige rij (`src/tools/queue-archive.ts`), dus
  een actieve request kan een gearchiveerde reply hebben; onder de default
  (`include_archived: false`) wordt die reply dan niet bijgevoegd.
- Geen validatie van de gezochte ids tegen de Scrum4Me-tabellen: een verwijderde
  story mag zijn berichtgeschiedenis blijven opleveren.
- **Productguard (verplicht):** de tool is cross-adres maar niet cross-product.
  Na het matchen wordt per distinct `meta.work_item.product_id` in de resultaten
  `userCanAccessProduct` (`src/access.ts` — token-`scoped_products` + owner/
  membership) toegepast; rijen van een ontoegankelijk product vervallen. Rijen
  waarvan het `work_item`-blok géén `product_id` draagt worden nooit teruggegeven —
  toegang is dan niet vast te stellen. Replies worden alleen bijgevoegd bij matches
  die de guard overleven. Omdat het MCP-schrijfpad elk blok canonicaliseert (§3),
  is het opgeslagen `product_id` op dat pad afgeleid en betrouwbaar; een tot
  product A gescopet token kan zo geen berichten over product B's werkitems
  opvragen. **Restrisico, bewust geaccepteerd:** rijen die buiten de MCP om zijn
  geschreven (direct SQL; de CLI kán geen top-level `work_item` zetten, §8) worden
  op hun opgeslagen `product_id` beoordeeld. Zo'n schrijver kan alleen de
  zichtbaarheid van zijn éigen bericht verkeerd taggen — er lekt geen inhoud van
  derden.
- Sortering `created_at desc`. De limiet van 100 geldt voor de **request-matches**
  (`take: 100`); hun replies komen daar bovenop. Raakt de match-query de limiet, dan
  meldt de respons `truncated: true`.
- Respons: `{ count, truncated, messages: messageView[] }` — zelfde presentatievorm
  als de overige leestools; de entiteit-transparantie-garantie blijft gelden.
- **Cold-store buiten scope, en dat is zichtbaar beleid:** `agent_message_archive`
  wordt niet doorzocht; `include_archived` betreft alleen gearchiveerde rijen in de
  actieve tabel. Retention verplaatst rijen na het venster
  (`S4M_RETENTION_DAYS`, default 60 — `s4m-queue/src/cleanup.ts:115`) naar het
  cold-store-archief, dus ouder verkeer is hier níet "niet gevonden" maar afwezig.
  De tool-description benoemt deze grens expliciet, zodat een agent een leeg of
  gedeeltelijk resultaat op oud werk kan duiden.

**Indexering:** geen. De actieve tabel blijft klein door de retention-archivering.
Escape-hatch als het ooit traag wordt: een expression-index op
`(meta -> 'work_item' ->> 'story_id')` e.d. — dan wél via de s4m-queue-migraties,
want DDL hoort daar.

## 6. Wijzigingen per bestand

| Bestand | Wijziging |
|---|---|
| `src/tools/queue-push.ts` | drie optionele params; aanroep van de nieuwe resolver; `meta.work_item` schrijven |
| `src/queue/work-item.ts` (nieuw) | `resolveWorkItem({sprint_id?, story_id?, task_id?})` → gevalideerd blok of throw; alle afleid-/consistentielogica hier, los testbaar |
| `src/tools/queue-find-by-work-item.ts` (nieuw, fase 2) | de find-tool uit §5 |
| `src/register.ts` | fase-2-tool registreren |
| `__tests__/queue-work-item.test.ts` (nieuw) | unit: afleiding per input-vorm, consistentie-fouten, onbestaande ids (gemockte Prisma); expliciet: `Task.sprint_id = null` met `Story.sprint_id` gevuld → sprint-tag uit de story; mismatch `Task.sprint_id`↔`Story.sprint_id` → story wint; mismatch `Task.product_id`↔`Story.product_id` → story wint; caller-blok-canonicalisatie (blok zonder parameters wordt canoniek herschreven, meegegeven `product_id` vervalt, conflict blok↔parameter → `VALIDATION_ERROR`) |
| `__tests__/queue-find-by-work-item.test.ts` (nieuw, fase 2) | unit: AND-filter, reply-bijvoeging, archived-default, limiet/truncated, productguard (gescopet token ziet product B niet; blok zonder `product_id` valt af); actieve request met gearchiveerde directe reply → reply niet bijgevoegd onder de default |
| `__tests__/queue-entity-transparency.test.ts` (uitbreiden) | meta-roundtrip-canary: een rij met `meta.work_item` + `meta.task` door `messageView` + `toolJson`, assert byte-gelijkheid van het geparste blok |

Integratietests (echte Postgres) zijn optioneel. Maar de meta-transportgarantie
moet wél geasserteerd worden, niet aangenomen: de huidige
`queue-entity-transparency.test.ts` toetst uitsluitend `body` (de enige
`meta`-referentie is de filler `meta: {}` in de fixture) — vandaar de
canary-uitbreiding hierboven. Zonder die canary zou een toekomstige
meta-projectie of -redactie in het leespad groen doorschieten.

## 7. Wat dit oplevert

- Een agent tagt een queue-taak met `task_id` en elke andere agent (met toegang tot
  het product) vindt later met één tool-call de berichtgeschiedenis van die taak,
  story of sprint binnen het retentievenster (default 60 dagen) — inclusief
  antwoorden.
- Nul migraties, nul wijzigingen in `s4m-queue`, CLI en archief; het
  pariteitscontract blijft onaangeroerd.
- De afleiding maakt de tags consistent by construction: geen taak die "bij de
  verkeerde sprint" hangt.

## 8. Buiten scope

- Kolommen/indexen op `agent_message` (heroverwegen zodra web/dashboard of SQL
  consument wordt).
- Doorzoeken van het cold-store-archief (`agent_message_archive`).
- CLI-ondersteuning in `s4m-queue`. Let op: `--meta-file` kan géén top-level
  `meta.work_item` zetten — `buildMeta` doet `parsed.task ?? parsed` en wikkelt
  alles in `{ task }` (`s4m-queue/src/cli.ts:29-47`), dus een `work_item`-sleutel
  belandt in `meta.task` of vervalt. CLI-berichten zijn in deze fase niet
  betrouwbaar te taggen; wie dat nodig heeft gebruikt het MCP-pad.
- Work-item-ids op replies zetten (`queue_done`); de request-rij is de bron van
  waarheid en de find-tool voegt replies bij.
- Tonen van queue-berichten in de Scrum4Me-UI.

## Review record

**Loop:** spec-fase, gestart 2026-08-20. Reviewers: `mac:claude` + `mac:codex`
(JP-armed listeners). Max 10 rondes.

### Ronde 1 — spec r1 @ `6bddb4c` — NO-GO / NO-GO

- **mac:claude** (`7cbe842d`): 0 BLOCKER / 1 MAJOR / 2 MINOR — NO-GO. MAJOR: de
  §6-waiver leunde op `queue-entity-transparency.test.ts`, maar die assert níets
  over meta (enige hit: filler `meta: {}`).
- **mac:codex** (`6ef4ba3e`): 0 BLOCKER / 2 MAJOR / 2 MINOR — NO-GO. MAJOR-1:
  task→sprint-afleiding moet via `Story.sprint_id` (`Task.sprint_id` is
  gedenormaliseerd, kan leeg/stale zijn; sprintflow selecteert op de story).
  MAJOR-2: cross-adres-lookup zonder productguard laat een gescopet token
  cross-product lezen.
- **Triage:** alle 6 bevindingen tegen de tree geverifieerd en bevestigd — 0
  verworpen. Convergent: claude-MAJOR-1 ≙ codex-MINOR-2 (meta-testgat).
- **Fixes → r2:** §4 sprint uit `Story.sprint_id` + expliciete testgevallen
  (null/mismatch); §5 productguard via `userCanAccessProduct` + retentiegrens
  als zichtbaar beleid in de tool-description; §6 meta-roundtrip-canary in
  plaats van de onjuiste waiver; §7 afgezwakt tot toegang + retentievenster;
  §3 `meta.task`-whitelist correct benoemd; §8 `--meta-file`-workaround
  geschrapt (CLI wikkelt alles in `meta.task`, `s4m-queue/src/cli.ts:29-47`).

### Ronde 2 — spec r2 @ `7710188` — GO / NO-GO

- **mac:claude** (`5ff8e5a0`): 0 BLOCKER / 0 MAJOR / 1 MINOR — GO. Alle zes
  r1-fixes **held**. MINOR: de slotzin van de productguard beloofde meer dan het
  mechanisme — bij pass-through-blokken is `product_id` self-asserted.
- **mac:codex** (`d8a3a2f5`): 0 BLOCKER / 1 MAJOR / 2 MINOR — NO-GO. Fix 2
  partially held. MAJOR (convergent met claude-MINOR): de guard vertrouwt een
  onvervalideerd caller-geleverd `product_id`. MINOR-1: task→product moet net als
  task→sprint via de Story (`Task.product_id` is óók gedenormaliseerd,
  `create-task.ts:91`; `userCanAccessTask` leest via de story, `access.ts:20-26`).
  MINOR-2: `include_archived`-gedrag voor bijgevoegde replies ambigu in mixed
  trees (`queue_archive` archiveert subtrees vanaf elke rij).
- **Triage:** alle bevindingen geverifieerd en bevestigd — 0 verworpen.
- **Fixes → r3:** §3 write-time-canonicalisatie: caller-geleverd `meta.work_item`
  gaat nooit meer ongevalideerd door (ids verenigd met de parameters door de
  resolver, `product_id` nooit overgenomen, conflict → `VALIDATION_ERROR`) —
  sluit de MAJOR én claude's MINOR; §4 `product_id` bij task-afleiding uit
  `Story.product_id`; §5 guard-tekst herzien + restrisico buiten-MCP-schrijvers
  expliciet geaccepteerd; §5 reply-query krijgt hetzelfde
  `include_archived`-predicaat; §6 testmatrix uitgebreid (product-mismatch,
  canonicalisatie, gearchiveerde reply).
