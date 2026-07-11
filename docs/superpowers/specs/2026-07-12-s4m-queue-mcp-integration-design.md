# s4m-queue onderbrengen in de scrum4me MCP — design

**Datum:** 2026-07-12
**Status:** goedgekeurd design (brainstorm-fase); implementatieplan volgt apart
**Betrokken repo's:** scrum4me-shared (schema), scrum4me-mcp (tools), s4m-queue (CLI, env), scrum4me-workers (Messages-dashboard, env), Ops-dashboard (legacy-tabellen)

## 1. Probleem

De s4m-queue is een Postgres-berichtenqueue tussen agents op drie hosts (`mac`, `scrum4me-server`, `max2`) en drie participants (`claude`, `codex`, `jp`), bediend via een losse CLI. Twee structurele problemen:

1. **Mis-routing van replies.** Adressering is uitsluitend `(host, model)`. `inbox --as claude` claimt de *oudste* pending reply voor dat adres, zonder koppeling aan welke sessie het bijbehorende request stuurde. Draaien twee Claude Code-sessies op één host tegelijk een review-aanvraag, dan kan sessie A het antwoord van sessie B destructief claimen (en ack'en) — sessie B's `inbox --wait` blijft dan leeg hangen. `in_reply_to` bestaat al op elke reply (zelfs in de pg_notify-payload) maar wordt níet in de claim-query gebruikt.
2. **Frictie in gebruik.** Env-sourcing in niet-interactieve shells, verplichte `--as`-vlag, handmatig `meta.task` opbouwen, handmatig `list --stale` + `requeue` voor vastzittende claims.

## 2. Genomen beslissingen (brainstorm)

| Vraag | Beslissing |
|---|---|
| Scope | MCP-tools **naast** de CLI, op dezelfde tabellen. Claude én codex gebruiken de MCP; de CLI blijft voor jp (mens) en als fallback. |
| Reply-routing | **Request-handle**: `queue_push` geeft een `message_id` terug; `queue_wait_reply(message_ids)` claimt uitsluitend replies met `in_reply_to` in die set (Selective Consumer / Correlation Identifier, EIP). Geen sessie-scoped identiteiten. |
| DB-locatie | **Migreren naar de scrum4me-DB**: `agent_message` + `agent_message_archive` verhuizen uit `ops_dashboard` naar het canonical Prisma-schema (scrum4me-shared). |
| Tool-surface | **Kernset + gemak** (7 tools); admin (`requeue`, `cancel`, volledige `list`-varianten, cleanup) blijft CLI. |
| Aanpak | **A — gefaseerde verhuizing**: (1) schema & data, (2) MCP-kernset op Prisma, (3) hardening. Elke fase apart deploybaar met rollback-punt. |

Verworpen alternatieven:
- *Correlatie-fix eerst, migratie later* — dubbel werk (tools eerst raw-SQL op een tweede verbinding, daarna ombouwen naar Prisma) en een tussentoestand met twee databases.
- *Queue opgaan laten in `claude_jobs`* — berichten ≠ jobs (info-vragen aan jp, reviews zonder repo-context); zou de CLI voor jp en het Messages-dashboard breken.

## 3. Doelarchitectuur

Drie consumenten op dezelfde tabellen in de **scrum4me-DB**:

| Consument | Toegang | Wijziging |
|---|---|---|
| scrum4me-mcp (claude + codex) | Prisma + LISTEN op bestaande `DATABASE_URL` | nieuw: 7 queue-tools |
| s4m-queue CLI (jp + fallback) | raw SQL, code ongewijzigd | alleen `S4M_QUEUE_URL` → scrum4me-DB |
| Messages-dashboard (scrum4me-workers) | bestaande `agent_queue`-listener | alleen connection string |

Het NOTIFY-kanaal `agent_queue` verhuist automatisch mee (NOTIFY is per-database). De MCP-server heeft géén tweede pg-verbinding nodig. De NotifyEnvelope-payload (`{id, type, from_server, from_model, to_server, to_model, in_reply_to, status, previous_status}`) blijft byte-compatibel zodat CLI `--wait` en het dashboard ongewijzigd blijven werken.

**Identiteit.** Adres = `(S4M_SERVER, model)`. De MCP leest beide uit env: `S4M_SERVER` (bestaat al per host) en nieuw **`S4M_MODEL`** in het `mcpServers`-config-blok (Claude-config: `claude`; codex-config: `codex`). Optionele `as`-parameter per call als override. Ontbreekt identiteit → `QUEUE_IDENTITY_REQUIRED`.

## 4. Fase 1 — Schema & data-migratie

1. **Prisma-modellen** `AgentMessage` / `AgentMessageArchive` in scrum4me-shared met `@@map("agent_message")` / `@@map("agent_message_archive")` en `@map` per kolom: tabel- en kolomnamen **byte-identiek** aan `s4m-queue/migrations/001_init.sql` + `002_archive.sql`. Check-constraints (`reply_link_matches_type`, type/status-CHECKs) en `agent_message_claim_idx (to_server, to_model, status, created_at)` gaan mee in de SQL-migratie.
2. **Nieuwe index** op `in_reply_to` — nodig voor de reply-claim-filter (fase 2); maakt ook het bestaande `status <id>` sneller.
3. **Data-cutover** (queue-volume is laag; kort en atomair):
   - Freeze: verifieer met `s4m-queue list` dat niets pending/claimed openstaat; agents pauzeren queue-gebruik.
   - Kopieer alle rijen (werk- + archieftabel) van `ops_dashboard` → scrum4me-DB (uuid-PK's, geen sequences).
   - Env omhangen op 3 hosts: `~/.zshenv` (mac), `~/.config/s4m-queue.env` (scrum4me-server), max2-equivalent; plus dashboard-config in scrum4me-workers.
   - Verificatie: `s4m-queue list`/`status` tegen de nieuwe DB; dashboard toont berichten.
   - Rollback-pad: oude tabellen hernoemen naar `agent_message_legacy` in `ops_dashboard`; opruimen na een week stabiel draaien.
4. **Volgorde-regel:** schema-migratie deployt vóór alle code die hem gebruikt (zelfde principe als de `sprint_sequence`-rollout). Productie-DB-wijzigingen uitsluitend na expliciet akkoord van JP.

## 5. Fase 2 — MCP-kernset (7 tools)

Alle tools in de **shared**-groep (puur DB; de repo-autofill in `queue_push` is een best-effort extraatje dat alleen in stdio-mode actief is), bestand-per-tool in `src/tools/queue-*.ts`, geregistreerd in `src/register.ts`, handlers in `withToolErrors()` met `toolJson()`/`toolError()`.

### 5.1 `queue_push` `{to, type, body, meta?, cwd?, as?}`
Insert + NOTIFY (na commit, best-effort). Retourneert `{message_id, to, type}` plus de hint *"haal het antwoord op met queue_wait_reply(message_id)"*.
Gemak: bij `task`/`review_request` levert de agent alleen `cwd` + inhoudelijke velden (`objective`, `verification`, `response_format`); de tool leidt `repo` best-effort af via `git remote get-url origin` in die cwd (alleen stdio-mode; lukt het niet of draait de server in HTTP-mode, dan is expliciete `meta.repo` verplicht → `VALIDATION_ERROR` met die uitleg). Zelfde meta-validatie als CLI (`validateTaskMeta`).

### 5.2 `queue_wait_reply` `{message_ids: string[], wait_seconds?: 0–600 (default 300)}` — de mis-routing-fix
Claim-query met het correlatie-filter **ín de WHERE-clause**:

```sql
SELECT id FROM agent_message
WHERE to_server = $self AND to_model = $model
  AND type = ANY('{result,data,reviewed}')
  AND in_reply_to = ANY($message_ids)
  AND (status = 'pending' OR (status = 'claimed' AND claimed_at < now() - $reclaim))
ORDER BY created_at, id
FOR UPDATE SKIP LOCKED LIMIT 1
```

Een sessie kan per constructie alleen antwoorden op háár eigen requests claimen. Flow: directe claim-poging → anders `LISTEN agent_queue`, alleen reageren op payloads waarvan `in_reply_to` in `message_ids` zit → poll-vangnet elke 5 s → deadline. **Auto-ack:** de geclaimde reply gaat in dezelfde transactie naar `done` (lezen = verwerkt; de rij met body blijft bestaan voor audit/`queue_status`). Timeout → `{status: 'timeout', reply: null}` — géén error; de agent roept opnieuw aan.

Twee gebruiksmodi (een MCP-tool-call is synchroon; er bestaat geen push naar het model):
- **Blokkerend:** `wait_seconds: 300` — sessie wacht in de call (zoals `wait_for_job`).
- **Niet-blokkerend:** `wait_seconds: 0` — direct claimen of direct timeout; sessie werkt door en checkt op natuurlijke momenten.

Buiten MCP om blijft een echt "seintje" mogelijk via `s4m-queue inbox --wait` als background-Bash-taak (gedocumenteerd patroon in de rules-file, geen tool).

### 5.3 `queue_next` `{wait_seconds?: 0–600 (default 0)}`
Claim het volgende request (`task`/`info`/`review_request`) voor het eigen adres, FIFO, zelfde bounded-wait-mechaniek (zonder `in_reply_to`-filter — competing consumers is hier gewénst gedrag). Response = bericht + meta + instructie ("voer uit binnen `meta.task.cwd`; ontbreekt vereiste context → `queue_fail`, niet raden").

### 5.4 `queue_done` `{message_id, reply?}`
Mét `reply`: transactioneel reply-rij (type volgens `REPLY_TYPE`-mapping, `in_reply_to` = request-id, from/to gespiegeld) + request → `done` + beide NOTIFYs — zoals CLI `doneWithReply`. Zónder `reply`: ack op een geclaimd request/bericht.
**Validaties** (strenger dan de CLI): bericht bestaat (`QUEUE_NOT_FOUND`); status niet terminal (`QUEUE_ALREADY_TERMINAL`, atomair). Claimer-check: op een `claimed` bericht mag alleen de claimende instance done/fail doen (`QUEUE_NOT_CLAIMER`); op een `pending` request blijft `queue_done` mét reply toegestaan (de bestaande FIFO-bypass — per id antwoorden zonder eerst te claimen, zoals CLI `done <id> --reply`).

### 5.5 `queue_fail` `{message_id, error}`
Status → `failed` + error-tekst; zelfde validaties als `queue_done`.

### 5.6 `queue_status` `{message_id}`
Read-only, niet-claimend: het bericht + alle replies (`WHERE in_reply_to = $id`). Voor "is er al antwoord?" zonder mutatie.

### 5.7 `queue_list` `{direction?: 'sent'|'received'|'both' (default 'both'), include_terminal?: boolean (default false)}`
Read-only, niet-claimend: alle berichten waar het eigen adres afzender óf geadresseerde is en die niet done/failed/cancelled zijn — uitstaande eigen requests én wat er klaarstaat.
**Verloren-handle-herstel:** crasht een sessie na `queue_push`, dan vindt een nieuwe sessie via `queue_list(direction:'sent')` de uitstaande request-ids terug en doet er gewoon `queue_wait_reply` op — niets raakt wees.

### LISTEN-mechaniek (alle wait-tools)
Conform de consensus uit pg-boss / Graphile Worker / River / Oban:
- NOTIFY is **uitsluitend wake-up**; de claim-query is de enige bron van waarheid (payload nooit vertrouwen — kan wegvallen of dubbel aankomen).
- Dedicated `pg.Client` per wait-call op `DATABASE_URL`, `finally { end() }` (patroon uit `wait_for_job`, `src/tools/wait-for-job.ts`).
- Eén directe claim-poging bij (her)opzetten van LISTEN — dicht het disconnect-gat.
- Poll-vangnet (5 s) naast LISTEN: een gemiste NOTIFY kost hooguit latency, nooit een hangende agent.
- MCP-cancel tijdens wait → `rollbackClaim`: net-geclaimd bericht idempotent terug naar `pending`.
- Bounded waits: `wait_seconds` max 600, agent her-callt. Geen onbegrensd blokkeren (client-timeouts zijn leidend; progress-notificaties verlengen die aantoonbaar niet).

## 6. Fase 3 — Hardening

1. **Automatische stale-sweep** (vervangt handmatig `list --stale` + `requeue`): in de bestaande MCP-heartbeat-loop een sweep op gerandomiseerd interval (8–10 min, Graphile-patroon): `claimed`-rijen ouder dan de reclaim-default → `pending` + NOTIFY. Idempotent — drie hosts mogen tegelijk sweepen, geen leader-election. Reclaim-default blijft 4 h als vangnet.
2. **Dubbele-uitvoering-bescherming** (Oban Lifeline-caveat): reclaim kán dubbele uitvoering betekenen; `queue_done`/`queue_fail` weigeren atomair op terminal-status — van twee racende afronders wint er precies één.
3. **CLI-pariteit, minimaal:** CLI krijgt alleen `inbox --in-reply-to <id,...>` zodat ook CLI-gebruik correlatie-veilig kán. Verder blijft de CLI ongemoeid (jp's flow mag niet breken); cleanup-bins werken ongewijzigd.
4. **Rules-file:** `~/.claude/rules/s4m-queue.md` herschrijven — triggers wijzen eerst naar MCP-tools, CLI als fallback; background-Bash-patroon gedocumenteerd; `queue_list` als herstel-stap na sessie-crash.

## 7. Error handling

| Situatie | Gedrag |
|---|---|
| `S4M_SERVER`/`S4M_MODEL` ontbreekt | `QUEUE_IDENTITY_REQUIRED` |
| Onbekend `message_id` | `QUEUE_NOT_FOUND` |
| Done/fail op terminal bericht | `QUEUE_ALREADY_TERMINAL` (atomair afgewezen) |
| Done/fail door niet-claimer | `QUEUE_NOT_CLAIMER` |
| Meta-validatie faalt | `VALIDATION_ERROR` (zod / `validateTaskMeta`) |
| Timeout op wait | géén error: `{status:'timeout'}` |
| MCP-cancel tijdens wait | `rollbackClaim`, bericht nooit zoek |
| NOTIFY faalt | best-effort, nooit tool-falen (bestaande conventie) |

Typed-error-vorm volgt de repo-conventie: string-prefix in `toolError('CODE: message')`, mapping in `withToolErrors`.

## 8. Testen

- **Unit-tests** per tool volgens bestaand patroon (`__tests__/queue-*.test.ts`): `vi.mock` van prisma/auth, fake `McpServer` die de handler capture't.
- **Correlatie-race-integratietest** (de kern): twee gesimuleerde sessies pushen elk een request; replies arriveren in omgekeerde volgorde; élke `queue_wait_reply` krijgt aantoonbaar het antwoord op zijn éigen request. Plus: derde sessie zonder filter (CLI-semantiek) blijft werken.
- **Claim-atomiciteit:** parallelle `queue_wait_reply`-calls op overlappende `message_ids` — `FOR UPDATE SKIP LOCKED` garandeert exact één winnaar.
- **CLI-compatibiliteit:** de bestaande s4m-queue-testsuite draait tegen de scrum4me-test-DB als bewijs dat de migratie byte-compatibel is.
- **Sweep-idempotentie:** twee gelijktijdige sweeps requeuen samen precies één keer.

## 9. Buiten scope

- Sessie-scoped identiteiten / reply-adressen (request-handle gekozen; heroverwegen alleen als het handle-model in de praktijk tekortschiet).
- MCP Tasks (experimenteel in spec 2025-11-25): het datamodel mapt er al bijna 1-op-1 op (pending/claimed/done/failed ≈ working/completed/failed/cancelled); overstap kan later zonder schemawijziging zodra clients het ondersteunen.
- Streamable-HTTP-push (pg_notify → SSE) voor echte "bericht klaar"-signalen: overkill op deze schaal.
- Admin-tools als MCP (`requeue`, `cancel`, volledige `list`): blijft CLI.
- Verwijderen van de `ops_dashboard`-legacy-tabellen: aparte opruimactie na een week stabiel draaien.

## 10. Researchbronnen (samengevat)

- **EIP Correlation Identifier / Return Address / Selective Consumer** — filteren hoort ín de claim, nooit claim-dan-weggooien (claims zijn destructief).
- **RabbitMQ Direct Reply-to / NATS `_INBOX.*`** — per-request adres als correlatiesleutel; maar replies moeten hier durable blijven (sessies zijn vluchtig, replies komen uren later) — dus rijen + filter, geen ephemere routering.
- **JMS shared-reply-queue-valkuil** — competing consumers zonder selector = wrong-consumer-pickup is verwacht gedrag, geen edge case. Bevestigt de diagnose.
- **pg-boss / Graphile Worker / River / Oban** — NOTIFY als wake-up-only, `FOR UPDATE SKIP LOCKED`, poll-vangnet, reconnect-poll, gerandomiseerde idempotente sweeps, degradatie naar polling.
- **pgmq** — `read_with_poll` als server-side long-poll-recept; visibility-timeout-verlenging.
- **Postal MCP** — bewijst de blokkerende inbox-tool, en dat modelgedrag ("keert niet vanzelf terug naar de mailbox") de zwakke plek is → rules-file-triggers zijn onderdeel van het ontwerp.
- **MCP spec 2025-11-25** — bounded waits verplicht (client-timeouts leidend), cancellation-race gracieus afhandelen, Tasks als toekomstpad.
