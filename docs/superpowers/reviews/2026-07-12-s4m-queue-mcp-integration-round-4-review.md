# Herreview ronde 4 — s4m-queue MCP-integratie

**Datum:** 2026-07-12  
**Reviewbasis:** `764f0d7..1de2929`  
**Verdict:** **NO-GO**

De procesgebonden lease sluit de blocker uit ronde 3 voor het directe crash/herstart-scenario met een stabiele `instance_id`: proces B kan de in-memory tokens van proces A niet verversen. De gekozen oplossing introduceert echter een conflict met het bestaande procesoverschrijdende eigenaarscontract.

## Findings

1. **Blocker — §5.3 en §6.1: een geldige cross-process hervatting verliest leasebescherming.** §5.3 staat expliciet toe dat een client na een MCP-procesherstart met het door proces A uitgegeven `claim_token` via proces B afrondt. §6.1 laat uitsluitend het proces dat het token uitgaf `claimed_at` verversen. Proces B kent het token niet in zijn in-memory register en er is geen resume/adopt/renew-operatie vóór `queue_done`/`queue_fail`. Als de client na de transport-/MCP-restart legitiem verderwerkt en de taak langer dan circa vijf minuten duurt, kan de sweep de nog actieve claim requeueën en een tweede consument dezelfde taak laten uitvoeren. Daarmee botst de nieuwe lease met zowel “transportbestendig” als de beoogde bescherming tegen dubbele uitvoering. **Voorstel:** kies en specificeer één coherent contract: (a) voeg een expliciete `queue_resume`/`queue_renew(message_id, claim_token)` toe die atomair controleert dat status=`claimed` en `claimed_by` exact het token bevat, de token in het lokale lease-register van proces B adopteert en `claimed_at` ververst; laat de client dit direct na reconnect en periodiek vóór de drempel doen, met integratietest A-claim → A sterft → B adopteert → geen requeue → B rondt af; of (b) schrap cross-process voortzetting en stel dat een procesrestart de claim laat verlopen, waarna werk alleen na requeue opnieuw mag starten. Alleen tokenvalidatie bij de terminale `queue_done`/`queue_fail` is te laat om de lease tijdens langdurig hervat werk te beschermen.

## Beoordeling ronde-3-blocker

1. Stabiele `instance_id` beschermt de claim van een dode voorganger niet langer: opgelost voor niet-hervatte claims.
2. Procesoverschrijdend hervatte claims blijven veilig gedurende actief werk: niet opgelost; nieuwe blocker hierboven.
