# Idee-doc-tools in attach-modus — implementatieplan (increment 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Doel:** een interactief uitgewerkt idee (grill, spec en plan in een hoofdsessie, ceremonie met `create_*`) krijgt zijn documenten en zijn eindstatus via de MCP. Daarvoor is geen workerjob, geen prod-SQL en geen UI-klik meer nodig.

**Architectuur (optie B, gekozen door JP op 2026-10-16):** de doc-tools zijn mode-aware.
- **Met een actieve maker-job** gedragen ze zich exact zoals nu (pipeline).
- **Zonder actieve maker-job (attach):** ze schrijven de ProductDoc, zetten `*_doc_id` en hooguit de stabiele status die de pipeline op dat punt ook zou bereiken. Ze starten nooit een job.
- **Afsluiten** gebeurt met één expliciete actie: `update_idea({ status: 'PLANNED' })`.

Geen schemawijziging en geen tweede schrijver op de statusmachine.

**Tech stack:** TypeScript, MCP SDK, Prisma 7 (mock-tests met Vitest), zod.

**Achtergrond:** analyse van 24 sessies en 13 ideeën (sessie 2026-10-16), samengevat in memory `idee-statusmachine-volgt-interactief-pad-niet`.
- Na de ceremonie stonden 248, 249, 255, 256 en 258 op DRAFT, en 257, 260 en 262 op PLAN_READY.
- 251 werd PLANNED via prod-SQL.
- `grill_doc_id` en `spec_doc_id` waren vrijwel altijd leeg.
- Oorzaken (geverifieerd op HEAD 3e5f7a0):
  - de grill-gate weigert DRAFT;
  - de beschrijvingen van spec- en plan-write beloven onvoorwaardelijk een review-dispatch, maar de code dispatcht alleen met een actieve maker-job;
  - er is geen pad naar PLANNED behalve `materializeIdeaPlan`.

## Global Constraints

- Geen Prisma-migratie en geen enum-wijziging (`IdeaStatus`, `IdeaLogType` blijven zoals ze zijn).
- Pipelinegedrag blijft byte-gelijk wanneer er een actieve maker-job is (IDEA_GRILL, IDEA_MAKE_SPEC/IDEA_REVISE_SPEC, IDEA_MAKE_PLAN). Bestaande tests blijven ongewijzigd groen, behalve waar een test een foutmeldingstekst vastpint die deze increment bewust wijzigt, en de select-pin van de eigendomsquery in `update-idea.test.ts` (Taak 3).
- De bestaande eigendoms-, product-binding-, demo- en content-policy-checks blijven ongewijzigd.
- Foutmeldingen in het Nederlands, toolbeschrijvingen in het Engels (huidige conventie).
- Verificatie per taak: `npm run typecheck`, `npm run typecheck:tests` en `npm test` (de volledige unit-suite, want mock-tests pinnen queries).

## Review Focus

1. **Afsluiten terwijl er een pipeline-job met `idea_id` loopt, of terwijl er net een wordt aangemaakt.** Een gelijktijdige dispatch (IDEA_GRILL, de spec/plan-loop, een IDEA_CHAT-beurt) mag niet door PLANNED worden overschreven. Taak 3 neemt daarom de idee-rij op slot en herleest status en jobs binnen dezelfde transactie, en test die volgorde. Een losse SPEC_REVIEW via `dispatch_job`/`dispatchSpecReview` (de situatie bij IDEA-263) heeft géén `idea_id` (`src/lib/dispatch/review-jobs.ts:140-151`) en raakt de idee-status niet (`submit-review.ts:575` volgt alleen `job.idea`): de guard ziet hem bewust niet.
2. **Afsluiten na increment 1 van een idee met meerdere increments.** PLANNED is niet meer bewerkbaar. Herstel blijft mogelijk: `update_idea_plan_md` heeft geen gate en zet PLAN_READY (geldige plan-yaml vereist, geen worker nodig); `dispatch_job IDEA_GRILL` mag ook vanuit PLANNED, maar vraagt een verse worker en een `repo_url` (`idea-jobs.ts:69-115`). De beschrijving zegt daarom "na het laatste increment". Dit is bewust geaccepteerd, zonder extra test.
3. **Grill-write vanuit PLANNED of vanuit een spec/plan-pipelinestatus.** Die blijft geweigerd, en de melding noemt de toegestane statussen. Taak 1 test dit.
4. **Interactieve spec- of plan-write terwijl er een maker-job loopt van een andere sessie.** Dit is pipelinegedrag, ongewijzigd, en het antwoordveld `review_dispatched: true` maakt het zichtbaar. Taak 2 test dit.
5. **Grill-write vanuit PLAN_READY zet de status terug naar GRILLED.** Dat is bestaand gedrag en valt buiten deze increment. Alleen de beschrijving vermeldt het.
6. **Een IDEA_CHAT-beurt op een idee in DRAFT** (`src/prompts/idea-chat/chat.md`, r. 23–25) kan na Taak 1 een grill schrijven en het idee naar GRILLED zetten. Dat is een bewuste verruiming aan de workerkant (JP-besluit 3: toegestaan). Afsluiten vanuit een chatbeurt kan niet: de eigen RUNNING IDEA_CHAT-job blokkeert dat (Taak 3). `chat.md` stap 5 ("wijzig géén status") gaat over expliciete statuswijzigingen; de grill-write zet nu al GRILLED vanuit PLAN_READY, dus de tekst blijft ongewijzigd.
7. **Herhaald afsluiten** (retry na een transportfout) is een no-op met succes, geen fout. Taak 3 test dit. Afsluiten vanuit SPEC_FAILED of een andere pipeline-status blijft geweigerd (niet in `EDITABLE_STATUSES`).

---

### Taak 1: grill-write vanuit DRAFT en GRILL_FAILED (attach)

**Bestanden:**
- Wijzig: `src/tools/update-idea-grill-md.ts` (`GRILL_WRITE_ALLOWED_FROM`, foutmelding, beschrijving)
- Test: `__tests__/update-idea-grill-md-product.test.ts`

**Interfaces:**
- Levert: `GRILL_WRITE_ALLOWED_FROM = ['DRAFT', 'GRILL_FAILED', 'GRILLING', 'GRILLED', 'PLAN_READY']`. Het resultaat is ongewijzigd: `{ ok, idea: { id, status, code }, doc }`.

- [ ] **Stap 1: tests schrijven en rood zien**
  - `staat grill-write toe vanuit DRAFT en zet GRILLED + grill_doc_id`: `txMocks.idea.update` aangeroepen met `data` die `{ status: 'GRILLED', grill_doc_id: 'doc-1' }` bevat; resultaat `ok: true`.
  - `staat grill-write toe vanuit GRILL_FAILED`: zelfde asserties.
  - `weigert vanuit PLANNED met de toegestane statussen in de melding`: `isError`, en de tekst bevat `toegestaan: DRAFT, GRILL_FAILED, GRILLING, GRILLED, PLAN_READY` en níét `annuleer eerst de pipeline`.
  - Pas de bestaande test `M23 chat-gate: weigert grill-write vanuit SPEC_REVIEWING` alleen aan als die de oude meldingstekst vastpint.
  - Draai `npx vitest run __tests__/update-idea-grill-md-product.test.ts`. Verwacht: de nieuwe tests FAIL.

- [ ] **Stap 2: implementeren**
  - Breid `GRILL_WRITE_ALLOWED_FROM` uit.
  - Nieuwe melding: `` `Grill-write niet toegestaan vanuit status ${idea.status} (toegestaan: ${GRILL_WRITE_ALLOWED_FROM.join(', ')}) — het idee zit in de spec/plan-pipeline of is al afgesloten` ``.
  - Werk het M23-commentaar bij: DRAFT en GRILL_FAILED zijn "vrije voorbereidingsfase". Er loopt dan geen grill-job, want de dispatch van IDEA_GRILL zet het idee direct op GRILLING. Een losse SPEC_REVIEW kan wel lopen (IDEA-263); die raakt de grill niet.
  - Beschrijving, aan te vullen met: "Allowed from DRAFT, GRILL_FAILED, GRILLING, GRILLED and PLAN_READY. Outside an IDEA_GRILL job (an interactive grill) it only saves the doc and sets GRILLED; it never starts a job. Writing from PLAN_READY resets the status to GRILLED."

- [ ] **Stap 3: groen zien.** Draai `npx vitest run __tests__/update-idea-grill-md-product.test.ts` en daarna de volledige verificatie (Global Constraints). Alles PASS.

- [ ] **Stap 4: commit.** Commit `feat(update_idea_grill_md): interactieve grill vanuit DRAFT/GRILL_FAILED opslaan`.

### Taak 2: spec- en plan-write vertellen wat ze doen

**Bestanden:**
- Wijzig: `src/tools/update-idea-spec-md.ts` (`maybeAutoDispatchSpecReview`, respons, beschrijving)
- Wijzig: `src/tools/update-idea-plan-md.ts` (`maybeAutoDispatchPlanReview`, respons, beschrijving)
- Test: `__tests__/update-idea-spec-md.test.ts` en `__tests__/update-idea-plan-md-loop.test.ts`

**Interfaces:**
- Levert:
  - `maybeAutoDispatchSpecReview(ideaId: string, revisionId: string): Promise<boolean>`: true alleen als er een SPEC_REVIEW-rij is aangemaakt.
  - `maybeAutoDispatchPlanReview(...)`: dezelfde signatuur als nu, maar retourneert `Promise<boolean>`.
  - Beide tools krijgen het responsveld `review_dispatched: boolean`, met als betekenis "déze aanroep heeft een review aangemaakt". Bij P2002-dedup, bij een al actieve loop-job en bij een dispatchfout na de commit is het `false`, ook als er al een review loopt. De spec of het plan blijft opgeslagen, zoals nu.

- [ ] **Stap 1: tests schrijven en rood zien**
  - spec: `zonder actieve maker-job: geen SPEC_REVIEW, status ongewijzigd, review_dispatched false`. Asserties: geen `claudeJob.create`, `idea.update` zonder `status`, en de respons bevat `review_dispatched: false`.
  - spec: de bestaande happy-path-test met actieve maker krijgt de assertie `review_dispatched: true`.
  - spec: `P2002-dedup geeft review_dispatched false`.
  - plan: `zonder actieve IDEA_MAKE_PLAN-job: PLAN_READY, geen review, review_dispatched false`, ook bij `auto_plan_review: true`.
  - plan: de bestaande loop-test met maker-job krijgt de assertie `review_dispatched: true`.

- [ ] **Stap 2: implementeren.** Retourneer de boolean uit beide helpers en zet die in de respons. Herschrijf de beschrijvingen.
  - **spec:** "…sets Idea.spec_doc_id. Only when an IDEA_MAKE_SPEC/IDEA_REVISE_SPEC job for this idea is CLAIMED/RUNNING does it also dispatch the SPEC_REVIEW for that round and set SPEC_REVIEWING. Called interactively (no such job) it saves the doc and leaves the status unchanged. The response field review_dispatched tells which happened."
  - **plan:** voeg alleen de voorwaarde toe ("the IDEA_REVIEW_PLAN is only enqueued when an IDEA_MAKE_PLAN job is CLAIMED/RUNNING and product.auto_plan_review is on; called interactively it saves the doc, sets PLAN_READY and starts no review").

- [ ] **Stap 3: groen zien.** Draai de twee testbestanden en daarna de volledige verificatie. Alles PASS.

- [ ] **Stap 4: commit.** Commit `fix(update_idea_spec_md, update_idea_plan_md): beschrijving en review_dispatched volgen het echte dispatchgedrag`.

### Taak 3: afsluiten met `update_idea({ status: 'PLANNED' })`

**Bestanden:**
- Wijzig: `src/tools/update-idea.ts`
- Test: `__tests__/update-idea.test.ts`

**Interfaces:**
- Consumeert: `ACTIVE_JOB_STATUSES` uit `src/lib/dispatch/idea-jobs.ts` (readonly tuple: gebruik `[...ACTIVE_JOB_STATUSES]`, zoals `idea-jobs.ts:91`) en `lockIdeaRow(tx, ideaId)` uit `src/lib/idea-plan-loop.ts:82`.
- Levert:
  - Invoer: `status?: 'PLANNED'` (`z.literal('PLANNED')`). De refine wordt "minstens één van title, description of status".
  - Resultaat: ongewijzigd `{ id, code, status }`.
  - Nieuwe constante in het bestand: `IDEA_CLOSE_BLOCKING_JOB_KINDS = ['IDEA_GRILL', 'IDEA_MAKE_SPEC', 'IDEA_REVISE_SPEC', 'SPEC_REVIEW', 'IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN', 'IDEA_CHAT']`. IDEA_CHAT telt mee: een chatbeurt (ook de harness-chat) mag een idee niet afsluiten, en de eigen RUNNING-job blokkeert dat. Een interactief afsluiten tijdens een lopende chatbeurt wordt dan ook geweigerd; dat is zeldzaam genoeg. Blijft een IDEA_CHAT-job hangen (bijv. QUEUED zonder chat-worker), dan is de remedie wachten of de job annuleren via `/admin/jobs` → Annuleer (`cancelJobAction`, Scrum4Me `actions/admin/jobs.ts:26` @ origin/main `ca9f1a05`). De knop "Pipeline annuleren" op het idee (`cancelIdeaJobAction`, die IDEA_CHAT status-neutraal annuleert, `actions/ideas.ts:728`) staat alleen in de spec/plan-statussen (`components/ideas/idea-row-actions.tsx:93`), dus niet in een bewerkbare status. De MCP heeft geen job-cancel-tool.

- [ ] **Stap 1: tests schrijven en rood zien**
  - `zet status PLANNED vanuit PLAN_READY en logt STATUS_CHANGE`: de update bevat `status: 'PLANNED'`; `ideaLog.create` met `type: 'STATUS_CHANGE'`, `metadata: { from: 'PLAN_READY', to: 'PLANNED', via: 'update_idea' }`; de respons heeft `status: 'PLANNED'`.
  - `zet PLANNED vanuit DRAFT (interactief pad)`: zelfde asserties met `from: 'DRAFT'`.
  - `weigert PLANNED bij een actieve pipeline-SPEC_REVIEW (met idea_id)`: `tx.claudeJob.findFirst` geeft `{ id: 'job-1', kind: 'SPEC_REVIEW' }`. Verwacht `isError`, de tekst bevat `SPEC_REVIEW` en `job-1`, en er volgt geen update.
  - `weigert PLANNED tijdens een lopende IDEA_CHAT-beurt`: zelfde vorm met `kind: 'IDEA_CHAT'`.
  - `title-only update doet geen jobcheck`: `claudeJob.findFirst` en `$transaction` worden niet aangeroepen; `prisma.idea.update` wordt rechtstreeks aangeroepen zoals nu (de bestaande tests blijven ongewijzigd, op de select-pin hieronder na).
  - `status-pad: lock vóór herlezing en jobcheck, alles in één transactie`: binnen de `$transaction`-callback is de volgorde `tx.$queryRaw` (lockIdeaRow) → `tx.idea.findUnique` → `tx.claudeJob.findFirst` → `tx.idea.update` → `tx.ideaLog.create` (vergelijk `mock.invocationCallOrder`).
  - `herleest de status onder het slot`: de pre-check ziet DRAFT, `tx.idea.findUnique` geeft GRILLING. Verwacht `isError` met de status in de melding, en geen `tx.idea.update`.
  - `tweede afsluiting is een no-op`: het idee staat al op PLANNED en alleen `status` is meegegeven. Verwacht succes met de volledige respons `{ id, code, status: 'PLANNED' }`, zonder `$transaction`, update of log.
  - `herlezing vindt het idee niet meer`: `tx.idea.findUnique` geeft `null`. Verwacht `isError` met `Idea not found`, en geen `tx.idea.update`.
  - De eigendomsquery selecteert voortaan ook `code` (zie stap 2). Pas daarom de select-pin in de bestaande test `weigert een idee buiten product/pool` (`__tests__/update-idea.test.ts:168-171`) aan naar `{ id: true, code: true, status: true }`; dat is de enige wijziging aan een bestaande assertie buiten de refine-melding.
  - Breid de mock in `__tests__/update-idea.test.ts` uit met `$transaction` (callback-vorm, roept de callback aan met een `tx`-mock), en op die `tx` met `$queryRaw`, `idea.findUnique`, `idea.update`, `claudeJob.findFirst` en `ideaLog.create`.
  - `weigert PLANNED vanuit SPEC_REVIEWING`: de bestaande gate `EDITABLE_STATUSES` grijpt in, en de melding noemt de status.
  - `status-only schrijft geen DOC_UPDATE-kanaalbericht`: `ideaChatMessage.create` wordt niet aangeroepen.
  - `weigert een andere status dan PLANNED`: `status: 'DRAFT'` geeft een zod-validatiefout.
  - De bestaande test `eist minstens één van title/description` wordt de nieuwe refine-melding.

- [ ] **Stap 2: implementeren**
  - Volgorde in `handleUpdateIdea`: zod → `requireWriteAccess` → eigendom (zoals nu, met `select: { id: true, code: true, status: true }` zodat de no-op `code` kan teruggeven) → alleen `status` en het idee staat al op PLANNED: no-op, geef `{ id, code, status }` terug → content-policy alleen als title of description is meegegeven → `EDITABLE_STATUSES` als snelle pre-check (zoals nu).
  - Zonder `status`: het bestaande pad, ongewijzigd (`prisma.idea.update` rechtstreeks).
  - Met `status`: één interactieve `prisma.$transaction(async (tx) => …)`:
    1. `lockIdeaRow(tx, idea_id)`;
    2. herlees de status met `tx.idea.findUnique` en pas `EDITABLE_STATUSES` opnieuw toe (`null`, het idee is intussen verwijderd: weiger met `Idea not found`);
    3. jobcheck `tx.claudeJob.findFirst({ where: { idea_id, kind: { in: [...IDEA_CLOSE_BLOCKING_JOB_KINDS] }, status: { in: [...ACTIVE_JOB_STATUSES] } }, select: { id, kind } })`;
    4. `tx.idea.update` met `status: 'PLANNED'` (plus title/description als die zijn meegegeven);
    5. `tx.ideaLog.create({ type: 'STATUS_CHANGE', content: `Status ${from} → PLANNED (update_idea)`, metadata: { from, to: 'PLANNED', via: 'update_idea' } })`.

    Een weigering binnen de callback wordt een `toolError` na de rollback.
  - Melding bij een jobtreffer: `` `Idee kan niet worden afgesloten: er loopt nog een ${kind}-job (${id}) — wacht tot die klaar is of annuleer hem` ``.
  - Restvenster, bewust geaccepteerd: een dispatch die de status vóór het slot las, schrijft ná de commit zijn jobstatus (GRILLING, SPEC_DRAFTING of PLANNING) over PLANNED. Dat is consistent: er loopt dan een echte job die zijn eigen vervolgstatus zet. Voor IDEA_GRILL is PLANNED zelfs een toegestane bron; IDEA_MAKE_SPEC en IDEA_MAKE_PLAN zijn dat niet (`IDEA_KIND_RULES`, `idea-jobs.ts:20-39`), maar een dispatch die vóór het slot valideerde, schrijft toch.
  - Het DOC_UPDATE-kanaalbericht komt alleen als title of description is gewijzigd.
  - Beschrijving: "Update the title and/or description of an idea, or close it with status: 'PLANNED' once its last ceremony increment is built (sprint/PBI created interactively). Closing is refused while an idea pipeline job (grill/spec/plan/review) is active. A PLANNED idea leaves get_ideas_context and is no longer editable."

- [ ] **Stap 3: groen zien.** Draai `npx vitest run __tests__/update-idea.test.ts` en daarna de volledige verificatie. Alles PASS.

- [ ] **Stap 4: commit.** Commit `feat(update_idea): idee afsluiten met status PLANNED na de laatste ceremonie`.

### Taak 4: PR, uitrol en praktijkproef

**Bestanden:** geen code. Branch `claude/idee-attach-modus`, met deze plan-file erin.

- [ ] **Stap 1:** push de branch en open de PR via de Forgejo-API (`$FORGEJO_TOKEN`, curl `--config`). JP merget.
- [ ] **Stap 2:** rol uit over de oppervlakken van de uitrol van PR #227 (sessies 14-10, ISS-17) en de IDEA-251-uitrol (13-10):
  - mac `~/Development/scrum4me-mcp-stable`;
  - scrum4me-server `/srv/scrum4me/repos/scrum4me-mcp`;
  - max2 `/srv/scrum4me/repos/scrum4me-mcp`;
  - max2 `~/Development/scrum4me-mcp-stable` (harness-MCP);
  - de `scrum4me-mcp-http`-container (copilot-pad, roept `update_idea` aan): rebuild plus `docker compose up -d --no-deps --force-recreate scrum4me-mcp-http`, zoals op 13-10.

  Per checkout: `merge --ff-only`, `git submodule update --init`, `npm run prisma:generate`, `tsc --noEmit`. Er is geen migratie, dus geen Scrum4Me-deploy. JP doet de `/mcp`-reconnect.
- [ ] **Stap 3: praktijkproef op echte ideeën, alleen met akkoord van JP per idee.**
  - (a) IDEA-263: `update_idea_grill_md` met de inhoud van GRILLS/idea-263-grill. Verwacht GRILLED en een gevulde `grill_doc_id`. Stem dit af met de lopende MacSearch-sessie.
  - (b) IDEA-263: `update_idea_spec_md` met SPECS/idea-263-spec. Verwacht `review_dispatched: false`, de status blijft GRILLED en `spec_doc_id` is gevuld.
  - (c) IDEA-256 (PR gemerged, sprint gesloten, nu DRAFT): `update_idea({ status: 'PLANNED' })`. Verwacht PLANNED, en IDEA-256 verdwijnt uit `get_ideas_context`.
  - Lees vóór (a) en (b) de actuele revisie van de GRILLS- en SPECS-doc (`get_product_doc`) en geef exact die inhoud mee; noteer doc-id, revisie-id en sha256 in de NOTE.
  - Leg elke uitkomst vast met `log_idea_decision` (NOTE).

### Taak 5: instructies bijwerken (na de uitrol)

**Bestanden:**
- `~/.claude/rules/scrum4me-methodiek.md` via de agent-rules-doc `claude-scrum4me-methodiek` (product `cmptqaitl002b4y7ro6xk5uub`). Volg de werkwijze uit memory `agent-rules-bron-per-bestand`: eerst het lokale bestand diffen tegen de doc, daarna een nieuwe revisie; JP publiceert.
- De methodiek-sectie in `~/.codex/AGENTS.md` (mac-lokaal, apart van de agent-rules-doc).
- Memories `idea-grill-write-gate`, `idee-statusmachine-volgt-interactief-pad-niet` en `scrum4me-mcp-checkout-per-host` (die mist de harness-checkout op max2 en de `scrum4me-mcp-http`-container).

- [ ] **Stap 0:** lees de actuele revisie van de agent-rules-doc en van de lokale bestanden, en noteer revisie-id en sha256 vóór je schrijft.
- [ ] **Stap 1:** vul de bullet "Idee uitwerken" in de methodiekregel aan met één zin: "Leg de fase-uitkomst vast met de doc-tool (grill → `update_idea_grill_md`, spec → `update_idea_spec_md`, plan → `update_idea_plan_md`); buiten een workerjob starten die geen job. Sluit het idee na het laatste ceremonie-increment af met `update_idea({ status: 'PLANNED' })`."
- [ ] **Stap 2:** zet dezelfde zin in de methodiek-sectie van `~/.codex/AGENTS.md`.
- [ ] **Stap 3:** werk de drie memories bij.

## Niet in increment 1

- Een yaml-samenvatting van het plan-formaat in de beschrijving van `update_idea_plan_md` (beide reviewers ronde 1: buiten de acceptatie, en een kopie van de parser in tooltekst kan verouderen).
- Een statusgate op `update_idea_plan_md` (schrijven vanuit PLANNED of REVIEWING_PLAN). Het faalpad is alleen uit de code afgeleid en niet waargenomen.
- PLAN_REVIEWED vanuit de `dispatch_review`-loop (`update_idea_plan_reviewed` eist een IDEA_REVIEW_PLAN-job).
- Een idee koppelen aan een bestaande PBI of sprint achteraf (het geval van IDEA-251), en meerdere bouwsprints per idee.
- SPEC als `source_docs`-rol op `create_pbi` en `link_pbi_doc`.
- `get_idea_context` op IDEA-code; fan-out en `wait all` bij `dispatch_review`; normalisatie van de frontmatter in `create_product_doc`.

## Besluiten JP (2026-10-16)

1. **"Afgerond" = PLANNED, vanuit elke bewerkbare status (variant a).** Gecontroleerd op 2026-10-16:
   - Op `ideas` staat geen CHECK-constraint op status of `pbi_id` (Scrum4Me-migraties).
   - De web-UI kan PLANNED zonder PBI aan: de knop "Bekijk PBI" en de sync-tab tonen alleen als `pbi_id` gevuld is.
   - Bewuste afwijking: de web-statusmachine (`lib/idea-status.ts`) kent PLANNED alleen vanuit PLAN_READY en PLAN_REVIEWED.
   - Afgewezen alternatieven: `pbi_id` of `build_sprint_id` eisen; `archived`.
2. **Geen registratie** als issue of idee; dit plan staat op zichzelf.
3. **Chatverruiming toegestaan:** een IDEA_CHAT-beurt op een idee in DRAFT mag de grill schrijven (Review Focus 6). `chat.md` blijft ongewijzigd.
