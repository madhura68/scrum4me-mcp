# Bevroren meetinput — review-context nul- en nameting (IDEA-252, story 4)

Herkomst: ISS-2-loop ronde 4, request `d3e0aabf-bb59-4e61-94d5-cc2eba0de081` (key `fd2585c8-90c4-4e42-97e1-5765e1cab455`), objective en verification letterlijk uit het orchestrator-transcript; alleen rev 4/`bced318` → rev 5/`b3caa8c` aangepast. Pin: key `plan`, `docs/superpowers/plans/2026-10-09-iss-2-cancel-unstarted.md` @ `b3caa8cb47e46b9e214e719e8db810210dad1493`, sha256 `a587bf14be7fbcca51b2cd5cdb2e86c33ef7b559485ed4fbb4c73e85a85a8c7f`; `repository.base_sha` = dezelfde commit; `response_format` = DispatchResult; `reply_to` = mac:claude. Nul- en nameting gebruiken exact de bytes tussen de markeringen hieronder.

## objective

<!-- objective-begin -->
Delta-review ronde 4 (rev 5, meetherhaling) van een implementatieplan in repo scrum4me-mcp. Geen gesprekshistorie; alles staat hier en in het gepinde plan (key `plan`, inclusief Review record van rondes 1-4). Code read-only in /work op commit b3caa8c (= main 76016b4 + alleen dit plan).

## Doel (JP)
Een dispatch waarvan de poging nooit een runtime-scope kreeg mag niet eeuwig op CLAIMED/UNCERTAIN/CANCEL_REQUESTED blijven hangen (slot bezet). Randvoorwaarde (JP): "capaciteit blijft bezet tot er stopbewijs is" (`__tests__/dispatch/end-to-end.integration.test.ts:503-530`); cancel zelf geeft niets vrij.

## Ronde 3 (jij, CODEX) vond
MAJOR-1: het gat "claim-bound stop geaccepteerd, resultaat komt nooit" bestaat ook voor CLAIMED (lease-sweep attempts.ts:380,387-388 en orphan-sweep orphans.ts:12 slaan een gestopte poging over). MINOR-2: expliciete request.generation===candidate.generation en read-only replay.

## Rev 5 (één bestand: src/dispatch/stop-evidence.ts)
- acceptClaimBoundStopInTransaction: states {CLAIMED, UNCERTAIN, CANCEL_REQUESTED}; read-only replay-check vóór state/resultaat-checks; geen bestaand resultaat; expliciete generatiecheck.
- submitClaimBoundStop sluit ALTIJD in dezelfde transactie af: CLAIMED/UNCERTAIN → finishResult met een failed-resultaat in exact de vorm die de supervisor daarna zelf instuurt (zodat dat latere resultaat `replayed` wordt via completion.ts:41); CANCEL_REQUESTED → finishStoppedCancellation.
- Bestaande CLAIMED-test (claim-bound-stop.integration.test.ts:46-65) wordt aangepast: reservering vrij al na de stop.

## Wat ik van je vraag
1. Lost rev 5 ronde-3 MAJOR-1 op zonder de randvoorwaarde te breken? Verifieer tegen de code.
2. Klopt de `replayed`-redenering: completion.ts eerste transactie (regels ~39-44) vergelijkt het result_accepted-event's submitted_hash met de nieuwe submittedHash — geeft een byte-identiek resultaat (canonicalResult) na een service-gesynthetiseerde finishResult werkelijk accepted:true/replayed? Let op welke hash finishResult in het event schrijft (lifecycle.ts:53) en of usage/andere velden het breken.
3. Nieuwe faalpaden door altijd-afsluiten in CLAIMED (bv. task_implementation-projectie, publicatie, jobstatus, een supervisor die ná de stop nog iets doet)?
4. Ontbrekende of overbodige tests? Kleinere oplossing binnen de randvoorwaarde?

Verifieer tegen de code, niet tegen het plan. Bevindingen met bestand:regel. Supervisorcode (scrum4me-docker) en de shared-submodule zitten niet in /work; markeer wat je niet kunt verifiëren.<!-- objective-end -->

## verification

<!-- verification-begin -->
Ernst per bevinding: BLOCKER (plan is fout of onveilig), MAJOR (moet vóór bouw aangepast), MINOR (verbetering), NIT. Alleen BLOCKER/MAJOR rechtvaardigen NO-GO. Geef exact één verdict in `review.verdict`: GO of NO-GO, nooit COMMENT.<!-- verification-end -->
