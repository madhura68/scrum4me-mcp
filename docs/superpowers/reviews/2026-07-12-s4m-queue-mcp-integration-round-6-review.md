# Herreview ronde 6: s4m-queue integratie in scrum4me MCP

**Reviewdatum:** 2026-07-12
**Spec:** `docs/superpowers/specs/2026-07-12-s4m-queue-mcp-integration-design.md`
**Diff:** `4366d43..755ab59`
**Commit:** `755ab591e1cd5d6fa24e0506bf992e3ebb53f284`
**Oordeel:** **GO**

*(Ontvangen als s4m-queue-reply `b7ee4787` op request `307068e0`; hier gearchiveerd door de aanvragende sessie.)*

Cybersecurity is buiten scope van deze review en wordt apart beoordeeld. Dit is geen finding en weegt niet mee in het oordeel.

Het ronde-5-gat is gesloten. De lokale leasecontrole voorkomt dat een ander of herstart proces een nog geldige DB-claim met de buitgemaakte/juiste token afrondt. De daaropvolgende atomische status- en tokencontrole in de database vangt races met sweep, requeue en herclaim. Het proces-incarnatiecontract, de foutafhandeling en de aangepaste tests beschrijven nu dezelfde semantiek.

## Findings

1. **Minor - Secties 5.4, 7 en 8: leg foutprecedentie voor ontbrekende/verkeerde tokens exact vast.**

   Sectie 5.4 zegt dat een ontbrekend paar `(message_id, claim_token)` in het lokale register `QUEUE_CLAIM_EXPIRED` geeft. De fouttabel en testmatrix zeggen daarentegen dat een ontbrekende of verkeerde token op een claimed bericht `QUEUE_NOT_CLAIMER` geeft. Beide zijn implementeerbaar, maar zonder lookupvolgorde kan dezelfde invoer verschillend worden geclassificeerd.

   **Concreet voorstel:** modelleer het register als `message_id -> claim_token` en specificeer de volgorde: geen lokale entry voor `message_id` betekent `QUEUE_CLAIM_EXPIRED`; lokale entry aanwezig maar token ontbreekt/mismatched betekent `QUEUE_NOT_CLAIMER`; daarna volgt de atomische DB-check met exacte `claimed_by`-vergelijking. Pas de testnamen aan deze matrix aan.

2. **Minor - Secties 5.4 en 6.1: beschrijf pruning van leases die buiten MCP om terminal of gerequeued worden.**

   Terminale afronding en rollback verwijderen de lokale token, maar een CLI-`done`, CLI-`requeue` of andere administratieve statuswijziging kan de rij veranderen zonder langs die paden te gaan. De DB-check blijft correct en voorkomt een ongeldige afronding, maar het proces kan de lease blijven verversen/proberen en de registry-entry tot procesdood vasthouden.

   **Concreet voorstel:** laat de 10-seconden-refresh alleen exact matchende `status='claimed' AND claimed_by=<volledig verwachte waarde>` rijen updaten en verwijder lokale entries waarvoor geen rij is bijgewerkt. Vergelijk `claimed_by` op exacte gelijkheid, niet met substring/`LIKE`. Voeg één test toe voor handmatige requeue gevolgd door een refresh-tick.

## Conclusie

Geen blocker of major resteert voor het proces-incarnatiecontract. De twee minor punten kunnen in het implementatieplan of tijdens implementatie worden vastgelegd zonder nieuwe design-herreview.
