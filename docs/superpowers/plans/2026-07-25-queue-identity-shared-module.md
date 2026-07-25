# Queue-identity als gedeelde module — implementatieplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Het adres- en statusvocabulaire van de s4m-queue krijgt één gedeelde definitie in `scrum4me-shared`, met een test die rood wordt als het uiteenloopt met de gedeployde DDL.

**Architecture:** Nieuwe pure-TS module `scrum4me-shared/lib/queue-identity.ts` met de gesloten woordenlijsten die de DB via CHECK-constraints afdwingt. `scrum4me-workers` re-exporteert hem onder zijn bestaande namen (nul call-site-wijzigingen); het fase-2-plan van `scrum4me-mcp` gaat hem direct importeren. `Scrum4Me` krijgt de pariteitstest tussen shared en `migration.sql`. `s4m-queue` blijft een bewuste tweelingkopie.

**Tech Stack:** TypeScript, vitest, git submodules, Forgejo REST (PR's).

**Spec:** [`docs/superpowers/specs/2026-07-25-queue-identity-shared-module-design.md`](../specs/2026-07-25-queue-identity-shared-module-design.md)

---

## Belangrijk voor de uitvoerder

**Vier repos, vaste volgorde, harde afhankelijkheid.** Elke repo pint `scrum4me-shared` op een
commit-SHA. Taak 2, 3 en 4 kunnen pas beginnen als de PR van taak 1 **gemerged** is en je de
nieuwe main-SHA hebt. Na elke taak volgt een **HARDSTOP**: jij opent de PR, JP merget. Ga niet
zelf mergen en ga niet door naar de volgende taak vóór de merge.

**Importstijl verschilt per repo — dit is geen slordigheid maar bestaand feit:**

| Repo | Import |
|---|---|
| `scrum4me-shared` (eigen tests) | `from '../lib/queue-identity'` |
| `Scrum4Me` | `from '@shared/queue-identity'` (géén `.js`) |
| `scrum4me-workers` | `from '@shared/queue-identity'` (géén `.js`) |
| `scrum4me-mcp` | `from '@shared/queue-identity.js'` (**mét** `.js`) |

Gebruik de verkeerde vorm en de build faalt. Controleer bij twijfel een bestaande import in
diezelfde repo (`git grep "from '@shared/"`).

**Forgejo-PR's** gaan via de REST-API, nooit via `gh` of `tea pr create`. De token staat in
`$FORGEJO_TOKEN` (uit `~/.zshenv`); geef hem door via `curl --config` met process-substitution
zodat hij niet in `argv` belandt. **Print de waarde nooit.**

**Werk in een branch, niet op main.** Elke repo krijgt branch `feat/queue-identity-shared`.

---

## Bestandsoverzicht

| Repo | Bestand | Actie |
|---|---|---|
| `scrum4me-shared` | `lib/queue-identity.ts` | **nieuw** — de gedeelde woordenlijsten + guards |
| `scrum4me-shared` | `__tests__/queue-identity.test.ts` | **nieuw** — interne consistentie |
| `Scrum4Me` | `vendor/scrum4me-shared` | gitlink → nieuwe SHA |
| `Scrum4Me` | `__tests__/db/agent-message-queue-migration.test.ts` | uitbreiden — pariteit DDL ↔ shared |
| `scrum4me-workers` | `vendor/scrum4me-shared` | gitlink → nieuwe SHA |
| `scrum4me-workers` | `lib/queue/types.ts` | vocabulaire vervangen door re-exports; `AgentMessage.source` wordt `QueueSource` |
| `scrum4me-mcp` | `vendor/scrum4me-shared` | gitlink → nieuwe SHA |
| `scrum4me-mcp` | `docs/superpowers/plans/2026-07-12-s4m-queue-fase2-mcp-kernset.md` | fase-2 Task 1, 2, 3, 6, 10, 11 en 13 aanpassen — zes code-blokken importeren vocabulaire |
| `s4m-queue` | `src/types.ts` | header-comment: bewuste tweelingkopie (géén gedragswijziging) |

---

## Task 1: `scrum4me-shared` — de module

**Files:**
- Create: `~/Development/scrum4me-shared/lib/queue-identity.ts`
- Create: `~/Development/scrum4me-shared/__tests__/queue-identity.test.ts`

- [ ] **Step 1: Maak de branch**

```bash
cd ~/Development/scrum4me-shared
git fetch origin
git checkout -b feat/queue-identity-shared origin/main
```

- [ ] **Step 2: Schrijf de falende test**

Maak `__tests__/queue-identity.test.ts` met exact deze inhoud:

```ts
import { describe, expect, it } from 'vitest'

import {
  QUEUE_MODELS,
  QUEUE_REPLY_TYPE,
  QUEUE_REQUEST_TYPES,
  QUEUE_RESPONSE_TYPES,
  QUEUE_SERVERS,
  QUEUE_SOURCES,
  QUEUE_STATUSES,
  QUEUE_TERMINAL_STATUSES,
  isQueueModel,
  isQueueRequestType,
  isQueueServer,
  queueReplyTypeFor,
} from '../lib/queue-identity'

describe('queue-identity', () => {
  it('mapt elk request-type op precies één bestaand antwoord-type', () => {
    // Uitputtend in beide richtingen: een nieuw request-type zonder mapping
    // valt hier door, en een mapping naar een niet-bestaand antwoord-type ook.
    expect(Object.keys(QUEUE_REPLY_TYPE).sort()).toEqual([...QUEUE_REQUEST_TYPES].sort())
    for (const type of QUEUE_REQUEST_TYPES) {
      expect(QUEUE_RESPONSE_TYPES).toContain(queueReplyTypeFor(type))
    }
  })

  it('geeft elk request-type een eigen antwoord-type', () => {
    // Twee requests die op hetzelfde antwoord-type mappen maken een reply
    // onherleidbaar tot zijn verzoek.
    const replies = QUEUE_REQUEST_TYPES.map(queueReplyTypeFor)
    expect(new Set(replies).size).toBe(QUEUE_REQUEST_TYPES.length)
  })

  it('houdt request- en response-types disjunct', () => {
    const overlap = QUEUE_REQUEST_TYPES.filter((t) =>
      (QUEUE_RESPONSE_TYPES as readonly string[]).includes(t),
    )
    expect(overlap).toEqual([])
  })

  it('houdt de terminale statussen binnen de statuslijst', () => {
    for (const status of QUEUE_TERMINAL_STATUSES) {
      expect(QUEUE_STATUSES).toContain(status)
    }
    // pending en claimed zijn per definitie niet terminaal; staan ze er wel in,
    // dan zou een sweep lopende berichten opruimen.
    expect(QUEUE_TERMINAL_STATUSES).not.toContain('pending')
    expect(QUEUE_TERMINAL_STATUSES).not.toContain('claimed')
  })

  it('accepteert elk lid en weigert bijna-treffers', () => {
    for (const s of QUEUE_SERVERS) expect(isQueueServer(s)).toBe(true)
    for (const m of QUEUE_MODELS) expect(isQueueModel(m)).toBe(true)
    for (const t of QUEUE_REQUEST_TYPES) expect(isQueueRequestType(t)).toBe(true)

    expect(isQueueModel('Claude')).toBe(false) // hoofdletter
    expect(isQueueModel('claude ')).toBe(false) // spatie
    expect(isQueueModel('')).toBe(false)
    expect(isQueueServer('mac2')).toBe(false) // prefix van een geldig lid
    expect(isQueueRequestType('result')).toBe(false) // response, geen request
  })

  it('bevat geen duplicaten in de woordenlijsten', () => {
    const lists = [
      ['QUEUE_SERVERS', QUEUE_SERVERS],
      ['QUEUE_MODELS', QUEUE_MODELS],
      ['QUEUE_REQUEST_TYPES', QUEUE_REQUEST_TYPES],
      ['QUEUE_RESPONSE_TYPES', QUEUE_RESPONSE_TYPES],
      ['QUEUE_STATUSES', QUEUE_STATUSES],
      ['QUEUE_SOURCES', QUEUE_SOURCES],
    ] as const
    for (const [name, list] of lists) {
      expect(new Set(list).size, `${name} bevat een duplicaat`).toBe(list.length)
    }
  })
})
```

- [ ] **Step 3: Draai de test en verifieer dat hij faalt**

```bash
cd ~/Development/scrum4me-shared && npx vitest run __tests__/queue-identity.test.ts
```

Verwacht: FAIL — `Failed to resolve import "../lib/queue-identity"`.

- [ ] **Step 4: Schrijf de module**

Maak `lib/queue-identity.ts` met exact deze inhoud:

```ts
// Gedeeld adres- en statusvocabulaire van de s4m-queue (`agent_message`).
//
// Dit zijn de gesloten woordenlijsten die de DB óók afdwingt via CHECK-
// constraints — zie Scrum4Me/prisma/migrations/
// 20260716113110_add_agent_message_queue_tables/migration.sql. De pariteit
// tussen dit bestand en die DDL wordt bewaakt door
// Scrum4Me/__tests__/db/agent-message-queue-migration.test.ts.
//
// LET OP: s4m-queue/src/types.ts houdt hier een bewuste eigen kopie van. Die
// repo draagt geen submodule (kale tsc + dist-deploy op drie hosts), dus een
// wijziging hier moet dáár ook landen. Voor `to_server`/`to_model` bestaat
// géén CHECK in de DB, dus die divergentie wordt door niets automatisch
// gevangen. Zie scrum4me-mcp/docs/superpowers/specs/
// 2026-07-25-queue-identity-shared-module-design.md §7.

export const QUEUE_SERVERS = ['mac', 'scrum4me-server', 'max2'] as const
export const QUEUE_MODELS = ['claude', 'codex', 'jp'] as const
export const QUEUE_REQUEST_TYPES = ['task', 'info', 'review_request'] as const
export const QUEUE_RESPONSE_TYPES = ['result', 'data', 'reviewed'] as const
export const QUEUE_STATUSES = ['pending', 'claimed', 'done', 'failed', 'cancelled'] as const
export const QUEUE_SOURCES = ['cli', 'dashboard', 'mcp'] as const

export type QueueServer = (typeof QUEUE_SERVERS)[number]
export type QueueModel = (typeof QUEUE_MODELS)[number]
export type QueueRequestType = (typeof QUEUE_REQUEST_TYPES)[number]
export type QueueResponseType = (typeof QUEUE_RESPONSE_TYPES)[number]
export type QueueMessageType = QueueRequestType | QueueResponseType
export type QueueStatus = (typeof QUEUE_STATUSES)[number]
export type QueueSource = (typeof QUEUE_SOURCES)[number]

// Expliciet getypeerd als QueueStatus[] in plaats van `as const`: zo dwingt de
// compiler af dat elk lid ook echt een status is. De overige lijsten gebruiken
// juist `as const` zodat lijst en type niet uit elkaar kunnen lopen.
export const QUEUE_TERMINAL_STATUSES: readonly QueueStatus[] = ['done', 'failed', 'cancelled']

/** Elk verzoek-type heeft precies één antwoord-type. */
export const QUEUE_REPLY_TYPE: Record<QueueRequestType, QueueResponseType> = {
  task: 'result',
  info: 'data',
  review_request: 'reviewed',
}

export function isQueueServer(value: string): value is QueueServer {
  return (QUEUE_SERVERS as readonly string[]).includes(value)
}

export function isQueueModel(value: string): value is QueueModel {
  return (QUEUE_MODELS as readonly string[]).includes(value)
}

export function isQueueRequestType(value: string): value is QueueRequestType {
  return (QUEUE_REQUEST_TYPES as readonly string[]).includes(value)
}

export function queueReplyTypeFor(type: QueueRequestType): QueueResponseType {
  return QUEUE_REPLY_TYPE[type]
}
```

- [ ] **Step 5: Draai de test en verifieer dat hij slaagt**

```bash
cd ~/Development/scrum4me-shared && npx vitest run __tests__/queue-identity.test.ts
```

Verwacht: PASS, 6 tests.

- [ ] **Step 6: Bewijs dat de tests rood kúnnen worden**

Voor elke assertie wil je bewijs dat hij iets vangt. Voer deze vier mutaties één
voor één uit in `lib/queue-identity.ts`, draai de test, en **draai de wijziging
daarna terug**:

| Mutatie | Verwacht rood |
|---|---|
| Haal `review_request: 'reviewed'` uit `QUEUE_REPLY_TYPE` | mapping-test (uitputtendheid) |
| Zet `info: 'result'` in `QUEUE_REPLY_TYPE` | eigen-antwoord-type-test |
| Voeg `'pending'` toe aan `QUEUE_TERMINAL_STATUSES` | terminale-statussen-test |
| Voeg `'claude'` een tweede keer toe aan `QUEUE_MODELS` | duplicaten-test |

Als een mutatie géén rood geeft, is die assertie waardeloos — repareer hem
voordat je verdergaat.

- [ ] **Step 7: Draai de volledige verificatie**

```bash
cd ~/Development/scrum4me-shared && npm run verify
```

Verwacht: `OK: lib/ is dep-clean`, daarna typecheck zonder fouten en alle tests groen.
Faalt de dep-gate, dan heb je per ongeluk een import toegevoegd — `queue-identity.ts`
hoort er nul te hebben.

- [ ] **Step 8: Commit**

```bash
cd ~/Development/scrum4me-shared
git add lib/queue-identity.ts __tests__/queue-identity.test.ts
git commit -m "feat(queue): gedeeld adres- en statusvocabulaire van de s4m-queue

De woordenlijsten van agent_message stonden met de hand gekopieerd in
s4m-queue en scrum4me-workers, en het fase-2-plan van scrum4me-mcp voegde
een derde kopie toe. Deze module wordt de bron voor de twee repos die een
submodule dragen; de CLI houdt een bewuste, gedocumenteerde tweelingkopie.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin feat/queue-identity-shared
```

- [ ] **Step 9: Open de PR**

```bash
curl --config <(printf 'header = "Authorization: token %s"\n' "$FORGEJO_TOKEN") \
  -sS -X POST 'https://git.jp-visser.nl/api/v1/repos/janpeter/scrum4me-shared/pulls' \
  -H 'Content-Type: application/json' \
  -d '{"head":"feat/queue-identity-shared","base":"main","title":"feat(queue): gedeeld adres- en statusvocabulaire van de s4m-queue","body":"Spec: scrum4me-mcp docs/superpowers/specs/2026-07-25-queue-identity-shared-module-design.md\n\nEerste van vier PRs. De consumers (Scrum4Me, workers, mcp) pinnen hierna op de nieuwe main-SHA.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"}'
```

- [ ] **Step 10: HARDSTOP — wacht op de merge**

Meld JP het PR-nummer. **Ga niet verder** tot de PR gemerged is. Noteer daarna de
nieuwe main-SHA — taak 2, 3 en 4 hebben hem nodig:

```bash
cd ~/Development/scrum4me-shared && git fetch origin && git rev-parse origin/main
```

---

## Task 2: `Scrum4Me` — pariteit tussen DDL en shared

**Files:**
- Modify: `~/Development/Scrum4Me/vendor/scrum4me-shared` (gitlink)
- Modify: `~/Development/Scrum4Me/__tests__/db/agent-message-queue-migration.test.ts`

Deze taak eerst, vóór de consumers: hij bewijst dát het vocabulaire klopt. Faalt hij,
dan wil je dat weten voordat twee repos het overnemen.

- [ ] **Step 1: Maak de branch en bump de submodule**

Vervang `<SHARED_SHA>` door de SHA uit taak 1, stap 10.

```bash
cd ~/Development/Scrum4Me
git fetch origin
git checkout -b feat/queue-identity-shared origin/main
git -C vendor/scrum4me-shared fetch origin
git -C vendor/scrum4me-shared checkout <SHARED_SHA>
git add vendor/scrum4me-shared
```

- [ ] **Step 2: Controleer dat de module bereikbaar is**

```bash
cd ~/Development/Scrum4Me && ls vendor/scrum4me-shared/lib/queue-identity.ts
```

Verwacht: het pad wordt geprint. Krijg je "No such file", dan staat de submodule op
de verkeerde SHA — herhaal stap 1.

- [ ] **Step 3: Schrijf de falende test**

Voeg in `__tests__/db/agent-message-queue-migration.test.ts` de import toe bovenaan,
ná de bestaande imports:

```ts
import {
  QUEUE_REQUEST_TYPES,
  QUEUE_RESPONSE_TYPES,
  QUEUE_SOURCES,
  QUEUE_STATUSES,
} from '@shared/queue-identity'
```

Voeg daarna deze helper toe, direct ná de bestaande functie `columnsOf`:

```ts
/**
 * De waarden uit een `CHECK (<kolom> IN ('a','b',…))` in de migratie-SQL.
 *
 * Eist precies één treffer: nul treffers zou een lege lijst opleveren en de
 * vergelijking hieronder vals groen maken, en een tweede CHECK op dezelfde
 * kolom zou stilzwijgend genegeerd worden. De CONSTRAINT-vorm
 * (`CHECK (\n  (type IN (…)) = …`) matcht niet — die heeft een haakje vóór de
 * kolomnaam — en dat is precies de bedoeling.
 */
function checkValuesOf(column: string): string[] {
  const matches = [...sql.matchAll(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`, 'g'))]
  expect(matches, `verwacht precies één CHECK (${column} IN (…)) in migration.sql`).toHaveLength(1)
  return matches[0][1].split(',').map((value) => value.trim().replace(/^'|'$/g, ''))
}
```

Voeg tot slot dit blok toe binnen de bestaande `describe(...)`, ná de laatste `it`:

```ts
  // Pariteit met scrum4me-shared/lib/queue-identity.ts. Een toegepaste migratie
  // is immutable, dus deze tests kunnen in de praktijk maar één kant op falen:
  // iemand heeft het gedeelde vocabulaire uitgebreid zonder een nieuwe migratie
  // te schrijven. Dat is precies het geval dat we willen vangen — de DB zou de
  // nieuwe waarde weigeren en de fout pas op runtime zichtbaar maken.
  //
  // Alleen type, status en source staan hier: from_server/from_model/to_server/
  // to_model zijn `text NOT NULL` zónder CHECK, dus er is geen DDL om
  // QUEUE_SERVERS en QUEUE_MODELS tegen te toetsen.
  describe('pariteit met het gedeelde vocabulaire', () => {
    it('dekt de type-CHECK precies met requests + responses', () => {
      expect(checkValuesOf('type').sort()).toEqual(
        [...QUEUE_REQUEST_TYPES, ...QUEUE_RESPONSE_TYPES].sort(),
      )
    })

    it('dekt de status-CHECK precies met QUEUE_STATUSES', () => {
      expect(checkValuesOf('status').sort()).toEqual([...QUEUE_STATUSES].sort())
    })

    it('dekt de source-CHECK precies met QUEUE_SOURCES', () => {
      // Dit is de assertie die de drift ving waarmee deze hele wijziging begon:
      // beide TS-kopieën typeerden source als 'cli' | 'dashboard' terwijl de
      // gedeployde CHECK 'mcp' toestaat en fase 2 die waarde gaat schrijven.
      expect(checkValuesOf('source').sort()).toEqual([...QUEUE_SOURCES].sort())
    })

    it('laat servers en modellen ongemoeid — die hebben geen CHECK', () => {
      // Documenteert de grens van deze gate. Verschijnt hier ooit wél een CHECK,
      // dan valt deze test om en hoort er een pariteitstest bij te komen.
      expect(sql).not.toMatch(/CHECK \(to_model IN/)
      expect(sql).not.toMatch(/CHECK \(to_server IN/)
    })
  })
```

- [ ] **Step 4: Draai de test en verifieer dat hij slaagt**

```bash
cd ~/Development/Scrum4Me && npx vitest run __tests__/db/agent-message-queue-migration.test.ts
```

Verwacht: PASS — de bestaande tests plus vier nieuwe.

Faalt de `source`-test hier al, dan wijkt `QUEUE_SOURCES` af van de DDL en heb je
in taak 1 iets anders geschreven dan `['cli', 'dashboard', 'mcp']`.

- [ ] **Step 5: Bewijs dat de pariteitstest rood wordt**

De test moet falen bij een wijziging in shared, niet alleen in de SQL. Simuleer dat:

```bash
cd ~/Development/Scrum4Me
sed -i '' "s/'cli', 'dashboard', 'mcp'/'cli', 'dashboard', 'mcp', 'kimi'/" vendor/scrum4me-shared/lib/queue-identity.ts
npx vitest run __tests__/db/agent-message-queue-migration.test.ts
```

Verwacht: FAIL op "dekt de source-CHECK precies met QUEUE_SOURCES".

Draai daarna terug — de submodule moet schoon zijn:

```bash
git -C vendor/scrum4me-shared checkout -- lib/queue-identity.ts
git -C vendor/scrum4me-shared status --short
```

Verwacht: lege output.

- [ ] **Step 6: Draai de volledige testsuite**

```bash
cd ~/Development/Scrum4Me && npx vitest run __tests__/db/
```

Verwacht: alle DB-tests groen. Deze tests lezen alleen bestanden — er wordt geen
database aangeraakt.

- [ ] **Step 7: Commit en push**

```bash
cd ~/Development/Scrum4Me
git add vendor/scrum4me-shared __tests__/db/agent-message-queue-migration.test.ts
git commit -m "test(db): pariteit tussen agent_message-CHECKs en het gedeelde vocabulaire

Bumpt vendor/scrum4me-shared en toetst de type-, status- en source-CHECK
uit de migratie tegen scrum4me-shared/lib/queue-identity.ts. Servers en
modellen vallen erbuiten: die kolommen dragen geen CHECK.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin feat/queue-identity-shared
```

- [ ] **Step 8: Open de PR**

```bash
curl --config <(printf 'header = "Authorization: token %s"\n' "$FORGEJO_TOKEN") \
  -sS -X POST 'https://git.jp-visser.nl/api/v1/repos/janpeter/Scrum4Me/pulls' \
  -H 'Content-Type: application/json' \
  -d '{"head":"feat/queue-identity-shared","base":"main","title":"test(db): pariteit tussen agent_message-CHECKs en het gedeelde vocabulaire","body":"Spec: scrum4me-mcp docs/superpowers/specs/2026-07-25-queue-identity-shared-module-design.md\n\nTweede van vier PRs. Geen migratie, geen DB-wijziging — alleen een submodule-bump en een string-assert-test op de bestaande migration.sql.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"}'
```

- [ ] **Step 9: HARDSTOP — wacht op de merge**

---

## Task 3: `scrum4me-workers` — re-exports en de source-fix

**Files:**
- Modify: `~/Development/scrum4me-workers/vendor/scrum4me-shared` (gitlink)
- Modify: `~/Development/scrum4me-workers/lib/queue/types.ts`

- [ ] **Step 1: Maak de branch en bump de submodule**

```bash
cd ~/Development/scrum4me-workers
git fetch origin
git checkout -b feat/queue-identity-shared origin/main
git -C vendor/scrum4me-shared fetch origin
git -C vendor/scrum4me-shared checkout <SHARED_SHA>
git add vendor/scrum4me-shared
ls vendor/scrum4me-shared/lib/queue-identity.ts
```

Verwacht: het pad wordt geprint.

- [ ] **Step 2: Leg de baseline vast**

Vóór je iets wijzigt — je moet weten wat er al groen was:

```bash
cd ~/Development/scrum4me-workers && npm run typecheck && npx vitest run __tests__/app/queue-messages-view.test.tsx
```

Verwacht: typecheck schoon, tests groen. Is dit rood, **stop** en meld het —
dan is het geen gevolg van deze wijziging.

- [ ] **Step 3: Vervang de kop van `lib/queue/types.ts`**

Vervang alles vanaf regel 1 tot en met de regel `export type Status = (typeof STATUSES)[number]`
door:

```ts
// Types voor de cross-agent queue (`agent_message`) in de workers-app.
//
// Het adres- en statusvocabulaire komt uit scrum4me-shared/lib/queue-identity.ts;
// hier staan alleen de workers-eigen vormen (rij-shape, NOTIFY-envelope,
// retentie) en het meta.task-contract. De aliassen hieronder houden de vijf
// bestaande importers ongewijzigd.
//
// Zie scrum4me-mcp/docs/superpowers/specs/
// 2026-07-25-queue-identity-shared-module-design.md §6.2.

import type {
  QueueMessageType,
  QueueModel,
  QueueServer,
  QueueSource,
  QueueStatus,
} from '@shared/queue-identity'

export {
  QUEUE_SERVERS as SERVERS,
  QUEUE_MODELS as MODELS,
  QUEUE_REQUEST_TYPES as REQUEST_TYPES,
  QUEUE_RESPONSE_TYPES as RESPONSE_TYPES,
  QUEUE_STATUSES as STATUSES,
  QUEUE_SOURCES as SOURCES,
  isQueueServer as isServer,
  isQueueModel as isModel,
  isQueueRequestType as isRequestType,
  queueReplyTypeFor as replyTypeFor,
} from '@shared/queue-identity'

export type {
  QueueServer as Server,
  QueueModel as Model,
  QueueRequestType as RequestType,
  QueueResponseType as ResponseType,
  QueueMessageType as MessageType,
  QueueStatus as Status,
  QueueSource as Source,
} from '@shared/queue-identity'
```

- [ ] **Step 4: Verwijder de lokale definities die nu uit shared komen**

Verwijder verderop in hetzelfde bestand:

- de `const REPLY_TYPE: Record<RequestType, ResponseType> = { … }`
- de functie `replyTypeFor`
- de functies `isRequestType`, `isServer`, `isModel`

`CHANNEL`, `STALE_CLAIM_INTERVAL`, `MESSAGE_RETENTION_DAYS`, `MessageRetentionPreview`,
`MessageRetentionPurge`, `AgentMessage`, `NotifyEnvelope`, `TaskMeta` en
`validateTaskMeta` blijven **staan**.

- [ ] **Step 5: Zet de lokale typeverwijzingen om**

In `interface AgentMessage` en `interface NotifyEnvelope` verwijzen de velden nu naar
lokale namen die niet meer bestaan. Vervang ze:

| Was | Wordt |
|---|---|
| `type: MessageType` | `type: QueueMessageType` |
| `from_server: Server` / `to_server: Server` | `QueueServer` |
| `from_model: Model` / `to_model: Model` | `QueueModel` |
| `status: Status` / `status?: Status` / `previous_status?: Status \| null` | `QueueStatus` |
| `source: 'cli' \| 'dashboard'` | `source: QueueSource` |

Die laatste is de eigenlijke fix: `QueueSource` bevat `'mcp'`, wat de gedeployde
CHECK al toestaat en wat fase 2 gaat schrijven.

- [ ] **Step 6: Typecheck**

```bash
cd ~/Development/scrum4me-workers && npm run typecheck
```

Verwacht: schoon. Krijg je `Cannot find module '@shared/queue-identity'`, controleer
dan of je `.js` hebt toegevoegd — in workers hoort die er **niet** aan.

- [ ] **Step 7: Draai de tests**

```bash
cd ~/Development/scrum4me-workers && npx vitest run __tests__/app/queue-messages-view.test.tsx __tests__/lib/queue/ops-db-cancel.test.ts __tests__/lib/queue/ops-db-retention.test.ts
```

Verwacht: groen, hetzelfde aantal als in de baseline van stap 2.

`__tests__/lib/queue/ops-db-realdb.test.ts` heeft een echte database nodig en valt
buiten deze taak; draai hem alleen als je een test-DB bij de hand hebt en gebruik
**nooit** een productie-connection-string.

- [ ] **Step 8: Bewijs dat de re-export echt uit shared komt**

```bash
cd ~/Development/scrum4me-workers
grep -n "claude" vendor/scrum4me-shared/lib/queue-identity.ts
grep -c "'claude'" lib/queue/types.ts
```

Verwacht: de eerste toont de lijst in shared; de tweede print `0`. Staat er nog een
literal in `lib/queue/types.ts`, dan is er een kopie blijven staan.

- [ ] **Step 9: Commit, push, PR**

```bash
cd ~/Development/scrum4me-workers
git add vendor/scrum4me-shared lib/queue/types.ts
git commit -m "refactor(queue): vocabulaire uit scrum4me-shared, source krijgt mcp

lib/queue/types.ts re-exporteert het adres- en statusvocabulaire onder zijn
bestaande namen, zodat de vijf importers ongewijzigd blijven. AgentMessage.source
was 'cli' | 'dashboard' terwijl de gedeployde CHECK 'mcp' toestaat; dat is nu
QueueSource.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin feat/queue-identity-shared

curl --config <(printf 'header = "Authorization: token %s"\n' "$FORGEJO_TOKEN") \
  -sS -X POST 'https://git.jp-visser.nl/api/v1/repos/janpeter/scrum4me-workers/pulls' \
  -H 'Content-Type: application/json' \
  -d '{"head":"feat/queue-identity-shared","base":"main","title":"refactor(queue): vocabulaire uit scrum4me-shared, source krijgt mcp","body":"Spec: scrum4me-mcp docs/superpowers/specs/2026-07-25-queue-identity-shared-module-design.md\n\nDerde van vier PRs. Geen call-site wijzigt: lib/queue/types.ts re-exporteert onder de bestaande namen.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"}'
```

- [ ] **Step 10: HARDSTOP — wacht op de merge**

---

## Task 4: `scrum4me-mcp` — submodule-bump en planaanpassing

**Files:**
- Modify: `~/Development/scrum4me-mcp/vendor/scrum4me-shared` (gitlink)
- Modify: `docs/superpowers/plans/2026-07-12-s4m-queue-fase2-mcp-kernset.md`

Fase 2 is nog niet uitgevoerd; deze taak past het plan aan, geen code.

- [ ] **Step 1: Controleer de blokkade**

Er loopt een achtergrondtaak die deze submodule op `ab6e97b` pint — een commit op
branch `chore/canonical-drop-datasource-url`, **niet op main**.

```bash
cd ~/Development/scrum4me-mcp && git ls-tree origin/main vendor/scrum4me-shared
```

Is de SHA `ab6e97b…`, dan is die taak gemerged. Zet de pin dan alsnog op
`<SHARED_SHA>` en meld JP expliciet dat die andere wijziging daarmee uit de
gitlink verdwijnt — dat is een besluit voor JP, niet voor jou.

- [ ] **Step 2: Maak de branch en bump de submodule**

```bash
cd ~/Development/scrum4me-mcp
git fetch origin
git checkout -b feat/queue-identity-shared origin/main
git -C vendor/scrum4me-shared fetch origin
git -C vendor/scrum4me-shared checkout <SHARED_SHA>
git add vendor/scrum4me-shared
ls vendor/scrum4me-shared/lib/queue-identity.ts
```

- [ ] **Step 3: Regenereer het Prisma-schema en typecheck**

De bump haalt 12 commits binnen, waaronder de `AgentMessage`-modellen uit fase 1.

```bash
cd ~/Development/scrum4me-mcp && npm run prisma:generate && npm run typecheck
```

Verwacht: schema gegenereerd, typecheck schoon.

- [ ] **Step 4: Pas Task 1 van het fase-2-plan aan**

In `docs/superpowers/plans/2026-07-12-s4m-queue-fase2-mcp-kernset.md`, sectie
`### Task 1: Fase-1-dependency — vendor-bump + schema-sync (AgentMessage)`: voeg
onderaan de sectie toe:

```markdown
> **Uitgevoerd op 2026-07-25** als onderdeel van
> `docs/superpowers/plans/2026-07-25-queue-identity-shared-module.md` taak 4.
> De bump bracht naast de `AgentMessage`-modellen ook
> `@shared/queue-identity.js` mee, die Task 2 en 3 hieronder gebruiken.
```

- [ ] **Step 5: Krimp `src/queue/types.ts` in fase-2 Task 2**

In sectie `### Task 2: src/queue/types.ts — CLI-typevocabulaire + validateTaskMeta-port`:
vervang in het code-blok van `src/queue/types.ts` de kop-comment, de zes `export type`-regels,
de vijf `export const`-lijsten en `REPLY_TYPE` door:

```ts
// mcp-eigen aanvullingen op het gedeelde queue-vocabulaire. Het vocabulaire
// zelf (servers, modellen, types, statussen, sources, reply-mapping en de
// guards) komt uit scrum4me-shared/lib/queue-identity.ts en wordt hier
// bewust NIET opnieuw ge-exporteerd: elke plek importeert het rechtstreeks,
// zodat de herkomst per bestand leesbaar blijft.

import type { QueueModel, QueueRequestType, QueueServer } from '@shared/queue-identity.js'

export interface QueueAddress {
  server: QueueServer
  model: QueueModel
}

export function requiresTaskMeta(t: QueueRequestType): boolean {
  return t === 'task' || t === 'review_request'
}
```

`QueueTaskMeta`, `REQUIRED_TASK_META` en `validateTaskMeta` blijven in dat blok staan,
woordelijk ongewijzigd — inclusief de `VALIDATION_ERROR:`-prefixen.

- [ ] **Step 6: Krimp de test van fase-2 Task 2**

In dezelfde sectie staat `__tests__/queue-types.test.ts`. De eerste twee `it`-blokken
(`'mapt request-types op de juiste reply-types'` en `'kent de vaste type- en
statusvocabulaires'`) en het `it('herkent request-types', …)`-blok testen nu vocabulaire
dat in shared woont en daar al gedekt is. Verwijder die drie blokken en pas de import aan:

```ts
import { describe, it, expect } from 'vitest'
import { requiresTaskMeta, validateTaskMeta } from '../src/queue/types.js'
```

Werk ook de aantallen in die sectie bij: de stap zegt nu "8 tests groen", dat worden er 5.

- [ ] **Step 7: Zet alle importplekken in het fase-2-plan om**

Zes code-blokken importeren vocabulaire uit `queue/types.js`. Vervang ze exact zo —
regelnummers zijn die van vóór jouw wijzigingen, dus werk van onder naar boven:

| Regel | Was | Wordt |
|---|---|---|
| 3002 | `import { REQUEST_TYPES, type QueueAddress } from '../queue/types.js'` | `import { QUEUE_REQUEST_TYPES } from '@shared/queue-identity.js'`<br>`import type { QueueAddress } from '../queue/types.js'` |
| 2407 | `import { TERMINAL_STATUSES } from '../queue/types.js'` | `import { QUEUE_TERMINAL_STATUSES } from '@shared/queue-identity.js'` |
| 2145 | `import { REPLY_TYPE, TERMINAL_STATUSES, isRequestType } from '../queue/types.js'` | `import { QUEUE_REPLY_TYPE, QUEUE_TERMINAL_STATUSES, isQueueRequestType } from '@shared/queue-identity.js'` |
| 793 | `import { REQUEST_TYPES, RESPONSE_TYPES, type QueueModel, type QueueServer } from './types.js'` | `import { QUEUE_REQUEST_TYPES, QUEUE_RESPONSE_TYPES, type QueueModel, type QueueServer } from '@shared/queue-identity.js'` |
| 287 | `import { MODELS, SERVERS, type QueueAddress, type QueueModel, type QueueServer } from './types.js'` | `import { QUEUE_MODELS, QUEUE_SERVERS, type QueueModel, type QueueServer } from '@shared/queue-identity.js'`<br>`import type { QueueAddress } from './types.js'` |
| 73 | (de test — al gedaan in stap 6) | — |

Vervang daarna in de **body** van diezelfde code-blokken elk gebruik van de oude naam:

| Oud | Nieuw |
|---|---|
| `MODELS` | `QUEUE_MODELS` |
| `SERVERS` | `QUEUE_SERVERS` |
| `REQUEST_TYPES` | `QUEUE_REQUEST_TYPES` |
| `RESPONSE_TYPES` | `QUEUE_RESPONSE_TYPES` |
| `TERMINAL_STATUSES` | `QUEUE_TERMINAL_STATUSES` |
| `REPLY_TYPE` | `QUEUE_REPLY_TYPE` |
| `isRequestType` | `isQueueRequestType` |

Dat geldt óók voor de `.join(', ')` in de foutteksten van `QUEUE_IDENTITY_REQUIRED` en
`VALIDATION_ERROR`. **De foutteksten zelf blijven woordelijk gelijk** — alleen de
variabelenaam die de lijst oplevert verandert.

`requiresTaskMeta` en `validateTaskMeta` (regel 1358) en `type QueueAddress` (regel 2689)
blijven uit `../queue/types.js` komen — die zijn mcp-eigen.

- [ ] **Step 8: Verifieer dat er geen losse eindjes in het plan staan**

```bash
cd ~/Development/scrum4me-mcp
grep -n "MODELS\|SERVERS\|REQUEST_TYPES\|RESPONSE_TYPES\|TERMINAL_STATUSES\|REPLY_TYPE" \
  docs/superpowers/plans/2026-07-12-s4m-queue-fase2-mcp-kernset.md | grep -v QUEUE_
```

Verwacht: geen treffers binnen ```` ```ts ````-blokken. Treffers in proza die de oude
situatie beschrijven zijn prima; een treffer in een code-blok is een gemiste plek.

Controleer daarnaast dat er geen import van vocabulaire uit `types.js` is blijven staan:

```bash
grep -n "from '\.\./queue/types.js'\|from '\./types.js'" \
  docs/superpowers/plans/2026-07-12-s4m-queue-fase2-mcp-kernset.md
```

Verwacht: alleen regels die `QueueAddress`, `requiresTaskMeta` of `validateTaskMeta`
importeren.

- [ ] **Step 9: Commit, push, PR**

```bash
cd ~/Development/scrum4me-mcp
git add vendor/scrum4me-shared docs/superpowers/plans/2026-07-12-s4m-queue-fase2-mcp-kernset.md
git commit -m "chore(queue): bump shared + fase-2-plan gebruikt @shared/queue-identity

De vendor-bump was al Task 1 van het fase-2-plan (nodig voor de AgentMessage-
modellen) en brengt nu ook queue-identity mee. Task 2 verliest zijn eigen
vocabulaire-blok, Task 3 importeert QUEUE_MODELS/QUEUE_SERVERS uit shared.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin feat/queue-identity-shared

curl --config <(printf 'header = "Authorization: token %s"\n' "$FORGEJO_TOKEN") \
  -sS -X POST 'https://git.jp-visser.nl/api/v1/repos/janpeter/scrum4me-mcp/pulls' \
  -H 'Content-Type: application/json' \
  -d '{"head":"feat/queue-identity-shared","base":"main","title":"chore(queue): bump shared + fase-2-plan gebruikt @shared/queue-identity","body":"Spec: docs/superpowers/specs/2026-07-25-queue-identity-shared-module-design.md\n\nVierde van vier PRs. Geen code — submodule-bump plus aanpassing van het nog niet uitgevoerde fase-2-plan.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"}'
```

- [ ] **Step 10: HARDSTOP — wacht op de merge**

---

## Task 5: `s4m-queue` — de tweelingkopie markeren

**Files:**
- Modify: `~/Development/s4m-queue/src/types.ts`

Geen gedragswijziging. Dit is de enige bewaking die `QUEUE_MODELS` en `QUEUE_SERVERS`
aan CLI-zijde hebben (spec §7): die kolommen dragen geen CHECK, dus de DB vangt
divergentie niet.

- [ ] **Step 1: Maak de branch**

```bash
cd ~/Development/s4m-queue
git fetch origin
git checkout -b docs/queue-identity-twin origin/main
```

- [ ] **Step 2: Voeg de header toe**

Zet bovenaan `src/types.ts`, vóór `export type Server`:

```ts
// BEWUSTE TWEELINGKOPIE van scrum4me-shared/lib/queue-identity.ts.
//
// Die module is de gedeelde definitie voor scrum4me-workers en scrum4me-mcp.
// Deze repo draagt geen submodule (kale tsc naar dist/, uitgerold als binary op
// mac, scrum4me-server en max2), dus het vocabulaire staat hier nog een keer.
//
// Wijzig je Server, Model, RequestType, ResponseType, Status of Source, doe het
// dan op BEIDE plekken. Voor type/status/source vangt de DB een verschil nog via
// een CHECK-constraint; voor Server en Model bestaat géén CHECK — daar wordt
// divergentie door niets automatisch gevangen en uit het zich als een adres dat
// de CLI weigert te versturen terwijl het dashboard het wél accepteert.
//
// Zie scrum4me-mcp/docs/superpowers/specs/
// 2026-07-25-queue-identity-shared-module-design.md §7.
```

- [ ] **Step 3: Verifieer dat er niets gedraaid is**

```bash
cd ~/Development/s4m-queue && npm run typecheck && npm test
```

Verwacht: schoon en groen — je hebt alleen een comment toegevoegd.

- [ ] **Step 4: Commit, push, PR**

```bash
cd ~/Development/s4m-queue
git add src/types.ts
git commit -m "docs(types): markeer het vocabulaire als bewuste tweelingkopie

scrum4me-shared/lib/queue-identity.ts is de gedeelde definitie voor de repos
met een submodule. Deze CLI heeft er geen, dus de kopie blijft — met een
expliciete instructie, want voor Server en Model bestaat geen CHECK die
divergentie vangt.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin docs/queue-identity-twin

curl --config <(printf 'header = "Authorization: token %s"\n' "$FORGEJO_TOKEN") \
  -sS -X POST 'https://git.jp-visser.nl/api/v1/repos/janpeter/s4m-queue/pulls' \
  -H 'Content-Type: application/json' \
  -d '{"head":"docs/queue-identity-twin","base":"main","title":"docs(types): markeer het vocabulaire als bewuste tweelingkopie","body":"Spec: scrum4me-mcp docs/superpowers/specs/2026-07-25-queue-identity-shared-module-design.md §7\n\nAlleen een comment; geen gedragswijziging.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"}'
```

- [ ] **Step 5: HARDSTOP — wacht op de merge**

---

## Na afloop

**Kimi toevoegen** is hierna: `'kimi'` bijzetten in `QUEUE_MODELS` (shared) én in
`MODELS`/`Model` (s4m-queue), plus de submodule-bumps in Scrum4Me, workers en mcp.
Vergeet je de CLI-kant, dan weigert de CLI het adres terwijl het dashboard het
accepteert — daarom bestaat de header uit taak 5.

**Niet in dit plan, wel bekend:**

- `scrum4me-workers/__tests__/lib/queue/fixtures/agent_message.sql` heeft
  `CHECK ("source" IN ('cli','dashboard'))` — zónder `'mcp'`. Dat is **correct**:
  de header van dat bestand zegt dat het een letterlijke kopie is van
  `Ops-dashboard/prisma/migrations/20260528233000_add_agent_message`, de tabel waar
  workers vandaag nog op draait. Bij de cutover (T-96) wijst workers naar de
  Scrum4Me-tabel en moet die fixture opnieuw gekopieerd worden — vanaf de
  Scrum4Me-migratie. Doe dat dáár, niet hier.
- `scrum4me-shared/lib/agent-runtime.ts` blijft ongemoeid. `normalizeAgentRuntime`
  maakt van elke onbekende waarde stilzwijgend `'CLAUDE'`; zodra Kimi jobs draait is
  dat een fout die zich voordoet als een geslaagde run. Aparte taak, aparte spec.
- `CHANNEL` en `STALE_CLAIM_INTERVAL` blijven gedupliceerd, inclusief het gegeven dat
  de CLI het kanaal uit `S4M_QUEUE_CHANNEL` leest terwijl workers en mcp `'agent_queue'`
  hardcoderen. Spec §4 en §10.
