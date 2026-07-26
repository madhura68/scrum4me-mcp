# s4m-queue data-cutover — runbook (T-96)

**Doel:** de queue verhuizen van `ops_dashboard` naar de `scrum4me`-DB, en alle consumenten laten
overschakelen.

**Status: data staat over, omhang nog niet gedaan.** Zie §1 voor wat er op 2026-07-25 feitelijk
is gebeurd en §3 voor wat er nog moet.

**Uitvoering:** interactief, samen met JP. Elke stap die de productie-DB of live env raakt is
**HARDSTOP** — niet uitvoeren zonder expliciet "ja" van JP in de chat.

> **Herzien op 2026-07-25.** De oorspronkelijke versie schreef een `pg_dump`/`psql`-pad voor dat
> we niet gebruikt hebben, en zweeg over de rechtenkwestie die het echte obstakel bleek. Beide
> zijn hieronder gecorrigeerd op wat er gemeten en gedaan is. §5 legt de verschillen vast, zodat
> de reden vindbaar blijft.

---

## 1. Wat er op 2026-07-25 is gedaan

### De data staat over — 328 rijen, gevalideerd

Uitgevoerd na expliciet akkoord van JP, vanaf de mac, met een Node-script op `pg`:

```
BRON  vóór  : 328 rijen
gelezen     : 328 rijen (187 wortels, 141 replies)
ingevoegd   : 187 wortels + 141 replies = 328
overgeslagen: 0

rijtelling gelijk : JA
watermark gelijk  : JA        (verdeling per status/type identiek)
weesreplies doel  : 0
bron onaangeroerd : JA
```

De bron is **niet** gewijzigd en blijft als vangnet staan.

### Waarom géén pg_dump

De oorspronkelijke opzet ging uit van `pg_dump --data-only` op `scrum4me-srv`, omdat die tools
niet op de mac-PATH staan en SSH vanaf de mac niet werkt. Dat pad is overbodig: **beide databases
zijn rechtstreeks vanaf de mac bereikbaar** (zelfde host, zelfde poort, alleen database en rol
verschillen). 328 rijen kopiëren gaat prima met `INSERT ... ON CONFLICT (id) DO NOTHING` in één
transactie.

Dat is niet alleen eenvoudiger maar ook veiliger:

- **De self-FK hoefde niet gedropt.** De oorspronkelijke tekst nam aan dat COPY een reply vóór
  zijn parent kan invoegen en dat `agent_message_in_reply_to_fkey` daarom weg moest. Gemeten:
  er zijn **nul replies-op-een-reply** (187 wortels, 141 replies, nul wezen). Een tweefasen-insert
  — eerst alle rijen met `in_reply_to IS NULL`, dan de rest — houdt de FK de hele transactie
  geldig. Geen DDL op productie, dus ook geen venster waarin de integriteit niet afgedwongen wordt.
- **De kopie is herhaalbaar.** `ON CONFLICT (id) DO NOTHING` maakt een tweede run een delta-run.
  Dat is precies wat je nodig hebt als er tijd zit tussen de kopie en de omhang.

Het script staat in de sessie-scratchpad; het leest alléén uit de bron en doet alleen INSERTs op
het doel. Geen UPDATE, geen DELETE, geen DDL.

### Gemeten feiten (2026-07-25, ~20:00 UTC)

| | |
|---|---|
| Bron | `ops_dashboard.agent_message` — 328 rijen, nieuwste 17:35 UTC, **nul writes in het laatste uur**. Geen archieftabel. |
| Doel | `scrum4me.agent_message` — 328 rijen na de kopie. `agent_message_archive` bestaat en is leeg. |
| Kolomsets | Bron en doel **identiek** (naam, type, nullability). |
| Deelnemers | Alle vier actief: `max2:claude` (72 rijen, laatst 17:35), `mac:codex` (127, 17:33), `scrum4me-server:claude` (47, 24-07 22:44), `mac:claude` (82, 24-07 21:00). |
| Openstaand | 5 `claimed` — **allemaal ouder dan de reclaim-default van 4h**, dus verlaten claims, geen lopend werk. 3 `pending`, waarvan twee vragen aan `mac:jp`. |
| Pooler | Bestaat niet. `DATABASE_URL` en `DIRECT_URL` zijn identiek van vorm; de "gebruik het directe endpoint"-waarschuwing is niet van toepassing. |

---

## 2. Het obstakel dat het runbook miste: rechten

De queue-CLI draait op alle hosts onder de Postgres-rol `s4m_queue`. Die rol kan **wél** verbinden
met de database `scrum4me` (CONNECT en schema `public` USAGE zijn in orde) maar heeft **nul
rechten op de tabellen** — gemeten:

```
agent_message          SELECT=false INSERT=false UPDATE=false DELETE=false
agent_message_archive  SELECT=false INSERT=false UPDATE=false DELETE=false
```

Zonder reparatie ketst na de omhang elke `push` en `next` af op Postgres-fout **42501**.

De rollen op de doel-DB:

| rol | rechten op `agent_message` | |
|---|---|---|
| `scrum4me` | eigenaar, alles | ⚠️ **superuser** |
| `scrum4me_app` | DELETE, INSERT, SELECT, UPDATE | non-superuser |
| `ops_readonly` | SELECT | |
| `s4m_queue` | geen | |

**Besluit JP 2026-07-25: GRANT aan `s4m_queue`.** Bewuste afwijking van het besluit van
2026-07-18 ("bestaande app-rol, geen prod-rolwijziging"). Reden: het wachtwoord van `s4m_queue`
staat al op alle drie de hosts, dus de omhang wordt een wijziging van één woord in de URL en er
verhuist géén enkel geheim. De rol blijft minimaal — exact dezelfde vier rechten die
`scrum4me_app` al heeft, en verder niets in die database.

> Het alternatief was `DIRECT_URL` gebruiken, maar die draait op de rol `scrum4me` — een
> **superuser**. Die string op drie hosts zetten geeft de queue-CLI superuser-rechten op de hele
> database. Niet doen.

---

## 3. Wat er nog moet — de omhang

### Stap 1 — GRANT (uitbesteed aan agent 154)

Op 2026-07-25 als taak `5507e07f-68b3-40c8-a43d-2ba3b0b3a264` naar `scrum4me-server:claude`
gestuurd. `psql` staat niet op de mac-PATH en de permission-classifier blokkeert een
privilegewijziging op productie vanaf hier — terecht.

```sql
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.agent_message, public.agent_message_archive
  TO s4m_queue;
```

Exact deze vier. Geen TRUNCATE, geen TRIGGER, geen REFERENCES.

Verificatie — verwacht `DELETE,INSERT,SELECT,UPDATE` voor beide tabellen:

```sql
SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS rechten
FROM information_schema.role_table_grants
WHERE table_schema='public'
  AND table_name IN ('agent_message','agent_message_archive')
  AND grantee='s4m_queue'
GROUP BY table_name ORDER BY table_name;
```

Plus een rooktest onder de rol zelf, in een transactie die wordt teruggedraaid — bewijzen dat het
werkt, niet dat het zo lijkt. Terugdraaien is symmetrisch: dezelfde regel met `REVOKE … FROM`.

### Stap 2 — HARDSTOP: JP opent het venster

Vanaf hier geen queue-gebruik door de agents.

### Stap 3 — delta-kopie

De kopie is herhaalbaar. Draai hem opnieuw vlak vóór de omhang; hij pikt alles op wat er sinds
de eerste run bij is gekomen — waaronder de taakrij van stap 1 zelf.

Controleer daarna dat bron en doel dezelfde telling én hetzelfde watermark hebben.

### Stap 4 — HARDSTOP: connection strings omhangen, alle hosts tegelijk

**Een halve omhang is slechter dan geen.** Hangt de mac om terwijl de servers achterblijven, dan
schrijven `mac:claude` en `mac:codex` naar de nieuwe database terwijl `max2:claude` en
`scrum4me-server:claude` op de oude blijven — berichten tussen die groepen verdwijnen in
verschillende databases zonder foutmelding.

De wijziging is per host één woord in de URL: `ops_dashboard` → `scrum4me`. Rol en wachtwoord
blijven `s4m_queue`.

1. `S4M_QUEUE_URL` op **mac** (`~/.zshenv`)
2. `S4M_QUEUE_URL` op **scrum4me-server** (`~/.config/s4m-queue.env`)
3. `S4M_QUEUE_URL` op **max2** (env-bestand ter plekke vaststellen — staat in de verkenning van
   taak `5507e07f`)
4. `OPS_DATABASE_URL` voor **scrum4me-workers** op scrum4me-srv. Let op: die draait vandaag op de
   rol `scrum4me`, niet op `s4m_queue`. Bepaal bij de omhang welke rol je daar wilt — de app-rol
   volstaat en `scrum4me_app` heeft de juiste rechten al.

Bewaar de oude waarden vooraf. Waarden nooit printen of loggen.

`S4M_QUEUE_MAINTENANCE_URL` (cleanup-bin) is niet aan de orde: er draait geen cleanup-timer.
Bevestig dat met de verkenning uit taak `5507e07f` voordat je hem definitief afvoert.

### Stap 5 — canary

Verse shell, env herladen:

```bash
s4m-queue push --to mac:claude --as jp --type info --body "cutover-canary $(date +%F)"
s4m-queue next --as claude --json
s4m-queue done <id> --reply "canary ok"
s4m-queue status <id>
s4m-queue inbox --as jp --json
s4m-queue done <reply-id>
```

Plus: open `/queue/messages` in scrum4me-workers en controleer dat de canary live verschijnt —
dat toetst de SSE tegen de nieuwe database.

Doe de canary ook één keer **tussen twee hosts** (bijvoorbeeld `mac:claude` → `max2:claude` en
terug). Een canary binnen één host bewijst niet dat beide kanten dezelfde database zien, en dat
is precies het faalgeval van een halve omhang.

### Stap 6 — vrijgeven

Pas ná een geslaagde canary: services weer aan, en JP geeft de agents het sein dat de queue open is.

---

## 4. Rollback

- **Verliesvrij** zolang de writers nog niet herstart zijn: connection strings terugzetten naar
  `ops_dashboard`. Alleen de canary-rijen bestaan dan al op het doel; die mogen verloren.
- De GRANT hoeft niet teruggedraaid — hij is onschadelijk zolang niemand de nieuwe database
  gebruikt. Wil je toch schoon achterlaten: `REVOKE SELECT, INSERT, UPDATE, DELETE ON
  public.agent_message, public.agent_message_archive FROM s4m_queue;`
- **Ná herstart** ontstaan rijen uitsluitend op de scrum4me-DB → roll-forward, geen reverse-delta.

---

## 5. Wat er veranderd is t.o.v. de versie van 2026-07-18

Vastgelegd zodat de redenen vindbaar blijven, niet alleen de uitkomst.

| Stond er | Bleek |
|---|---|
| 92 rijen, 3 claimed | 328 rijen, 5 claimed — allemaal verlopen |
| `pg_dump --data-only` op scrum4me-srv, want de tools staan niet op de mac | Niet nodig: beide DB's zijn vanaf de mac bereikbaar. Tweefasen-`INSERT` via `pg`. |
| Self-FK moet gedropt en hervalideerd worden | Niet nodig: nul replies-op-een-reply, dus insert-volgorde houdt de FK geldig. Geen DDL op prod. |
| Eenmalige dump/restore | Herhaalbare kopie met `ON CONFLICT DO NOTHING`, zodat de delta later opgepikt kan worden |
| "direct endpoint, geen pooler" | Er ís geen pooler; `DATABASE_URL` en `DIRECT_URL` zijn identiek van vorm |
| Zweeg over rechten | `s4m_queue` heeft nul rechten op de doeltabellen. Dit was het echte obstakel. |
| Kolommen "byte-identiek, CHECK-namen wijken cosmetisch af" | Kolomsets gemeten identiek; de bron heeft géén `'mcp'` in de source-CHECK, het doel wel. Alle bronrijen hebben `source='cli'`, dus de kopie haalt de CHECK van het doel. |

---

## 6. Ná de cutover (aparte acties)

- **Het vangnet is niet meer compleet — waargenomen op 2026-07-26.** De opzet was dat
  `ops_dashboard.agent_message` onaangeroerd zou blijven. In de praktijk is die tabel van 330 naar
  51 rijen gegaan en de nieuwe `scrum4me.agent_message` van 332 naar 8, doordat JP de
  retentie-purge uit het Messages-dashboard draaide. Dat is de purge die zijn werk doet — geen
  incident — maar reken er niet op dat de oude tabel een volledige kopie van vóór de cutover
  bevat. Het archief is leeg (0 rijen): de purge verwijdert zonder te archiveren, anders dan
  `cleanup`.

  Leerpunt voor een volgende cutover: **de env-wijziging en de container-herstart zijn twee
  momenten.** Dát `ops_dashboard` óók gekrompen is, betekent dat één purge draaide toen de
  workers-container zijn nieuwe `OPS_DATABASE_URL` nog niet had ingelezen — het dashboard wees
  toen nog naar de oude database terwijl de CLI's al om waren. Hier onschadelijk, want het was een
  delete en geen write, maar in dat venster is het dashboard aantoonbaar op de oude DB actief.
  Herstart de container dus direct na de bestandswijziging, en verifieer de omschakeling aan de
  data in plaats van aan het env-bestand.

- Opruimen van de oude tabel (droppen + `model AgentMessage` uit het Ops-schema mét
  drop-migratie) is een aparte taak na ≥1 week stabiel draaien.
- `scrum4me-workers/__tests__/lib/queue/fixtures/agent_message.sql` is een letterlijke kopie van
  de **Ops-dashboard**-migratie. Na de cutover draait workers op de Scrum4Me-tabel en moet die
  fixture opnieuw gekopieerd worden — vanaf `Scrum4Me/prisma/migrations/20260716113110_*`.
- De twee `pending` vragen aan `mac:jp` (ops-agent config drift, compose project-name collisions)
  staan er sinds 2026-07-23 en verhuizen mee. Ze wachten op JP, niet op de cutover.
