# Herreview ronde 3 — s4m-queue MCP-integratie

**Datum:** 2026-07-12  
**Reviewbasis:** `73967ed..764f0d7`  
**Verdict:** **NO-GO**

De vier findings uit ronde 2 zijn inhoudelijk verwerkt. De queue-tools zijn nu consequent stdio-only en de E2E-matrix bewaakt dat het HTTP-entrypoint ze niet exposeert. Het voortgangscontract van `queue_wait_reply` retourneert alle beschikbare replies met `in_reply_to`, en het cancel-overzicht is per tool gelijkgetrokken. Ook is de onveilige vier-uurs-requeue van aantoonbaar levende workers geschrapt.

Er resteert echter één blocker in het presence-contract: de spec veronderstelt een proces-incarnatie-id die de bestaande bootstrap niet garandeert.

## Findings

1. **Blocker — §5.3 en §6.1: `instance_id` is niet gegarandeerd uniek per proces-incarnatie, waardoor herstel na procesdood kan uitblijven.** De spec stelt in §5.3 dat na een sessieherstart een nieuw stdio-proces met een nieuwe `instance_id` draait. De huidige bootstrap doet dat alleen wanneer geen instance-env is gezet: `src/index.ts` prefereert `SCRUM4ME_WORKER_INSTANCE_ID`, en `getInstanceId()` prefereert vervolgens `SCRUM4ME_INSTANCE_ID`; met name worker/container-configuraties gebruiken zo'n stabiele host-/worker-id. Als proces A sterft en proces B snel met dezelfde instance-id start vóór de sweep, ziet §6.1 opnieuw levende presence en beschermt B de claim van A onbeperkt. B heeft het oude claim-token niet, dus automatisch afronden kan evenmin; alleen handmatige requeue blijft over. Daarnaast is `ClaudeWorker` uniek op `(user_id, token_id, instance_id)`, terwijl `claimed_by = mcp:<instance_id>:<claim_token>` alleen `instance_id` vastlegt, zodat de spec ook niet benoemt hoe eventuele instance-id-collisies tussen tokens worden uitgesloten. **Voorstel:** introduceer voor queue-presence een expliciete, willekeurige process-incarnation-id (boot nonce/UUID) die bij iedere stdio-processtart nieuw is en exact in zowel de presence-record als `claimed_by` staat; encodeer tevens een ondubbelzinnige worker/token-sleutel, of verwijs vanuit `claimed_by` naar een unieke worker-incarnatierecord. Laat de sweep op die volledige identiteit matchen. Voeg een integratietest toe: proces A claimt, sterft, proces B start onmiddellijk met dezelfde stabiele host/worker-config; A's claim moet na de drempel worden gerequeued ondanks levende presence van B. Test ook dat een werkelijk nog levende incarnatie onbeperkt beschermd blijft.

## Beoordeling ronde-2-findings

1. Stdio-only versus HTTP-identiteit/presence: opgelost.
2. Levende presence versus tijdgebonden requeue: tekstueel opgelost; proces-incarnatie-identiteit valt onder de nieuwe finding.
3. Voortgang bij meerdere `message_ids`: opgelost.
4. Cancel-contract per tool: opgelost.

