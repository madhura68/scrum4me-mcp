# Herreview ronde 2 — s4m-queue MCP-integratie

**Datum:** 2026-07-12  
**Reviewbasis:** `2e2d423..73967ed`  
**Verdict:** **NO-GO**

De twee blockers uit ronde 1 zijn nu als expliciete contracten verwerkt: het cutover-draaiboek is voldoende stop-the-world en het claim-token maakt afronding transportbestendig. Ook de cleanup-kolomlijsten, `source='mcp'`, CLI/E2E-matrix en correlatietest zijn adequaat verwerkt. De spec heeft echter nog één nieuwe transport/blocker en twee onvolledige contracten in de gekozen afwijkingen.

## Findings

1. **Blocker — §3, §5.3 en §6.1: HTTP-calleridentiteit en presence zijn niet gedefinieerd.** Alle queue-tools worden als `shared` geregistreerd en moeten dus ook via de centrale, stateless HTTP-server werken. De spec leidt het adres echter af uit serverprocess-env (`S4M_SERVER`/`S4M_MODEL`); bij HTTP beschrijft dat de centrale MCP-host, niet de remote caller op bijvoorbeeld `mac:codex`. De bestaande HTTP-entrypoint bindt alleen het Bearer-token/user-id per request en registreert geen `ClaudeWorker` of caller-instance. Daardoor is ook `mcp:<instance_id>:<claim_token>` niet betrouwbaar aan caller-presence te koppelen: een HTTP-claim lijkt óf direct orphaned, óf krijgt ten onrechte de presence van de centrale server. **Voorstel:** kies expliciet één van twee contracten: (a) queue-tools stdio-only maken; of (b) voor HTTP een geauthenticeerde caller-address en caller-instance introduceren, inclusief caller-heartbeat/presence-registratie en autorisatie tegen impersonatie. Voeg een E2E-test toe waarin een remote `mac:codex` via de centrale HTTP-server pusht, claimt en afrondt en de sweep exact die caller-instance controleert.

2. **Major — §6.1 versus §8: de presence-sweep spreekt zichzelf tegen en kan actieve taken dubbel uitvoeren.** §6.1 zegt dat een levende instance na de reclaim-default van vier uur alsnog wordt gerequeued als vangnet voor een gestrande sessie. De testmatrix eist juist dat een worker die langer dan het reclaim-window leeft niet wordt gerequeued. Presence alleen kan een actieve taak niet onderscheiden van een gestrande sessie in hetzelfde levende proces. Daarmee is de gekozen afwijking van lease-extension nog niet houdbaar als contract. **Voorstel:** laat recente presence MCP-claims onbeperkt beschermen en accepteer dat herstel pas na procesdood plaatsvindt, óf voeg een claim-specifieke lease/heartbeat toe. Schrap in beide gevallen de conflicterende regel en test exact het gekozen gedrag. Een vaste vier-uurs-requeue van een aantoonbaar levende worker is niet veilig.

3. **Major — §5.2: idempotente read mist een voortgangs-/selectiecontract voor `message_ids[]`.** Een query die bij elke call eerst de oudste reeds-`done` reply voor dezelfde set teruggeeft, blijft die reply eindeloos herhalen en bereikt een tweede reply in dezelfde set niet. At-least-once maakt duplicaten acceptabel, maar zonder beschreven caller-protocol of cursor is de array-API niet voortgangsgaranderend. **Voorstel:** leg vast dat het resultaat altijd `in_reply_to` bevat en dat de caller na succesvolle ontvangst die request-id uit volgende calls verwijdert; documenteer deterministische selectie. Alternatief: retourneer alle bestaande done-replies voor de set, of accepteer een `seen_reply_ids`/cursor. Voeg een test toe met twee request-ids waarvan beide replies al `done` zijn en bewijs dat beide bereikbaar zijn.

4. **Minor — §7: het cancel-overzicht is te absoluut.** De tabel zegt voor elke MCP-cancel `rollbackClaim`, terwijl §5.2/§5.3 terecht onderscheid maakt: `queue_next` rollbackt, `queue_wait_reply` niet. **Voorstel:** maak de tabel per tool gelijk aan het uitgewerkte contract.

## Beoordeling ronde-1-findings

1. Cutover/rollback: opgelost.
2. Claim-eigenaarschap: opgelost voor stdio en als tokencontract; HTTP-binding valt onder nieuwe finding 1.
3. Cleanup-kolomvolgorde: opgelost.
4. `source`-CHECK en dashboard-impact: opgelost.
5. Auto-ack + idempotente read: richting houdbaar, maar array-voortgang moet nog expliciet worden gemaakt (finding 3).
6. Presence-sweep: nog niet houdbaar door HTTP-presence en de vier-uurs-tegenspraak (findings 1–2).
7. Testmatrix: opgelost, met de aanvullende tests uit findings 1–3.
