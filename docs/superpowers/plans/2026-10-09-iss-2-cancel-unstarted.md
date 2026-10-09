# ISS-2: claim-gebonden stop ook na leaseverloop en na cancel

Status: plan rev 5 — GO (ronde 4), MINORs verwerkt; scope-aanpassing tijdens bouw (zie "Bouw: task_implementation uitgesloten"), 2026-10-09. Issue: scrum4me-workers ISS-2 (Forgejo janpeter/scrum4me-workers#145).
Rev 1 (cancel sluit een nooit-gestarte poging direct af) is na ronde 1 vervangen. Zie het Review record.

## Doel (JP)
Een dispatch waarvan de poging nooit een runtime-scope kreeg, mag niet eeuwig op `UNCERTAIN` of `CANCEL_REQUESTED` blijven hangen. Dat bezet het slot en blokkeert de wachtende verzoeken erachter.

**Randvoorwaarde (JP-beslissing, ronde 1):** de ontwerpregel blijft gelden: *capaciteit blijft bezet tot er stopbewijs is*. Die regel staat vast in `__tests__/dispatch/end-to-end.integration.test.ts:503-530`. Cancel zelf geeft dus nooit capaciteit vrij zonder stopbewijs.

**Eerst bruikbare resultaat:** een levende supervisor die vóór de broker-`create` faalt, kan het verzoek ook afsluiten als de lease intussen verlopen is (`UNCERTAIN`) of als JP het intussen annuleerde (`CANCEL_REQUESTED`). Hij doet dat met de bestaande claim-gebonden stop. Het resultaat:
- na een leaseverloop: `FAILED`;
- na een cancel: `CANCELLED`.

In beide gevallen wordt de reservering vrijgegeven.

**Praktijkbewijs:** de integratietests zijn het primaire bewijs. Op prod controleert het eerstvolgende pre-scope-voorval (bron geweigerd, of de staging-root vol zoals bij ISS-4) dat het verzoek eindigt in plaats van te blijven hangen.

## Wat er feitelijk vastloopt (geverifieerd, main `f9404f1` en scrum4me-docker `master`)
**De supervisor** (`scrum4me-docker/lib/dispatch-supervisor.ts`):
- Bij een pre-scope-weigering (`PRE_SCOPE_REASONS` = `DISPATCH_PREPARED_SOURCES_REFUSED`, `DISPATCH_PREPARED_SOURCES_NO_SPACE`, `:105`) roept hij `closeClaimBound` aan (`:130-142`). Die doet eerst `submitClaimBoundStop` en daarna een `failed`-resultaat.
- Wordt een van beide geweigerd, dan wordt de fout ingeslikt en eindigt de poging lokaal als `uncertain` (`:283-287`).

**De service** neemt die stop alleen aan als request én attempt `CLAIMED` zijn (`src/dispatch/stop-evidence.ts:59`). Twee realistische routes vallen daardoor buiten de boot:
1. **Leaseverloop tijdens prepare.** Vóór de start heeft de supervisor geen attempt-heartbeat; renew wordt pas na de start aangeroepen (`dispatch-supervisor.ts:248`). Prepare mag 300 s duren, maar de lease verloopt na 120 s (`attempts.ts:380`). De service zet het verzoek dan op `UNCERTAIN` (`attempts.ts:~370-385`). De claim-gebonden stop en het resultaat worden geweigerd, en het verzoek hangt.
2. **Cancel tijdens prepare.** Cancel zet het verzoek op `CANCEL_REQUESTED` (`cancel.ts:38-42`). De claim-gebonden stop wordt geweigerd, en het verzoek hangt.

**Paden die al werken (ongewijzigd laten):**
- Een levende supervisor met een voorbereide container sluit een cancel af via de gescopete stop (`closeUnstarted`, `stop-evidence.ts:34,98`, `lifecycle.ts:58-62`). De service ondersteunt dit, maar de test `completion.integration.test.ts:87-99` dekt prepared tegen start, niet tegen cancel. Test 9 legt dit vast.
- Een dode, afgemelde supervisor wordt afgehandeld door de orphan-sweep (ISS-12, `orphans.ts`).

## Wijziging (scrum4me-mcp, één bestand: `src/dispatch/stop-evidence.ts`)
1. **`acceptClaimBoundStopInTransaction`: de state-eis wordt verruimd.** Nu moet `x.r.state==='CLAIMED' && x.a.state==='CLAIMED'`. Dat wordt: request- én attempt-state ∈ `{CLAIMED, UNCERTAIN, CANCEL_REQUESTED}`. Dat is dezelfde verzameling als in `acceptSignedOffUnstartedStopInTransaction` (`:86-87`).
   - **De replay-check gaat vóór de state- en resultaatchecks.** Bestaat er al een `stop_accepted` met kind `claim_bound_unscoped` en dezelfde sha256 (`:68-69`), dan komt dezelfde receipt terug, ook als het verzoek inmiddels terminaal is. Zo krijgt een supervisor die na een verloren antwoord opnieuw instuurt (zijn `claimStop` staat in de journal, byte-identiek) zijn receipt in plaats van een conflict.
   - **De replay is read-only.** Hij geeft alleen de bestaande receipt terug en muteert niets: geen nieuw resultaat, geen nieuwe outbox-versie en geen release. De event-lookup is al begrensd tot request + attempt (`:68`). De herberekende bytes binden candidate, generatie, attempt, incarnatie, request en slot.
   - **Nieuw:** geen bestaand resultaat voor het verzoek (zoals `:89`). Een al afgesloten verzoek krijgt daardoor geen nieuwe stop.
   - **Nieuw:** een expliciete check `x.r.generation === x.c.generation` (zoals `:85`). `verifyArtifactProof` vergelijkt `proof.generation` alleen met de candidate (`artifacts.ts:58-60`).
   - **De rest van de pre-scope-handtekening blijft ongewijzigd:**
     - `scope_id` null en geen `started_at`;
     - geen `started_scope`-event;
     - geen supervisor-stop-artefact;
     - geen onopgeloste publicatie;
     - `observedAt` tussen `first_claimed_at` en nu;
     - de generatie klopt;
     - dezelfde supervisor-autoriteit (`verifyArtifactProof` + `authenticateHistoricalSupervisor`).
2. **`submitClaimBoundStop` (`:103-105`): altijd afsluiten in dezelfde transactie,** in alle drie de states.
   - **Implementatie-eis:** de acceptatie-helper geeft aan of het een verse acceptatie was of een replay. Alleen bij een verse acceptatie volgt de afsluiting. Bij een replay keert de wrapper terug vóór `finishResult`/`finishStoppedCancellation`, want `transition` verhoogt de versie en schrijft de outbox (`lifecycle.ts:19-22`).
   - **`CLAIMED` en `UNCERTAIN`:** `finishResult(db, x, failed)`. Het `failed`-resultaat bouwt de service zelf op uit de begrensde reden, in **exact de vorm die de supervisor daarna zelf instuurt**:
     - `{version:1, outcome:'failed', summary:<reason>, report_markdown:'The attempt was refused before any runtime scope was created: <reason>. No container was created, so there is no output to report.', checks:[]}`;
     - die vorm komt uit scrum4me-docker `lib/dispatch-supervisor.ts` `closeClaimBound` (aanname; niet meegeleverd aan de reviewer);
     - `submittedHash` = `artifactHash(canonicalResult(result))`.

     Stuurt de supervisor daarna hetzelfde resultaat in, dan geeft completion `accepted:true`, `replayed` (`completion.ts:41`). De supervisor rondt dan schoon af (journal weg, bronnen opgeruimd), precies zoals nu. Wijkt zijn resultaat af, dan wordt het `late_result`/`terminal_result`: centraal afgesloten, lokaal een `uncertain` journal. Dat is geen correctheidsprobleem voor de service.
     - Uitkomst: `FAILED`, job `FAILED` met notify, reservering vrij.
     - Een `task_implementation` wordt als FAILED geprojecteerd, net als nu via het supervisor-resultaat.
   - **`CANCEL_REQUESTED`:** `finishStoppedCancellation(db, x)` (`lifecycle.ts:58-63`), zoals de gescopete `submitStop` al doet (`:97-99`). Uitkomst: `CANCELLED`, reservering vrij.
     - Het latere `failed`-resultaat van de supervisor wordt `terminal_result`, met een lokaal `uncertain` journal. Dat is hetzelfde als vandaag bij voorbereid + cancel (`closeUnstarted`).
   - **Waarom altijd atomair:** wordt een stop geaccepteerd maar komt het resultaat nooit binnen (de supervisor valt weg), dan zit het verzoek anders in elke state onherstelbaar vast:
     - de lease-sweep slaat een gestopte poging over (`attempts.ts:380,387-388`);
     - de orphan-sweep eist `stopped_at IS NULL` (`orphans.ts:12`);
     - recovery botst met de scopeloze binding (`historical-binding.ts:13-14`, `recovery.ts:41-42`).

     Voor `CLAIMED` bestaat dit gat al op main (ronde 3, MAJOR-1). Afsluiten bij de stop is bovendien al het bestaande patroon (`completion.ts:35-37`, T-1972; `orphans.ts:20-23`).
   - **Fixture:** de `report_markdown` in de bestaande test (`claim-bound-stop.integration.test.ts:58-61`) wordt gelijkgetrokken met de supervisorvorm, anders kan de test de replay niet aantonen.
   - **Gevolg voor het bestaande gedrag:** in `CLAIMED` geeft de stop zelf de reservering nu vrij, niet pas het resultaat daarna. De bestaande test `claim-bound-stop.integration.test.ts:46-65` wordt daarop aangepast:
     - de reservering is vrij na de stop;
     - het supervisor-resultaat daarna is `replayed`;
     - er is nog steeds één resultaat.

**De ontwerpregel blijft gelden.** Capaciteit komt pas vrij nadat de claim-gebonden stop (stopbewijs: er bestond nooit een scope) is geaccepteerd. Cancel zelf geeft niets vrij.

**Vertrouwensgrens (expliciet).**
- De claim-gebonden stop is een geauthenticeerde verklaring van de gebonden supervisor, geen zelfstandig databasebewijs dat er nooit een broker-`create` plaatsvond. `scope_id` wordt pas bij de centrale start gezet, dus een voorbereide, ongeregistreerde container heeft dezelfde handtekening in de database.
- Dat was al zo voor `CLAIMED`. Deze wijziging verruimt alleen de states, niet wie mag verklaren of wat.
- De supervisor stuurt de stop alleen bij redenen die aantoonbaar vóór de broker-`create` liggen (scrum4me-docker `lib/dispatch-supervisor.ts:97-105`; niet meegeleverd aan de reviewer, dus een aanname voor de servicereview).
- De service accepteert elk begrensd `DISPATCH_*`-label (`:57`). Het beperken tot een allowlist is bewust níet opgenomen, omdat dat service en supervisor aan elkaar koppelt.

**Geen wijziging aan:** `completion.ts`, `cancel.ts`, de e2e-invariant, de orphan-sweep, de recovery, de supervisor en workers. **Wel gewijzigd** wordt de bestaande `CLAIMED`-test hierboven.

## Bewust buiten scope (vervolg, aparte issues)
- **Een levende supervisor met een dubbelzinnige pre-scope-fout** (prepare-time-out, broker-create-fout): die blijft `uncertain`, omdat er mogelijk een container is. Hiervoor blijft operator-recovery nodig. De herstel-dialoog in workers kan die nog niet uitvoeren (`attempt={null}`, IP-13). → apart issue.
- **Geen heartbeat tijdens prepare** (300 s prepare tegen 120 s lease): dit veroorzaakt route 1. Een renew vóór de scope bestaat niet (`attempts.ts:334` eist een `scope_id`). → apart issue.
- **Lokale supervisor-journal:** een supervisor die al eerder `uncertain` opgaf, herhaalt `closeClaimBound` niet vanzelf. Die verzoeken (pre-deploy) vragen operator-recovery of een herstart. Of de supervisor bij een herstart een `uncertain` pre-scope-journal opnieuw indient, is hier niet onderzocht.

## Tests (`__tests__/dispatch/claim-bound-stop.integration.test.ts`, echte Postgres)
1. **UNCERTAIN door leaseverloop, pre-scope:**
   - claim, dan `heartbeat_at` terugzetten en `tick` (→ `UNCERTAIN`);
   - daarna alléén `submitClaimBoundStop`;
   - verwacht in die ene aanroep: request `FAILED`, één resultaat (outcome `FAILED`, summary = de reden), attempt `FAILED`, job `FAILED`, reservering vrij.
   - Een daarna ingediend `failed`-resultaat met **bewust afwijkende** tekst geeft `accepted:false` en `terminal_result`, zonder tweede resultaat. Het geval met identieke supervisorvorm staat in test 5b.
2. **CANCEL_REQUESTED, pre-scope:**
   - claim, dan cancel (→ `CANCEL_REQUESTED`; de reservering is nog bezet, want de invariant geldt);
   - daarna alléén `submitClaimBoundStop`;
   - verwacht: request `CANCELLED`, resultaat-outcome `CANCELLED`, reservering vrij.
3. **Supervisor valt weg na de stop** (ronde 2, MAJOR-2 en ronde 3, MAJOR-1): na de stop wordt geen resultaat ingediend. Dat geldt voor alle drie de states, en voor `CLAIMED` ook als de stop de lease-sweep vóór is (stop, dan `heartbeat_at` terugzetten, dan `tick`).
   - Verwacht: het verzoek is toch terminaal en de reservering vrij.
   - Een daaropvolgende `registerNextIncarnation` + `tick` (orphan-sweep) verandert niets.
4. **Volgorde ten opzichte van de orphan-sweep (ISS-12):**
   - **Eerst de orphan-sweep:** afmelden, `tick` (→ `signed_off_unstarted`, afgesloten), daarna de claim-gebonden stop. Die wordt geweigerd, er komt geen tweede `stop_accepted` en het resultaat blijft ongewijzigd.
   - **Eerst de claim-gebonden stop:** de orphan-sweep slaat de poging over (`stopped_at` is gezet).
5. **Replay:** identieke `submitClaimBoundStop`-bytes ná de afsluiting geven dezelfde receipt, en de replay muteert niets. Ongewijzigd blijven: resultaat-telling, request-versie, `released_at`, het aantal outbox-rijen en het aantal `result_accepted`-events. Afwijkende bytes (een andere reden of een andere `observedAt`) geven een conflict.
5b. **Het supervisor-resultaat ná een `CLAIMED`/`UNCERTAIN`-stop**, in exact de supervisorvorm, geeft `accepted:true`/`replayed` met één resultaat. Een afwijkend `failed`-resultaat geeft `accepted:false`/`terminal_result`.
5d. **Usage bij replay:** een identiek resultaat mét usage geeft `replayed`, en de usage wordt **niet** opgeslagen (`completion.ts:41` gaat vóór `:43`). Dat is bewust: bij een echte pre-scope-weigering heeft geen model gedraaid. Leg dit vast in de test en in een codecommentaar.
5e. **task_implementation via de claim-gebonden stop (`CLAIMED`):**
   - verwacht: taak `FAILED` met hiërarchie-projectie, `tasks.dispatch_request_id` gewist en job `FAILED`;
   - een stop-replay daarna projecteert niets opnieuw.
5c. **Generatie:** een request-generatie die afwijkt van de candidate geeft een conflict en er volgt geen afsluiting.
6. **Gescopete poging blijft geweigerd** in elk van de drie states. Breid de bestaande test (`:75-92`) uit met `UNCERTAIN` en `CANCEL_REQUESTED`.
7. **Start ná een claim-gebonden stop** in `CLAIMED`/`UNCERTAIN`: `startDispatchAttempt` geeft een conflict (`revoked_at`, `active()`), en er komt geen permit.
8. **Regressie:** deze bestaande tests blijven ongewijzigd groen:
   - de e2e-race (`end-to-end.integration.test.ts:503-530`);
   - ISS-12 (`attempts.integration.test.ts:235-243`);
   - het bestaande `CLAIMED`-claim-gebonden pad (`claim-bound-stop.integration.test.ts:30-72`), aangepast zoals beschreven onder "Gevolg voor het bestaande gedrag".
9. **Voorbereide poging → cancel → gescopete stop** (MINOR-2 uit ronde 2): sluit af als `CANCELLED`. Dit legt de claim "werkt al" uit "Wat er feitelijk vastloopt" vast, want die combinatie was nog niet getest.

**Verify:** `npm run typecheck`, `npm test` en `npm run test:dispatch` (de dispatch-suite valt buiten `npm test`). Er is geen `npm run verify` in deze repo.

## Uitrol
- Eén PR op scrum4me-mcp. De agent opent hem, JP merget.
- Daarna een redeploy van de dispatch-service.
- Er is geen migratie, geen schemawijziging en geen wijziging aan de supervisor of workers.

## Review record
### Ronde 1 (rev 1, commit `91e5937`, pin sha256 `b7fb4c79…d2be3`)
**Reviewers:**
- **CODEX:** request `fad7900e-8d33-49b8-9b0b-ff39114cb80c`, root `b82465b8-c040-43d1-85ed-8bbbb7409cc6`, key `a4f8c147-c3b9-446b-8139-75b0fe34ae02`. Verdict **GO**, 4 MINOR.
- **CLAUDE:** request `403671bb-a479-4af8-8cef-d07b764bfa72`, root `26668c6d-8ea5-4181-a6e7-5c93302d60b0`, key `46b56c61-8720-49fd-b938-80401eaa09f1`. Verdict **NO-GO**, 1 MAJOR, 4 MINOR, 2 NIT.

**Bepalende bevinding (CLAUDE MAJOR-1, geverifieerd).**
- Rev 1 keerde de geteste ontwerpregel "capaciteit blijft bezet tot er stopbewijs is" (`end-to-end.integration.test.ts:503-530`) stilzwijgend om, en brak de ISS-12-test `attempts.integration.test.ts:235-243`.
- Rev 1 overschatte bovendien het probleem. Een levende supervisor met een voorbereide container sluit een cancel nu al af. Werkelijk vast zitten:
  - pre-scope `CLAIMED` na cancel of leaseverloop;
  - `UNCERTAIN` met een dode, niet-afgemelde supervisor.

**Beslissing JP:** de ontwerpregel behouden. Rev 2 lost het op via de claim-gebonden stop in plaats van via cancel. Aanvullend onderzoek naar de supervisor (scrum4me-docker `master`) bevestigde de pre-scope-route en de prepare-heartbeat-gap.

**Overige bevindingen:**
- **Vervallen** met de wijziging van rev 1:
  - CODEX MINOR 1 en CLAUDE MINOR-2 (verwachting race-test);
  - CODEX MINOR 3 en CLAUDE MINOR-4 (bestaande `stopped_at`, al hangende `CANCEL_REQUESTED`);
  - CLAUDE NIT-6 en NIT-7.
- **Overgenomen:**
  - het eventtype-oordeel is niet meer nodig, want er komt geen nieuw stop-event;
  - CLAUDE MINOR-5 (verify-commando's);
  - CODEX MINOR 4 en CLAUDE "cleanup.ts irrelevant": externe claims zijn nu met bron en regel onderbouwd, en cleanup is geschrapt;
  - CODEX MINOR 2 en CLAUDE MINOR-3 (late stop-paden): in rev 2 vervangen door test 6 en de regressietest 7.

**Scope-delta:**
- Rev 2 is kleiner: geen cancel-wijziging, geen ontwerpregelbreuk. De wijziging is beperkt tot de state-eis van de claim-gebonden stop plus één `UNCERTAIN`-tak in completion.
- Er vallen twee vervolgpunten buiten scope (dubbelzinnige pre-scope-fout, prepare-heartbeat).
- Het eerste bruikbare resultaat dekt het pre-scope-incidentpatroon, niet élk `UNCERTAIN`-verzoek.

### Ronde 2 (delta, rev 2, commit `5062396`, pin sha256 `ae020015…24bc9`)
**Reviewer: CODEX**, request `8d9748a1-c6e5-42fd-a80c-b9bbabcb29ef`, root `2e320d05-1425-4337-b385-a12f7759af10`, key `bf1a46e9-7905-4233-9a72-461464915164`. Verdict **NO-GO**: 2 MAJOR, 2 MINOR.

**MAJOR-1 (geverifieerd).** `completion.ts:119` weigert in de tweede transactie elke state buiten `CLAIMED`/`RUNNING`/`CANCEL_REQUESTED`, dus `UNCERTAIN` → `FAILED` zou nooit werken.
- Oplossing in rev 3: completion wordt helemaal niet gewijzigd. De stop sluit zelf af.

**MAJOR-2 (geverifieerd).** Een stop die geaccepteerd is zonder resultaat (de supervisor valt weg) blijft vastzitten, buiten bereik van de orphan-sweep (`orphans.ts:12`) en van recovery (`historical-binding.ts:13-14`).
- Oplossing in rev 3: atomair afsluiten in `submitClaimBoundStop` voor `UNCERTAIN`/`CANCEL_REQUESTED`, naar het patroon van `orphans.ts` en T-1972. Tests 3 en 4.

**MINOR-1 (vertrouwensgrens).** Overgenomen: de alinea "Vertrouwensgrens" is toegevoegd. Een allowlist voor redenen is bewust niet opgenomen.

**MINOR-2 (testclaim prepared+cancel).** Overgenomen: de bewijsclaim is gecorrigeerd en test 9 is toegevoegd.

**Scope-delta:**
- Rev 3 is kleiner: één bestand in plaats van twee, completion blijft ongewijzigd.
- Er zijn tests bijgekomen voor het crash-na-stop-pad en de orphan-volgorde.
- Het eerste bruikbare resultaat is ongewijzigd.

### Ronde 3 (delta, rev 3, commit `c2281ad`, pin sha256 `aceba12b…7f106`)
**Reviewer: CODEX**, request `3a2eb30e-c922-4afc-8163-9c7cc2d94044`, root `f55f07a1-3097-4d3d-aa34-631fc0a4a6e0`, key `98b4994a-d0ab-4a4f-b334-0306667605d9`. Verdict **NO-GO**: 1 MAJOR, 2 MINOR.

De reviewer bevestigde dat rev 3 beide MAJORs van ronde 2 oplost voor `UNCERTAIN`/`CANCEL_REQUESTED`.

**MAJOR-1 (geverifieerd).** Hetzelfde gat ("stop geaccepteerd, resultaat nooit binnen") bestaat voor `CLAIMED`, ook op main. De lease-sweep slaat een gestopte poging over (`attempts.ts:380,387-388`), en de orphan-sweep en recovery ook.
- Oplossing in rev 4: de claim-gebonden stop sluit in álle drie de states atomair af. Voor `CLAIMED`/`UNCERTAIN` gebeurt dat met een resultaat in exact de supervisorvorm, zodat het latere supervisor-resultaat `replayed` wordt. De bestaande `CLAIMED`-test wordt aangepast; test 3 dekt nu ook `CLAIMED` en de volgorde stop-vóór-sweep.

**MINOR-2 (generatie, read-only replay).** Overgenomen: een expliciete generatiecheck en de eis dat de replay niets muteert, plus tests 5 en 5c.

**MINOR-3 (externe bronnen niet verifieerbaar).** Erkend. De supervisorvorm van het resultaat staat als aanname in het plan; een afwijking geeft alleen een lokaal `uncertain` journal, geen centraal probleem.

**Niet overgenomen:** een rollback-/fouttest rond de resultaat-insert. Reden: één `withDispatchRetryTransaction` (`db.ts:37-45`) is het bestaande atomiciteitsmechanisme. Een fout-injectie in Postgres voegt hier geen bewijs toe dat het bestaande mechanisme niet al levert.

**Scope-delta:**
- De wijziging is uniformer, met minder takken: altijd afsluiten bij de stop.
- Er is één bestaande test aangepast en de tests 5b en 5c zijn erbij gekomen.
- Het eerste bruikbare resultaat is ongewijzigd.

### Ronde 4 (delta, rev 4, commit `bced318`, pin sha256 `163d06bd…a371ff`)
**Reviewer: CODEX**, request `d3e0aabf-bb59-4e61-94d5-cc2eba0de081`, root `8489b0f4-3a7c-4b78-b3b2-208e10ae7168`, key `fd2585c8-90c4-4e42-97e1-5765e1cab455`. Verdict **GO**, 4 MINOR.

**Bevestigd:**
- Ronde 3, MAJOR-1 is prospectief opgelost voor alle drie de states, zonder capaciteit vrij te geven vóór stopbewijs.
- De replay-hash werkt: `finishResult` slaat de meegegeven `submittedHash` op (`lifecycle.ts:53`), en `completion.ts:41` vergelijkt daarmee.
- Er zijn geen nieuwe veiligheidsfouten in `CLAIMED`.

**MINOR 1-3 overgenomen in rev 5:**
- de verwachting in test 1 is verduidelijkt;
- de fixture-tekst wordt gelijkgetrokken;
- usage bij replay is vastgelegd (test 5d);
- de replay mag niet afsluiten (implementatie-eis), met strengere asserts in test 5;
- er is een task_implementation-test bijgekomen (test 5e).

**MINOR 4 (externe compatibiliteit niet verifieerbaar)** is erkend. Bij een afwijking vangt `terminal_result` het centraal veilig op.

**Niet opgelost:** al bestaande rijen "stop zonder resultaat" van vóór de deploy. Die vallen buiten scope.

**Scope-delta:** alleen extra tests en een implementatie-eis. De productiewijziging blijft één bestand.

### Bouw: task_implementation uitgesloten (beslissing JP, PR #209)
**Wat er gebeurde.** CI en de codex-PR-review vonden het volgende:
- Het sluiten van een `task_implementation` geeft de taakbinding vrij.
- De DB-guard `queue_dispatch_guard_task()` (Scrum4Me-migratie `20260915180000`, regels 109-110) staat dat alleen toe na een stop van kind `registered_started_scope`, `prepared_created_nonlaunch`, `operator_attested` of `runtime_rebooted`.
- Omdat `claim_bound_unscoped` daar niet tussen staat, rolt de afsluiting terug.
- Dit geldt op main al voor het bestaande `CLAIMED`-pad en voor de ISS-12-orphan-close van taken.

**Waarom niet nu opgelost.** De guard is byte voor byte vastgepind in het DB-access-adoptiemanifest (`scripts/db-access/adoptions/idea-213.json`). Een wijziging vraagt een eigen DB-access-transitie in Scrum4Me.

**Beslissing JP.**
- Taken houden exact het gedrag van vóór ISS-2: alleen `CLAIMED`, geen atomaire afsluiting (`closesAtStop`).
- Alle andere acties, waaronder het incidenttype QUEUE_REVIEW, zijn wel opgelost.
- De guard-wijziging komt in een apart Scrum4Me-issue.
- Test 5e is daarop aangepast.
