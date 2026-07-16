# s4m-queue Fase 1 — Schema & Data-cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fase 1 van de s4m-queue-in-scrum4me-MCP-migratie: cleanup-fix (expliciete kolomlijsten) in s4m-queue, `AgentMessage`/`AgentMessageArchive` in het canonical Prisma-schema met SQL-migratie (source-CHECK + `'mcp'`, extra `in_reply_to`-index), en een stop-the-world data-cutover van de `ops_dashboard`-DB naar de scrum4me-DB — oude tabellen blijven onaangeroerd.

**Architecture:** Het canonical schema leeft in `~/Development/scrum4me-shared/prisma/schema.prisma` (repo `git.jp-visser.nl/janpeter/scrum4me-shared`, door Scrum4Me/scrum4me-workers/scrum4me-mcp geconsumeerd als submodule `vendor/scrum4me-shared` + `gen-consumer-schema.sh`). Migraties draaien uitsluitend in **Scrum4Me** (designated migrator — zie het `JobKindConfig`-precedent in het schema): handgeschreven `prisma/migrations/<timestamp>_<naam>/migration.sql`, prod-apply via `prisma migrate deploy` (prisma.config.ts, `DIRECT_URL` uit `.env.local`). De CLI (raw SQL) en het Messages-dashboard (raw `pg.Pool`) verhuizen alleen van connection string; omdat er geen cross-DB-transactie bestaat is de cutover een dump/restore met watermark- en `information_schema`-validatie.

**Tech Stack:** TypeScript (Node ≥24, ESM, `.js`-imports) + `pg` + vitest (s4m-queue); Prisma 7-schema + handgeschreven SQL-migratie (scrum4me-shared → Scrum4Me); `pg_dump`/`psql` voor de cutover; systemd (cleanup-timer op scrum4me-server).

**Afhankelijkheid fase 2 (expliciet NIET in dit plan):** de vendor-bump + `scripts/gen-schema.sh`-regen in scrum4me-mcp (waarvan `prisma/schema.prisma` AUTO-GENERATED is) hoort bij fase 2 en vereist alleen dat Task 2+3 gemerged zijn.

**Vaste teamregel:** elke stap die de productie-DB wijzigt is gemarkeerd met **HARDSTOP: expliciet akkoord JP vereist** — niet uitvoeren zonder dat akkoord in de chat.

---

## Context: paden & flows (onderzocht)

| Wat | Waar |
|---|---|
| Canonical schema | `/Users/janpetervisser/Development/scrum4me-shared/prisma/schema.prisma` (1210 regels; nieuwe modellen appenden ná `model JobKindConfig`, `@@map("job_kind_config")` op regel 1209) |
| Migratie-flow | scrum4me-shared heeft **géén** migrations-dir. Flow: schema editen in scrum4me-shared → commit/push → in `~/Development/Scrum4Me`: submodule-bump, `bash scripts/gen-schema.sh` (herschrijft `prisma/schema.prisma`), migratie-map handmatig aanmaken onder `prisma/migrations/` (precedent voor handgeschreven SQL met CHECKs: `20260527110000_relax_claude_jobs_constraint_for_sprint`) → prod: `prisma migrate deploy` via temp-worktree op `origin/main` (memory `scrum4me-prod-migratie-deploy`) |
| Bron-DDL | `/Users/janpetervisser/Development/s4m-queue/migrations/001_init.sql` + `002_archive.sql` |
| Cleanup-bug | `/Users/janpetervisser/Development/s4m-queue/src/cleanup.ts` regels 59–64: `INSERT INTO agent_message_archive SELECT * …` (positioneel) |
| s4m-queue testconventie | vitest + echte Postgres via `S4M_TEST_DATABASE_URL` (staat in `/Users/janpetervisser/Development/s4m-queue/.env`, geladen door `test/setup.ts`); `test/helpers/db.ts` maakt per testrun een schema `s4m_test_<hex>` en draait 001+002 |
| Dashboard-config | `~/Development/scrum4me-workers/lib/queue/ops-db.ts` regel 19: `process.env.OPS_DATABASE_URL` (lokaal `.env`; niet in `.env.example`) |
| Cleanup-bin prod | scrum4me-server systemd: `s4m-queue-cleanup.timer` (dagelijks 03:00) → `s4m-queue-cleanup.service`, `EnvironmentFile=/etc/s4m-queue/cleanup.env` (`S4M_QUEUE_MAINTENANCE_URL`), bin `/usr/bin/s4m-queue-cleanup` via `sudo npm i -g .` |
| Host-env queue-CLI | mac: `~/.zshenv`; scrum4me-server: `~/.config/s4m-queue.env`; max2: equivalent (ter plekke verifiëren) |
| Prod scrum4me-DB | Neon; `DIRECT_URL` in `~/Development/Scrum4Me/.env.local` (waarde nooit printen). **Let op:** `prisma.config.ts` pakt `DIRECT_URL || DATABASE_URL` — draai in Scrum4Me dus nooit `prisma migrate dev` "zomaar lokaal" |

---

### Task 1: s4m-queue cleanup — expliciete kolomlijsten + archiveringstest

**Files:**
- Modify: `/Users/janpetervisser/Development/s4m-queue/src/cleanup.ts` (regels 59–64; doc-comment regels 15–21)
- Test (Create): `/Users/janpetervisser/Development/s4m-queue/test/cleanup-columns.test.ts`

- [ ] **Branch aanmaken**
  ```bash
  git -C /Users/janpetervisser/Development/s4m-queue checkout main
  git -C /Users/janpetervisser/Development/s4m-queue pull
  git -C /Users/janpetervisser/Development/s4m-queue checkout -b feat/cleanup-explicit-columns
  ```

- [ ] **Failing test schrijven** — nieuw bestand `/Users/janpetervisser/Development/s4m-queue/test/cleanup-columns.test.ts` met exact deze inhoud (conventies uit `test/cleanup.test.ts`: zelfde helper, Nederlandse testnamen, `.js`-imports):
  ```ts
  import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
  import type { Client } from 'pg';
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import { setupTestDb, type TestDb } from './helpers/db.js';
  import { runCleanup } from '../src/cleanup.js';

  const MIGRATION_ARCHIVE = readFileSync(
    fileURLToPath(new URL('../migrations/002_archive.sql', import.meta.url)), 'utf8');

  /** Alle kolommen van agent_message, in de fysieke volgorde van 001_init.sql. */
  const COLUMNS = [
    'id', 'type', 'from_server', 'from_model', 'to_server', 'to_model',
    'body', 'meta', 'source', 'status', 'in_reply_to', 'error',
    'claimed_by', 'claimed_at', 'started_at', 'finished_at', 'created_at',
  ] as const;

  let tdb: TestDb; let db: Client;
  beforeAll(async () => { tdb = await setupTestDb(); db = await tdb.connect(); });
  afterAll(async () => { await tdb.end(); });

  beforeEach(async () => {
    await db.query('DELETE FROM agent_message_archive');
    await db.query('DELETE FROM agent_message');
  });

  /**
   * Seed een gesloten request + reply met een onderscheidende waarde per veld:
   * elke kolom is minstens één keer non-null en nergens gelijk aan een default.
   */
  async function seedDistinctiveThread(): Promise<{ requestId: string; replyId: string }> {
    const { rows: reqRows } = await db.query<{ id: string }>(
      `INSERT INTO agent_message
         (type, from_server, from_model, to_server, to_model, body, meta,
          source, status, error, claimed_by, claimed_at, started_at, finished_at, created_at)
       VALUES ('task', 'mac', 'claude', 'scrum4me-server', 'codex',
               'onderscheidende-request-body',
               '{"task":{"objective":"veld-voor-veld-vergelijk"}}'::jsonb,
               'dashboard', 'failed', 'onderscheidende-error-tekst',
               'scrum4me-server:424242',
               now() - interval '75 days', now() - interval '74 days',
               now() - interval '73 days', now() - interval '76 days')
       RETURNING id`);
    const requestId = reqRows[0].id;
    const { rows: repRows } = await db.query<{ id: string }>(
      `INSERT INTO agent_message
         (type, from_server, from_model, to_server, to_model, body, meta,
          source, status, in_reply_to, finished_at, created_at)
       VALUES ('result', 'scrum4me-server', 'codex', 'mac', 'claude',
               'onderscheidende-reply-body', '{"k":"reply-meta"}'::jsonb,
               'cli', 'done', $1,
               now() - interval '72 days', now() - interval '73 days')
       RETURNING id`, [requestId]);
    return { requestId, replyId: repRows[0].id };
  }

  describe('runCleanup — expliciete kolomlijsten', () => {
    it('archiveert veld-voor-veld identiek (volledige rij, onderscheidende waarden)', async () => {
      const { requestId, replyId } = await seedDistinctiveThread();
      const { rows: before } = await db.query(
        'SELECT * FROM agent_message WHERE id = ANY($1) ORDER BY id', [[requestId, replyId]]);
      expect(before.length).toBe(2);

      const counts = await runCleanup(db, 60);
      expect(counts).toEqual({ closedRequests: 1, archived: 2, deleted: 2 });

      const { rows: after } = await db.query(
        'SELECT * FROM agent_message_archive WHERE id = ANY($1) ORDER BY id', [[requestId, replyId]]);
      expect(after.length).toBe(2);
      for (let i = 0; i < before.length; i++) {
        for (const col of COLUMNS) {
          expect(after[i][col], `kolom ${col} van rij ${i}`).toEqual(before[i][col]);
        }
      }
    });

    describe('kolomvolgorde-onafhankelijkheid', () => {
      afterEach(async () => {
        // Herstel de reguliere archieftabel voor de overige tests.
        await db.query('DROP TABLE IF EXISTS agent_message_archive');
        await db.query(MIGRATION_ARCHIVE);
      });

      it('is onafhankelijk van de fysieke kolomvolgorde van agent_message_archive', async () => {
        // Zelfde kolommen, andere fysieke volgorde — precies wat er na een
        // ALTER TABLE ADD COLUMN op één van beide tabellen kan ontstaan.
        // `INSERT ... SELECT *` mapt positioneel en breekt hier; expliciete
        // kolomlijsten aan beide kanten niet.
        await db.query('DROP TABLE agent_message_archive');
        await db.query(`CREATE TABLE agent_message_archive (
          created_at   timestamptz NOT NULL,
          id           uuid PRIMARY KEY,
          body         text NOT NULL,
          type         text NOT NULL,
          from_server  text NOT NULL,
          from_model   text NOT NULL,
          to_server    text NOT NULL,
          to_model     text NOT NULL,
          meta         jsonb NOT NULL DEFAULT '{}',
          source       text NOT NULL,
          status       text NOT NULL,
          in_reply_to  uuid,
          error        text,
          claimed_by   text,
          claimed_at   timestamptz,
          started_at   timestamptz,
          finished_at  timestamptz
        )`);

        const { requestId, replyId } = await seedDistinctiveThread();
        const { rows: before } = await db.query(
          'SELECT * FROM agent_message WHERE id = ANY($1) ORDER BY id', [[requestId, replyId]]);

        const counts = await runCleanup(db, 60);
        expect(counts).toEqual({ closedRequests: 1, archived: 2, deleted: 2 });

        const { rows: after } = await db.query(
          'SELECT * FROM agent_message_archive WHERE id = ANY($1) ORDER BY id', [[requestId, replyId]]);
        for (let i = 0; i < before.length; i++) {
          for (const col of COLUMNS) {
            expect(after[i][col], `kolom ${col} van rij ${i}`).toEqual(before[i][col]);
          }
        }
      });
    });
  });
  ```

- [ ] **Test rood draaien**
  ```bash
  cd /Users/janpetervisser/Development/s4m-queue && npx vitest run test/cleanup-columns.test.ts
  ```
  Verwacht: **1 pass, 1 fail.** De veld-voor-veld-test slaagt (characterization: vandaag zijn de fysieke volgordes toevallig gelijk); de kolomvolgorde-test faalt met de Postgres-fout `column "created_at" is of type timestamp with time zone but expression is of type uuid` (de `SELECT *` mapt `id` positioneel op `created_at`).

- [ ] **Minimale implementatie** — in `/Users/janpetervisser/Development/s4m-queue/src/cleanup.ts` het `archived`-CTE (regels 59–64) vervangen. Oud:
  ```ts
       archived AS (
         INSERT INTO agent_message_archive
         SELECT * FROM agent_message
          WHERE id IN (SELECT id FROM target_ids)
         RETURNING id
       )
  ```
  Nieuw:
  ```ts
       archived AS (
         INSERT INTO agent_message_archive
           (id, type, from_server, from_model, to_server, to_model, body,
            meta, source, status, in_reply_to, error, claimed_by,
            claimed_at, started_at, finished_at, created_at)
         SELECT id, type, from_server, from_model, to_server, to_model, body,
                meta, source, status, in_reply_to, error, claimed_by,
                claimed_at, started_at, finished_at, created_at
           FROM agent_message
          WHERE id IN (SELECT id FROM target_ids)
         RETURNING id
       )
  ```
  En voeg aan het doc-comment boven `runCleanup` (regels 15–21) één regel toe, vóór de afsluitende `*/`:
  ```ts
   * Kolomlijsten zijn aan beide kanten expliciet: archiveren mag nooit van de
   * fysieke kolomvolgorde afhangen (fase 1 s4m-queue-in-scrum4me-migratie).
  ```

- [ ] **Drift-guard toevoegen** (toegevoegd na de kwaliteitsreview van deze taak — empirisch aangetoond gat). Expliciete kolomlijsten sluiten het *reorder*-gat maar openen een *toevoeg*-gat: krijgt een tabel er later een kolom bij zonder dat `cleanup.ts` wordt bijgewerkt, dan archiveert de cleanup die kolom stil niet en verwijdert daarna de bronrij — permanent verlies, zonder error of falende test. Uitgerekend de oude `SELECT *` deed dát geval goed, en de trigger (Prisma neemt het schema over, §4.2) is precies wat dit plan in gang zet. Daarom:
  - Exporteer de kolomlijst als één const uit `src/cleanup.ts` en bouw beide clausules ermee (kolomnamen zijn hardcoded constanten, geen input — interpolatie is hier veilig). Dat haalt tegelijk de drievoudige duplicatie weg (INSERT-lijst, SELECT-lijst, `COLUMNS` in de test).
  - Voeg één test toe die die const set-gewijs vergelijkt met `information_schema.columns` van **beide** tabellen en faalt bij een verschil in beide richtingen. Volgorde negeren — dat is juist het punt van de fix.
  - Verifieer dat die test écht rood wordt: voeg tijdelijk een kolom aan beide tabellen toe zonder de const bij te werken.

  Zo wordt een toekomstige `ADD COLUMN` een falende test in plaats van stil dataverlies. Relevant voor Task 3: de migratie daar draait de s4m-queue-suite tegen de scrum4me-test-DB, dus de drift-guard vuurt daar automatisch.

- [ ] **Groen draaien + volledige suite**
  ```bash
  cd /Users/janpetervisser/Development/s4m-queue && npm test && npm run typecheck && npm run build
  ```
  Verwacht: alle testbestanden groen (incl. bestaande `test/cleanup.test.ts`), typecheck en build zonder fouten.

- [ ] **Committen + pushen** (PR opent JP zelf, teamconventie)
  ```bash
  git -C /Users/janpetervisser/Development/s4m-queue add src/cleanup.ts test/cleanup-columns.test.ts
  git -C /Users/janpetervisser/Development/s4m-queue commit -m "fix(cleanup): archiveer via expliciete kolomlijsten (fase 1 scrum4me-migratie)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  git -C /Users/janpetervisser/Development/s4m-queue push -u origin feat/cleanup-explicit-columns
  ```

---

### Task 2: Canonical Prisma-schema — AgentMessage + AgentMessageArchive (scrum4me-shared)

**Files:**
- Modify: `/Users/janpetervisser/Development/scrum4me-shared/prisma/schema.prisma` (appenden na regel 1210, einde bestand — ná `model JobKindConfig`)
- Test: schema-validatie via `gen-consumer-schema.sh` + `prisma validate` (stap hieronder); DDL-equivalentie wordt in Task 3 stap 5 bewezen

TDD-noot: een Prisma-schema heeft geen unit-test; de "test" is hier `prisma validate` (rood zolang het schema niet klopt) plus de `information_schema`-vergelijking in Task 3.

- [ ] **Branch aanmaken**
  ```bash
  git -C /Users/janpetervisser/Development/scrum4me-shared checkout main
  git -C /Users/janpetervisser/Development/scrum4me-shared pull
  git -C /Users/janpetervisser/Development/scrum4me-shared checkout -b feat/agent-message-schema
  ```

- [ ] **Validatie rood draaien (sanity)** — bewijst dat de validate-stap echt valideert: voeg tijdelijk alléén de regel `model AgentMessage {` (zonder body/accolade) toe aan het einde van `/Users/janpetervisser/Development/scrum4me-shared/prisma/schema.prisma`, en draai:
  ```bash
  CANONICAL_SCHEMA=/Users/janpetervisser/Development/scrum4me-shared/prisma/schema.prisma \
    bash /Users/janpetervisser/Development/scrum4me-shared/scripts/gen-consumer-schema.sh > /tmp/agent-message-check.prisma \
    && cd /tmp && DATABASE_URL=postgresql://localhost:5432/dummy DIRECT_URL=postgresql://localhost:5432/dummy \
    /Users/janpetervisser/Development/Scrum4Me/node_modules/.bin/prisma validate --schema /tmp/agent-message-check.prisma
  ```
  Verwacht: **validate faalt** (parse-error). Verwijder de kapotte regel weer.

- [ ] **Modellen toevoegen** — append aan het einde van `/Users/janpetervisser/Development/scrum4me-shared/prisma/schema.prisma` (na `model JobKindConfig`, regel 1210) exact:
  ```prisma

  /// s4m-queue berichten-queue (fase 1 — scrum4me-mcp spec
  /// 2026-07-12-s4m-queue-mcp-integration-design.md §4). Tabel-DDL identiek aan
  /// s4m-queue/migrations/001_init.sql, met twee bewuste afwijkingen:
  /// source-CHECK bevat ook 'mcp' en er is een extra index op in_reply_to.
  /// CHECK-constraints staan alleen in de SQL-migratie (Prisma negeert ze).
  /// Migratie draait in scrum4me-web (designated migrator), niet hier.
  model AgentMessage {
    id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
    type        String
    from_server String
    from_model  String
    to_server   String
    to_model    String
    body        String
    meta        Json      @default("{}")
    source      String
    status      String    @default("pending")
    in_reply_to String?   @db.Uuid
    error       String?
    claimed_by  String?
    claimed_at  DateTime? @db.Timestamptz(6)
    started_at  DateTime? @db.Timestamptz(6)
    finished_at DateTime? @db.Timestamptz(6)
    created_at  DateTime  @default(now()) @db.Timestamptz(6)

    replied_to AgentMessage?  @relation("AgentMessageReplies", fields: [in_reply_to], references: [id], onDelete: SetNull, onUpdate: NoAction)
    replies    AgentMessage[] @relation("AgentMessageReplies")

    @@index([to_server, to_model, status, created_at], map: "agent_message_claim_idx")
    @@index([in_reply_to], map: "agent_message_in_reply_to_idx")
    @@map("agent_message")
  }

  /// Archief voor s4m-queue-retention: kolommen identiek aan agent_message,
  /// bewust zonder FK, reply_link_matches_type en claim-index
  /// (zie s4m-queue/migrations/002_archive.sql).
  model AgentMessageArchive {
    id          String    @id @db.Uuid
    type        String
    from_server String
    from_model  String
    to_server   String
    to_model    String
    body        String
    meta        Json      @default("{}")
    source      String
    status      String
    in_reply_to String?   @db.Uuid
    error       String?
    claimed_by  String?
    claimed_at  DateTime? @db.Timestamptz(6)
    started_at  DateTime? @db.Timestamptz(6)
    finished_at DateTime? @db.Timestamptz(6)
    created_at  DateTime  @db.Timestamptz(6)

    @@map("agent_message_archive")
  }
  ```
  Bewuste keuzes: `@db.Uuid`/`@db.Timestamptz(6)` wijken af van de cuid/`DateTime`-huisstijl van de rest van het schema omdat de tabel-DDL byte-identiek moet blijven aan `001_init.sql`; `onUpdate: NoAction` voorkomt dat Prisma `ON UPDATE CASCADE` verwacht (de bron-FK heeft geen ON UPDATE-clausule); de FK-naam volgt Prisma-default `agent_message_in_reply_to_fkey`, exact wat Postgres in `001_init.sql` ook genereert.

- [ ] **Validatie groen draaien**
  ```bash
  CANONICAL_SCHEMA=/Users/janpetervisser/Development/scrum4me-shared/prisma/schema.prisma \
    bash /Users/janpetervisser/Development/scrum4me-shared/scripts/gen-consumer-schema.sh > /tmp/agent-message-check.prisma \
    && cd /tmp && DATABASE_URL=postgresql://localhost:5432/dummy DIRECT_URL=postgresql://localhost:5432/dummy \
    /Users/janpetervisser/Development/Scrum4Me/node_modules/.bin/prisma validate --schema /tmp/agent-message-check.prisma
  ```
  Verwacht: `The schema at /tmp/agent-message-check.prisma is valid`.

- [ ] **Shared-repo-verify draaien**
  ```bash
  cd /Users/janpetervisser/Development/scrum4me-shared && npm run verify
  ```
  Verwacht: verify-no-deps + typecheck + vitest allemaal groen (schema-append raakt de lib niet).

- [ ] **Committen + pushen**
  ```bash
  git -C /Users/janpetervisser/Development/scrum4me-shared add prisma/schema.prisma
  git -C /Users/janpetervisser/Development/scrum4me-shared commit -m "feat(schema): AgentMessage + AgentMessageArchive voor s4m-queue (fase 1)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  git -C /Users/janpetervisser/Development/scrum4me-shared push -u origin feat/agent-message-schema
  ```

---

### Task 3: SQL-migratie + submodule-bump in Scrum4Me (designated migrator)

**Files:**
- Create: `/Users/janpetervisser/Development/Scrum4Me/prisma/migrations/<YYYYMMDDHHMMSS>_add_agent_message_queue_tables/migration.sql` (timestamp bij aanmaak genereren; werk in een worktree, zie stap 1)
- Modify: submodule-pointer `vendor/scrum4me-shared`; `prisma/schema.prisma` (gegenereerd via `bash scripts/gen-schema.sh` — nooit handmatig)
- Test: scratch-schema-vergelijking tegen `001_init.sql`+`002_archive.sql` op de test-Postgres (stap 5) + s4m-queue-suite (stap 6)

- [ ] **Worktree opzetten** (hoofd-checkout staat op een andere branch; Prisma-typecheck-trap: submodule initialiseren + node_modules symlinken)
  ```bash
  git -C /Users/janpetervisser/Development/Scrum4Me fetch origin
  git -C /Users/janpetervisser/Development/Scrum4Me worktree add /Users/janpetervisser/Development/Scrum4Me/.claude/worktrees/s4m-queue-tables -b feat/s4m-queue-tables origin/main
  cd /Users/janpetervisser/Development/Scrum4Me/.claude/worktrees/s4m-queue-tables
  git submodule update --init vendor/scrum4me-shared
  ln -sfn /Users/janpetervisser/Development/Scrum4Me/node_modules node_modules
  ```

- [ ] **Submodule bumpen naar de Task-2-commit** (na merge van de shared-PR: `origin/main`; vóór merge kan de branch-SHA, maar pin vóór de Scrum4Me-merge altijd op de gemergde SHA)
  ```bash
  cd /Users/janpetervisser/Development/Scrum4Me/.claude/worktrees/s4m-queue-tables
  git -C vendor/scrum4me-shared fetch origin
  git -C vendor/scrum4me-shared checkout origin/main
  git -C vendor/scrum4me-shared log --oneline -1   # verwacht: de "feat(schema): AgentMessage..."-commit
  ```

- [ ] **Consumer-schema regenereren + valideren** (géén `prisma migrate dev` — prisma.config.ts wijst via `DIRECT_URL` naar de live Neon-DB)
  ```bash
  cd /Users/janpetervisser/Development/Scrum4Me/.claude/worktrees/s4m-queue-tables
  bash scripts/gen-schema.sh
  grep -c "model AgentMessage" prisma/schema.prisma   # verwacht: 2 (AgentMessage + AgentMessageArchive)
  npx prisma validate                                  # verwacht: schema valid
  npm run typecheck                                    # verwacht: 0 errors (nieuwe modellen zijn additief)
  ```

- [ ] **Migratie schrijven** — map + bestand aanmaken:
  ```bash
  cd /Users/janpetervisser/Development/Scrum4Me/.claude/worktrees/s4m-queue-tables
  MIG="prisma/migrations/$(date +%Y%m%d%H%M%S)_add_agent_message_queue_tables"
  mkdir -p "$MIG"
  ```
  Inhoud van `$MIG/migration.sql` (letterlijk 001+002, plus de twee bewuste afwijkingen):
  ```sql
  -- s4m-queue → scrum4me-DB, fase 1 (scrum4me-mcp spec
  -- docs/superpowers/specs/2026-07-12-s4m-queue-mcp-integration-design.md §4).
  -- DDL identiek aan s4m-queue/migrations/001_init.sql + 002_archive.sql,
  -- met twee bewuste afwijkingen:
  --   1. source-CHECK uitgebreid met 'mcp' (MCP-writes, fase 2)
  --   2. extra index op in_reply_to (reply-claim-filter, fase 2)
  -- CHECK-constraints staan bewust alleen hier: Prisma negeert ze (precedent:
  -- 20260527110000_relax_claude_jobs_constraint_for_sprint).

  CREATE TABLE "agent_message" (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type         text NOT NULL
                   CHECK (type IN ('task','info','review_request','result','data','reviewed')),
    from_server  text NOT NULL,
    from_model   text NOT NULL,
    to_server    text NOT NULL,
    to_model     text NOT NULL,
    body         text NOT NULL,
    meta         jsonb NOT NULL DEFAULT '{}',
    source       text NOT NULL
                   CHECK (source IN ('cli','dashboard','mcp')),
    status       text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','claimed','done','failed','cancelled')),
    in_reply_to  uuid REFERENCES "agent_message"(id) ON DELETE SET NULL,
    error        text,
    claimed_by   text,
    claimed_at   timestamptz,
    started_at   timestamptz,
    finished_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reply_link_matches_type CHECK (
      (type IN ('result','data','reviewed')) = (in_reply_to IS NOT NULL)
    )
  );

  CREATE INDEX agent_message_claim_idx
    ON "agent_message" (to_server, to_model, status, created_at);

  -- Bewuste afwijking 2: nodig voor het in_reply_to = ANY(...)-claim-filter
  -- (fase 2) en versnelt de bestaande replies-lookup van `status <id>`.
  CREATE INDEX agent_message_in_reply_to_idx
    ON "agent_message" (in_reply_to);

  -- Archief: kolommen identiek aan agent_message, bewust zonder FK,
  -- reply_link_matches_type en claim-index (zie 002_archive.sql).
  CREATE TABLE "agent_message_archive" (
    id           uuid PRIMARY KEY,
    type         text NOT NULL,
    from_server  text NOT NULL,
    from_model   text NOT NULL,
    to_server    text NOT NULL,
    to_model     text NOT NULL,
    body         text NOT NULL,
    meta         jsonb NOT NULL DEFAULT '{}',
    source       text NOT NULL,
    status       text NOT NULL,
    in_reply_to  uuid,
    error        text,
    claimed_by   text,
    claimed_at   timestamptz,
    started_at   timestamptz,
    finished_at  timestamptz,
    created_at   timestamptz NOT NULL
  );
  ```

- [ ] **DDL-equivalentie bewijzen op de test-Postgres** (dit is de archiverings-/schema-test van deze taak — rood zolang de migratie afwijkt van 001+002 buiten de twee bedoelde punten). Werkmap + env:
  ```bash
  mkdir -p ~/s4m-cutover && chmod 700 ~/s4m-cutover
  export S4M_TEST_DATABASE_URL="$(grep -m1 '^S4M_TEST_DATABASE_URL=' /Users/janpetervisser/Development/s4m-queue/.env | cut -d= -f2-)"
  MIG_SQL="$(ls /Users/janpetervisser/Development/Scrum4Me/.claude/worktrees/s4m-queue-tables/prisma/migrations/*_add_agent_message_queue_tables/migration.sql)"
  psql "$S4M_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
  DROP SCHEMA IF EXISTS s4m_mig_base CASCADE; CREATE SCHEMA s4m_mig_base;
  SET search_path TO s4m_mig_base;
  \i /Users/janpetervisser/Development/s4m-queue/migrations/001_init.sql
  \i /Users/janpetervisser/Development/s4m-queue/migrations/002_archive.sql
  DROP SCHEMA IF EXISTS s4m_mig_new CASCADE; CREATE SCHEMA s4m_mig_new;
  SET search_path TO s4m_mig_new;
  \i $MIG_SQL
  SQL
  ```
  Kolommen vergelijken (incl. **ordinal_position**, nullability, defaults):
  ```bash
  for s in s4m_mig_base s4m_mig_new; do
    psql "$S4M_TEST_DATABASE_URL" --csv -c "
      SELECT table_name, ordinal_position, column_name, data_type,
             is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = '$s'
         AND table_name IN ('agent_message','agent_message_archive')
       ORDER BY table_name, ordinal_position" > ~/s4m-cutover/columns-$s.csv
  done
  diff ~/s4m-cutover/columns-s4m_mig_base.csv ~/s4m-cutover/columns-s4m_mig_new.csv
  ```
  Verwacht: **lege diff** (beide afwijkingen zijn constraint-/indexniveau, geen kolomniveau).
  Constraints en indexen vergelijken:
  ```bash
  for s in s4m_mig_base s4m_mig_new; do
    psql "$S4M_TEST_DATABASE_URL" --csv \
      -c "SET search_path TO $s" \
      -c "SELECT c.relname, con.conname, pg_get_constraintdef(con.oid)
            FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
           WHERE con.connamespace = current_schema()::regnamespace
           ORDER BY 1, 2" > ~/s4m-cutover/constraints-$s.csv
    psql "$S4M_TEST_DATABASE_URL" --csv -c "
      SELECT tablename, indexname FROM pg_indexes
       WHERE schemaname = '$s' ORDER BY 1, 2" > ~/s4m-cutover/indexes-$s.csv
  done
  diff ~/s4m-cutover/constraints-s4m_mig_base.csv ~/s4m-cutover/constraints-s4m_mig_new.csv
  diff ~/s4m-cutover/indexes-s4m_mig_base.csv ~/s4m-cutover/indexes-s4m_mig_new.csv
  ```
  Verwacht: constraints-diff toont **exact één** verschil — `agent_message_source_check` met `'mcp'::text` erbij; indexes-diff toont **exact één** extra rij — `agent_message_in_reply_to_idx`. Elk ander verschil = migratie fixen tot dit klopt. Daarna opruimen:
  ```bash
  psql "$S4M_TEST_DATABASE_URL" -c "DROP SCHEMA s4m_mig_base CASCADE; DROP SCHEMA s4m_mig_new CASCADE"
  ```

- [ ] **CLI-compatibiliteitsbewijs (spec §8):** de bestaande s4m-queue-testsuite tegen de scrum4me-test-DB draaien — zet `S4M_TEST_DATABASE_URL` voor deze ene run op de scrum4me-test-DB-URL (zie open vraag 2; de suite maakt eigen wegwerp-schema's en raakt niets anders):
  ```bash
  cd /Users/janpetervisser/Development/s4m-queue && S4M_TEST_DATABASE_URL="$SCRUM4ME_TEST_DB_URL_UIT_OPEN_VRAAG_2" npm test
  ```
  Verwacht: volledige suite groen (bewijst o.a. `gen_random_uuid()`, LISTEN/NOTIFY en de claim-semantiek op die Postgres).

- [ ] **Committen + pushen** (PR opent JP)
  ```bash
  cd /Users/janpetervisser/Development/Scrum4Me/.claude/worktrees/s4m-queue-tables
  git add vendor/scrum4me-shared prisma/schema.prisma prisma/migrations/
  git commit -m "feat(db): agent_message + agent_message_archive (s4m-queue fase 1)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  git push -u origin feat/s4m-queue-tables
  ```

---

### Task 4: Pre-cutover deploys — cleanup-fix + prod-schema

**Files:** geen code; deploy-acties. Preconditie: PR's van Task 1–3 zijn gemerged (JP merget; volgorde: s4m-queue en scrum4me-shared eerst, dan Scrum4Me met de gepinde shared-SHA).

- [ ] **Preconditie verifiëren**
  ```bash
  git -C /Users/janpetervisser/Development/s4m-queue fetch origin && git -C /Users/janpetervisser/Development/s4m-queue log origin/main --oneline -3
  git -C /Users/janpetervisser/Development/Scrum4Me fetch origin && git -C /Users/janpetervisser/Development/Scrum4Me log origin/main --oneline -3
  ```
  Verwacht: de commits `fix(cleanup): archiveer via expliciete kolomlijsten…` resp. `feat(db): agent_message + agent_message_archive…` zitten in beide `origin/main`.

- [ ] **Cleanup-fix deployen op scrum4me-server** (vóór de cutover, spec §4.1; de globale bin wordt door de systemd-service gebruikt). Pad van de checkout op de server ter plekke verifiëren (open vraag 7):
  ```bash
  ssh scrum4me-server 'cd ~/Development/s4m-queue && git pull && npm ci && npm run build && sudo npm i -g .'
  ssh scrum4me-server "grep -c 'in_reply_to, error, claimed_by' \$(readlink -f /usr/bin/s4m-queue-cleanup)"
  ```
  Verwacht: laatste commando print `2` (kolomlijst staat in zowel INSERT als SELECT van de gebouwde bin).

- [ ] **HARDSTOP: expliciet akkoord JP vereist** — prod-schema-deploy naar de scrum4me-DB (lege tabellen aanmaken; veilig vóór de cutover omdat er nog geen writers naar wijzen, spec §4.5: schema vóór code/data). Mechaniek uit memory `scrum4me-prod-migratie-deploy` (waarden nooit printen):
  ```bash
  git -C /Users/janpetervisser/Development/Scrum4Me worktree add --detach /tmp/s4m-main-deploy origin/main
  ln -sfn /Users/janpetervisser/Development/Scrum4Me/node_modules /tmp/s4m-main-deploy/node_modules
  DIRECT_URL="$(grep -m1 '^DIRECT_URL=' /Users/janpetervisser/Development/Scrum4Me/.env.local | cut -d= -f2- | tr -d '"')" \
    /Users/janpetervisser/Development/Scrum4Me/node_modules/.bin/prisma migrate deploy --config /tmp/s4m-main-deploy/prisma.config.ts
  git -C /Users/janpetervisser/Development/Scrum4Me worktree remove /tmp/s4m-main-deploy
  ```
  Verwacht: `migrate deploy` past exact de nieuwe `*_add_agent_message_queue_tables`-migratie toe (controleer de pending-lijst in de output vóór bevestiging).

- [ ] **Prod-schema verifiëren** (read-only)
  ```bash
  DIRECT_URL="$(grep -m1 '^DIRECT_URL=' /Users/janpetervisser/Development/Scrum4Me/.env.local | cut -d= -f2- | tr -d '"')"
  psql "$DIRECT_URL" -c "SELECT count(*) FROM agent_message" -c "SELECT count(*) FROM agent_message_archive"
  ```
  Verwacht: twee keer `0`.

---

### Task 5: Stop-the-world data-cutover (runbook, spec §4.4)

**Files:** geen code. Host-env-bestanden: mac `~/.zshenv`; scrum4me-server `~/.config/s4m-queue.env` + `/etc/s4m-queue/cleanup.env`; max2-equivalent; scrum4me-workers-deployment-env (`OPS_DATABASE_URL`, zie `lib/queue/ops-db.ts:19`). Artefacten in `~/s4m-cutover/` (chmod 700, bevat connection-materiaal).

- [ ] **HARDSTOP: expliciet akkoord JP vereist** — start van het cutover-window. JP kondigt de pauze aan bij alle agents (mac, scrum4me-server, max2; claude + codex) en er wordt pas verdergegaan als queue-gebruik aantoonbaar stil ligt.

- [ ] **Writers stoppen** (checken dat niets pending/claimed staat stopt geen nieuwe push — de bronnen zelf uitzetten):
  ```bash
  ssh scrum4me-server 'sudo systemctl stop s4m-queue-cleanup.timer'
  # Messages-dashboard: stop de scrum4me-workers-service op scrum4me-server
  # (exacte unit-/procesnaam: open vraag 3), bijv.:
  ssh scrum4me-server 'sudo systemctl stop <scrum4me-workers-unit>'
  ```
  Daarna wachten tot er geen `claimed`-rijen meer zijn (een worker die mid-taak is zou na de cutover zijn `done` op de oude DB schrijven):
  ```bash
  source ~/.zshenv && s4m-queue list
  ```
  Verwacht: geen rijen met status `claimed` (pending mag — die verhuizen mee). Blijft een claim hangen: bewust `s4m-queue requeue <id>` of wachten.

- [ ] **Oude env-waarden veiligstellen (rollback-materiaal)**
  ```bash
  mkdir -p ~/s4m-cutover && chmod 700 ~/s4m-cutover
  grep 'S4M_QUEUE_URL' ~/.zshenv > ~/s4m-cutover/old-env-mac.txt
  ssh scrum4me-server 'grep S4M_QUEUE_URL ~/.config/s4m-queue.env; sudo grep S4M_QUEUE_MAINTENANCE_URL /etc/s4m-queue/cleanup.env' > ~/s4m-cutover/old-env-server.txt
  ssh max2 'grep -H S4M_QUEUE_URL ~/.zshenv ~/.config/s4m-queue.env 2>/dev/null' > ~/s4m-cutover/old-env-max2.txt
  chmod 600 ~/s4m-cutover/old-env-*.txt
  ```

- [ ] **Watermark vastleggen (bron)** — eerst het SQL-bestand schrijven:
  ```bash
  cat > ~/s4m-cutover/watermark.sql <<'EOF'
  -- rijtallen per (tabel, status, type)
  SELECT 'agent_message' AS tbl, status, type, count(*)::bigint AS n
    FROM agent_message GROUP BY status, type
  UNION ALL
  SELECT 'agent_message_archive', status, type, count(*)::bigint
    FROM agent_message_archive GROUP BY status, type
  ORDER BY 1, 2, 3;
  -- max created_at per tabel
  SELECT 'agent_message' AS tbl, max(created_at) AS max_created_at FROM agent_message
  UNION ALL
  SELECT 'agent_message_archive', max(created_at) FROM agent_message_archive
  ORDER BY 1;
  EOF
  source ~/.zshenv && psql "$S4M_QUEUE_URL" --csv -f ~/s4m-cutover/watermark.sql > ~/s4m-cutover/watermark-source.csv
  cat ~/s4m-cutover/watermark-source.csv
  ```
  Verwacht: CSV met de actuele rijtallen; bewaar dit bestand — het is de validatiereferentie.

- [ ] **Dump maken (bron; data-only, beide tabellen)** — versiecheck eerst (`pg_dump` ≥ serverversie):
  ```bash
  source ~/.zshenv
  pg_dump --version && psql "$S4M_QUEUE_URL" -tAc 'SHOW server_version'
  pg_dump "$S4M_QUEUE_URL" --data-only --no-owner --no-privileges \
    --table=public.agent_message --table=public.agent_message_archive \
    -f ~/s4m-cutover/s4m-queue-data.sql
  chmod 600 ~/s4m-cutover/s4m-queue-data.sql
  grep -c '^COPY' ~/s4m-cutover/s4m-queue-data.sql
  ```
  Verwacht: `2` (één COPY-blok per tabel).

- [ ] **HARDSTOP: expliciet akkoord JP vereist** — restore in de prod-scrum4me-DB. In één transactie; de self-FK wordt tijdelijk gedropt omdat COPY positiegevoelig per rij valideert en heap-volgorde na status-UPDATEs replies vóór hun request kan leggen; de `ADD CONSTRAINT` hervalideert daarna alle rijen. Bij een herhaalde poging na een fout eerst `TRUNCATE public.agent_message, public.agent_message_archive;` (tabellen horen leeg te zijn — check vooraf zoals in Task 4):
  ```bash
  DIRECT_URL="$(grep -m1 '^DIRECT_URL=' /Users/janpetervisser/Development/Scrum4Me/.env.local | cut -d= -f2- | tr -d '"')"
  psql "$DIRECT_URL" -v ON_ERROR_STOP=1 <<'SQL'
  BEGIN;
  ALTER TABLE public.agent_message DROP CONSTRAINT agent_message_in_reply_to_fkey;
  \i /Users/janpetervisser/s4m-cutover/s4m-queue-data.sql
  ALTER TABLE public.agent_message ADD CONSTRAINT agent_message_in_reply_to_fkey
    FOREIGN KEY (in_reply_to) REFERENCES public.agent_message(id) ON DELETE SET NULL;
  COMMIT;
  SQL
  ```
  Verwacht: `COMMIT` zonder fouten (geen sequences om te resetten — uuid-PK's).

- [ ] **Validatie 1 — rijtallen per (tabel, status, type) tegen de watermark**
  ```bash
  psql "$DIRECT_URL" --csv -f ~/s4m-cutover/watermark.sql > ~/s4m-cutover/watermark-target.csv
  diff ~/s4m-cutover/watermark-source.csv ~/s4m-cutover/watermark-target.csv
  ```
  Verwacht: **lege diff**. Elke afwijking (ook méér rijen in target) = een writer heeft tussendoor geschreven → onderzoeken vóór verdergaan.

- [ ] **Validatie 2 — schema-gelijkheid via `information_schema.columns` incl. ordinal position** (bron ops_dashboard vs prod-target, beide `public`):
  ```bash
  cat > ~/s4m-cutover/columns.sql <<'EOF'
  SELECT table_name, ordinal_position, column_name, data_type,
         is_nullable, column_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('agent_message','agent_message_archive')
   ORDER BY table_name, ordinal_position;
  EOF
  source ~/.zshenv
  psql "$S4M_QUEUE_URL" --csv -f ~/s4m-cutover/columns.sql > ~/s4m-cutover/columns-source.csv
  psql "$DIRECT_URL"    --csv -f ~/s4m-cutover/columns.sql > ~/s4m-cutover/columns-target.csv
  diff ~/s4m-cutover/columns-source.csv ~/s4m-cutover/columns-target.csv
  ```
  Verwacht: **lege diff** voor werk- én archieftabel (de mcp-CHECK en extra index zijn geen kolommen).

- [ ] **Connection strings omhangen** — nieuwe waarde = de scrum4me-DB-URL die ook LISTEN/NOTIFY aankan (**direct endpoint, géén pooler** — CLI `--wait` en dashboard-SSE gebruiken LISTEN; zelfde URL-soort als scrum4me-mcp's `DATABASE_URL`; waarde uit de secret-store van JP, nooit printen):
  1. mac: `S4M_QUEUE_URL` in `~/.zshenv` vervangen.
  2. scrum4me-server: `S4M_QUEUE_URL` in `~/.config/s4m-queue.env` vervangen.
  3. max2: zelfde wijziging in het bestand dat daar `S4M_QUEUE_URL` zet (verifieer: `ssh max2 'grep -l S4M_QUEUE_URL ~/.zshenv ~/.config/s4m-queue.env 2>/dev/null'`).
  4. scrum4me-server: `S4M_QUEUE_MAINTENANCE_URL` in `/etc/s4m-queue/cleanup.env` → scrum4me-DB (rol met SELECT/INSERT/UPDATE/DELETE op beide tabellen; **moet er een nieuwe DB-rol komen → HARDSTOP: expliciet akkoord JP vereist**, dat is een prod-DB-wijziging — open vraag 5).
  5. scrum4me-workers (Messages-dashboard): `OPS_DATABASE_URL` in de deployment-env op scrum4me-server → scrum4me-DB.
  Verificatie zonder waarden te printen:
  ```bash
  zsh -c 'source ~/.zshenv && psql "$S4M_QUEUE_URL" -tAc "SELECT count(*) FROM agent_message"'
  ```
  Verwacht: het rijtal uit de watermark (niet 0, tenzij de queue echt leeg was).

- [ ] **Canary-roundtrip tegen de nieuwe DB** (push → next → done --reply → status, spec §4.4.6; in een verse shell zodat `~/.zshenv` herladen is):
  ```bash
  s4m-queue push --to mac:claude --as jp --type info --body "cutover-canary $(date +%F)"
  # noteer het bericht-id uit de output → CANARY_ID
  s4m-queue next --as claude --json          # verwacht: claimt exact de canary
  s4m-queue done <CANARY_ID> --reply "canary ok — cutover $(date +%F)"
  s4m-queue status <CANARY_ID>               # verwacht: status done + gekoppelde reply
  s4m-queue inbox --as jp --json             # verwacht: de data-reply
  s4m-queue done <REPLY_ID>                  # ack
  ```
  Dashboard-SSE-check: start de workers-service tijdelijk (of na de volgende stap), open `/queue/messages` en verifieer dat de canary zichtbaar is en live ververst.

- [ ] **Consumers herstarten** (pas ná geslaagde canary):
  ```bash
  ssh scrum4me-server 'sudo systemctl start <scrum4me-workers-unit>'
  ssh scrum4me-server 'sudo systemctl start s4m-queue-cleanup.timer && systemctl list-timers s4m-queue-cleanup.timer'
  ```
  Verwacht: timer staat weer gepland (volgende run 03:00). JP geeft de agents het sein dat de queue weer open is. Log de afronding + artefact-locatie (`~/s4m-cutover/`) in het cutover-doc van Task 6.

---

### Task 6: Rollback-window, docs en oude tabellen onaangeroerd

**Files:**
- Create: `/Users/janpetervisser/Development/s4m-queue/docs/2026-07-scrum4me-db-cutover.md`
- Modify: `/Users/janpetervisser/Development/s4m-queue/AGENTS.md` (regels 6–8, sectie "Env (per machine, niet in git)")

- [ ] **Rollback-window + no-rename vastleggen** — `/Users/janpetervisser/Development/s4m-queue/docs/2026-07-scrum4me-db-cutover.md` aanmaken met exact:
  ```markdown
  # Cutover ops_dashboard → scrum4me-DB (fase 1, 2026-07)

  Draaiboek uitgevoerd volgens scrum4me-mcp
  `docs/superpowers/specs/2026-07-12-s4m-queue-mcp-integration-design.md` §4.4.
  Artefacten (watermark, kolomvergelijk, dump, oude env-waarden): `~/s4m-cutover/` op de mac.

  ## Rollback-window

  - **Verliesvrij terug** kan uitsluitend zolang de writers (agents, Messages-dashboard,
    cleanup-timer) nog níet herstart zijn: env-vars terugzetten uit
    `~/s4m-cutover/old-env-*.txt` en de nieuwe tabellen negeren. Alleen de canary-rijen
    bestaan dan al in de scrum4me-DB — die mogen verloren gaan.
  - **Ná herstart van de writers** ontstaan nieuwe rijen uitsluitend in de scrum4me-DB:
    strategie is dan roll-forward (geen reverse-delta — niet proportioneel voor dit volume).

  ## Oude tabellen

  De tabellen `agent_message` en `agent_message_archive` in de `ops_dashboard`-DB blijven
  tijdens de observatieperiode **onaangeroerd** — géén rename of drop bij de cutover.
  Rename/drop is een aparte opruimactie na ≥ 1 week stabiel draaien (spec §9), en raakt
  ook de legacy-verwijzingen in het Ops-dashboard; alleen op initiatief van JP.
  ```

- [ ] **AGENTS.md-env-sectie bijwerken** — in `/Users/janpetervisser/Development/s4m-queue/AGENTS.md` de sectie (regels 6–8) vervangen. Oud:
  ```markdown
  ## Env (per machine, niet in git)
  - `S4M_QUEUE_URL` — Postgres op scrum4me-server (via Tailscale)
  - `S4M_SERVER` — `mac` of `scrum4me-server`
  ```
  Nieuw:
  ```markdown
  ## Env (per machine, niet in git)
  - `S4M_QUEUE_URL` — de scrum4me-DB (sinds de fase-1-cutover 2026-07; direct endpoint,
    géén pooler — LISTEN/NOTIFY). Oude `ops_dashboard`-tabellen staan er nog read-only;
    zie docs/2026-07-scrum4me-db-cutover.md.
  - `S4M_SERVER` — `mac`, `scrum4me-server` of `max2`
  ```

- [ ] **Verifiëren dat de oude tabellen onaangeroerd zijn** (read-only check met de bewaarde oude URL; waarde niet printen):
  ```bash
  OLD_URL="$(grep -m1 'S4M_QUEUE_URL=' ~/s4m-cutover/old-env-mac.txt | sed 's/^export //' | cut -d= -f2- | tr -d '"')"
  psql "$OLD_URL" -c "\dt agent_message*"
  ```
  Verwacht: beide tabellen bestaan nog onder hun oorspronkelijke naam.

- [ ] **Committen + pushen**
  ```bash
  git -C /Users/janpetervisser/Development/s4m-queue add docs/2026-07-scrum4me-db-cutover.md AGENTS.md
  git -C /Users/janpetervisser/Development/s4m-queue commit -m "docs(cutover): scrum4me-DB-cutover, rollback-window en env-update" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  git -C /Users/janpetervisser/Development/s4m-queue push
  ```
