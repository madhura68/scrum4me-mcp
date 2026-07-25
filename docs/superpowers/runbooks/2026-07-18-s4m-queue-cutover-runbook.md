# s4m-queue data-cutover — runbook (T-96)

**Doel:** de data van `agent_message` verhuizen van `ops_dashboard` naar de `scrum4me`-DB, en alle consumenten laten overschakelen. Het schema staat er al (T-90); dit runbook verhuist alleen data + connection strings.

**Uitvoering:** interactief, samen met JP. Elke stap die de productie-DB of live env raakt is **HARDSTOP** — niet uitvoeren zonder expliciet "ja" van JP in de chat. Dit is géén agent-taak.

**Waar draaien:** `pg_dump`/`psql` staan **niet** op de mac-PATH; ze draaien op `scrum4me-srv` (waar de tools zijn en de DB lokaal is), door JP of via agent 154 onder JP's toezicht. Bron en doel zijn **twee databases op dezelfde Postgres-server** (`100.118.195.120:5432`) — dump/restore is dus lokaal, geen cross-host-transport.

---

## Vastgestelde feiten (2026-07-18)

| | |
|---|---|
| Bron | `ops_dashboard.agent_message` — **92 rijen** (3 claimed, 41 replies), nieuwste 2026-07-17 22:00. Volume is klein; het venster is seconden. |
| Doel | `scrum4me.agent_message` — **leeg (0 rijen)**, schema van T-90 (kolommen byte-identiek aan de bron; CHECK-namen/FK-`ON UPDATE`/indexnaam wijken cosmetisch af — irrelevant voor een `--data-only`-restore). |
| Archief | `agent_message_archive` bestaat **alleen op het doel** (leeg). De bron heeft hem nooit gehad — niet dumpen. |
| Self-FK | `agent_message_in_reply_to_fkey` in beide, **niet-deferrable** → COPY kan een reply vóór zijn parent invoegen → moet vóór de restore gedropt en erna hervalideerd worden. |
| Schrijvers (te stoppen) | (1) de agents (claude/codex op mac/scrum4me-srv/max2) — queue-gebruik pauzeren; (2) **scrum4me-workers `/queue/messages`** — de enige UI-schrijver, via `OPS_DATABASE_URL`. |
| GEEN schrijvers meer | Ops-dashboard (Messages-feature verwijderd, ST-035). Cleanup-timer bestaat niet op scrum4me-srv. |

---

## Preconditie-checks (verifiëren, alles is al gedaan)

- [ ] Doeltabellen bestaan leeg op prod: `SELECT count(*) FROM agent_message` én `agent_message_archive` op de scrum4me-DB → beide 0. (T-90)
- [ ] Ops-dashboard schrijft niet meer: `model AgentMessage` staat nog in het Ops-schema (drift-bescherming) maar `app/messages/` + de routes zijn weg. (ST-035, PR #113 gemerged)
- [ ] scrum4me-workers heeft purge-pariteit + is de enige UI. (PR #67 gemerged)

---

## Het venster

- [ ] **HARDSTOP** — JP geeft akkoord om het venster te openen en kondigt de pauze aan bij alle agents (mac, scrum4me-srv, max2 × claude, codex). Vanaf hier geen queue-gebruik.

- [ ] **Writers stoppen.** Zet het scrum4me-workers-schrijfpad stil (de service/het proces dat `OPS_DATABASE_URL` gebruikt), of spreek af dat `/queue/messages` niet gebruikt wordt tijdens het venster. Exacte unit/procesnaam ter plekke op scrum4me-srv verifiëren.

- [ ] **Wachten tot geen nieuwe claims.** De 3 `claimed`-rijen mogen mee verhuizen (de claimende agent maakt ze ná de env-omhang af op de nieuwe DB). Het punt is dat er geen NIEUWE writes bijkomen tussen dump en env-omhang. Verifieer met `s4m-queue list` dat het rijtal stabiel is.

- [ ] **Watermark vastleggen (bron).** Op `ops_dashboard`:
  ```sql
  SELECT status, type, count(*) FROM agent_message GROUP BY status, type ORDER BY 1,2;
  SELECT count(*) AS n, max(created_at) AS max_created FROM agent_message;
  ```
  Bewaar de output — dit is de validatiereferentie.

- [ ] **Dump (bron, data-only, alleen agent_message).** Op scrum4me-srv, lokaal:
  ```bash
  pg_dump "$OPS_DASHBOARD_URL" --data-only --no-owner --no-privileges \
    --table=public.agent_message -f ~/s4m-cutover/agent_message-data.sql
  grep -c '^COPY' ~/s4m-cutover/agent_message-data.sql   # verwacht: 1
  ```
  (Archief NIET dumpen — bestaat niet op de bron.)

- [ ] **HARDSTOP** — JP geeft akkoord voor de restore op de prod-scrum4me-DB. In één transactie; self-FK tijdelijk weg omdat COPY per rij valideert:
  ```bash
  psql "$SCRUM4ME_DIRECT_URL" -v ON_ERROR_STOP=1 <<'SQL'
  BEGIN;
  ALTER TABLE public.agent_message DROP CONSTRAINT agent_message_in_reply_to_fkey;
  \i /home/janpeter/s4m-cutover/agent_message-data.sql
  ALTER TABLE public.agent_message ADD CONSTRAINT agent_message_in_reply_to_fkey
    FOREIGN KEY (in_reply_to) REFERENCES public.agent_message(id) ON DELETE SET NULL;
  COMMIT;
  SQL
  ```
  (`ON UPDATE` bewust weggelaten — het doel-schema heeft `NO ACTION`, Prisma-default; uuid-PK's muteren toch nooit. Geen sequences: uuid-PK.)

- [ ] **Validatie 1 — rijtelling.** Op de scrum4me-DB dezelfde watermark-query; diff met de bron-output → moet gelijk zijn (zelfde totaal, zelfde verdeling per status/type). Elke afwijking = een writer schreef tussendoor → onderzoeken vóór verdergaan.

- [ ] **Validatie 2 — FK hervalideerd.** De `ADD CONSTRAINT` hierboven valideert alle 41 replies; als hij zonder fout committe, is de thread-integriteit intact. Extra check: `SELECT count(*) FROM agent_message c WHERE in_reply_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_message p WHERE p.id=c.in_reply_to)` → 0.

- [ ] **Connection strings omhangen** — allemaal naar de scrum4me-DB, **direct endpoint** (geen pooler — CLI `--wait` en dashboard-SSE gebruiken LISTEN/NOTIFY):
  1. `S4M_QUEUE_URL` op mac (`~/.zshenv`), scrum4me-srv (`~/.config/s4m-queue.env`), max2 (ter plekke verifiëren welk env-bestand).
  2. `OPS_DATABASE_URL` in de scrum4me-workers-deployment-env op scrum4me-srv.
  3. `S4M_QUEUE_MAINTENANCE_URL` (cleanup-bin) → scrum4me-DB, **bestaande app-rol** (besluit JP 2026-07-18; geen nieuwe DB-rol, geen prod-rolwijziging).
  Waarden nooit printen.

- [ ] **Canary-roundtrip** tegen de nieuwe DB (verse shell, `~/.zshenv` herladen):
  ```bash
  s4m-queue push --to mac:claude --as jp --type info --body "cutover-canary $(date +%F)"   # noteer id
  s4m-queue next --as claude --json     # claimt de canary
  s4m-queue done <id> --reply "canary ok"
  s4m-queue status <id>                 # done + reply gekoppeld
  s4m-queue inbox --as jp --json        # de data-reply
  s4m-queue done <reply-id>             # ack
  ```
  Plus: open `/queue/messages` in scrum4me-workers en verifieer dat de canary live verschijnt (SSE tegen de nieuwe DB).

- [ ] **Consumers herstarten** (pas ná geslaagde canary): scrum4me-workers-service weer aan. JP geeft de agents het sein dat de queue open is.

---

## Rollback

- **Verliesvrij** kan alléén zolang de writers nog **niet** herstart zijn: connection strings terugzetten naar `ops_dashboard` (oude waarden vooraf bewaren in `~/s4m-cutover/old-env-*.txt`). Alleen de canary-rijen bestaan dan al op het doel — die mogen verloren.
- **Ná herstart** ontstaan rijen uitsluitend op de scrum4me-DB → roll-forward, geen reverse-delta (niet proportioneel voor dit volume).

## Ná de cutover (aparte acties, niet in dit venster)

- Oude `ops_dashboard.agent_message` blijft **onaangeroerd** als vangnet. Opruimen (tabel droppen + `model AgentMessage` uit het Ops-schema mét drop-migratie) is een aparte taak na ≥1 week stabiel draaien.
- Idem: `agent_message` + `agent_message_archive` in de scrum4me-DB zijn dan de enige bron, klaar voor fase 2 (de MCP-tools).
