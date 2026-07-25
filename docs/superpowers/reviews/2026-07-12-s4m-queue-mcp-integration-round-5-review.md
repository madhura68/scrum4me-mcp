# Herreview s4m-queue MCP-integratie — ronde 5

**Uitkomst: NO-GO**

Beoordeeld: `docs/superpowers/specs/2026-07-12-s4m-queue-mcp-integration-design.md` op commit `4366d43`, diff `1de2929..4366d43`.

## Findings

1. **Blocker — §§5.3–5.5, 6.1, 8: procesgebonden eigenaarschap wordt niet afgedwongen en de testmatrix verwacht nog het tegengestelde.**

   Het nieuwe contract zegt dat claim en token aan de proces-incarnatie zijn gebonden en dat een opvolgerproces de claim niet mag hervatten. De beschreven claimer-check valideert op een nog `claimed` bericht echter alleen het aangeleverde token tegen `claimed_by`. Een nieuw proces dat het token van proces A ontvangt, kan daardoor vóór het verstrijken en sweepen van de circa vijf minuten oude lease nog steeds succesvol `queue_done`/`queue_fail` uitvoeren. Dat is precies cross-process-voortzetting. §8 bevestigt de tegenspraak bovendien expliciet met de nog aanwezige verwachting: “proces A claimt, proces B rondt met A's token succesvol af”. De nieuwe verlopen-claim-test dekt alleen het tijdstip ná requeue en sluit dit venster dus niet.

   **Voorstel:** maak de proces-incarnatie onderdeel van de afrondingsautorisatie. De eenvoudigste aansluiting op het gekozen ontwerp is dat `queue_done`/`queue_fail` naast de atomische DB-status/token-check vereisen dat `(message_id, claim_token)` in het lokale in-memory tokenregister van het huidige proces staat. Ontbreekt die lokale lease, wijs ook een nog `claimed` rij af met `QUEUE_CLAIM_EXPIRED` (of introduceer een eenduidige typed error voor een vreemde proces-incarnatie). Verwijder het token uit het register na terminale afronding of rollback. Pas §7 aan en vervang de cross-process-test door: B met A's token wordt vóór én ná lease-expiry afgewezen; A met lokaal geregistreerd token slaagt; verkeerde/ontbrekende tokens en CLI-claims blijven `QUEUE_NOT_CLAIMER`.

## Conclusie

De oplossing voorkomt zombie-afronding nadat de sweep de claim al heeft gerequeued of opnieuw uitgegeven, maar niet gedurende het leasevenster vóór die sweep. Daardoor is het centrale ronde-5-contract nog niet sluitend.
