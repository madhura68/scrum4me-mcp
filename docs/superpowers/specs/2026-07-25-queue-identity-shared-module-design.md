# Queue-identity als gedeelde module — design

**Datum:** 2026-07-25
**Status:** vastgesteld (JP akkoord 2026-07-25)
**Aanleiding:** Kimi wordt een derde AI-platform. Daardoor komt de vraag op tafel of het
adres- en statusvocabulaire van de s4m-queue nog langer met de hand gekopieerd moet worden.
**Raakt:** `scrum4me-shared`, `Scrum4Me`, `scrum4me-workers`, `scrum4me-mcp` (fase-2-plan).
**Raakt niet:** `s4m-queue` (bewust — zie §7).

---

## 1. Probleem

Het vocabulaire van `agent_message` — welke servers, welke modellen, welke types, statussen
en sources bestaan — is met de hand gekopieerd naar meerdere repos. Vandaag twee plekken in
code, met het fase-2-plan erbij drie:

| Plek | Wat |
|---|---|
| `s4m-queue/src/types.ts:2,10` | `Model`, `Server`, `MODELS`, `SERVERS`, … (de huidige SOT) |
| `scrum4me-workers/lib/queue/types.ts:7` | handkopie; de bestandsheader zegt dat zelf |
| `scrum4me-mcp` fase-2-plan, Task 2 | derde kopie, nog te bouwen |

De kopieën zijn **al gedivergeerd**, en niet op `MODELS`:

| Bron | `source` |
|---|---|
| Gedeployde CHECK (`Scrum4Me/prisma/migrations/20260716113110_add_agent_message_queue_tables/migration.sql:56`) | `source IN ('cli','dashboard','mcp')` |
| `s4m-queue/src/types.ts:7` | `Source = 'cli' \| 'dashboard'` |
| `scrum4me-workers/lib/queue/types.ts` (`AgentMessage.source`) | `'cli' \| 'dashboard'` |

Beide TypeScript-kopieën missen `'mcp'`, terwijl fase 2 juist `source='mcp'` gaat wegschrijven.
Er crasht niets — niets valideert op read — maar het type liegt zodra de MCP-tools live gaan.
Dat is het faalpatroon dat hier telt: stil en groen.

Een module die alléén `MODELS` deelde had dit niet gevangen. Vandaar de gekozen grens in §3.

## 2. Besluiten

Beide vastgesteld door JP op 2026-07-25.

**2.1 — Scope: shared bedient `scrum4me-mcp` en `scrum4me-workers`; `s4m-queue` doet niet mee.**

`s4m-queue` bouwt met kale `tsc` naar `dist/` en `bin` wijst naar `dist/cli.js`. Kale tsc
herschrijft geen path-aliases; de repos die `@shared/*` wél gebruiken resolven die op runtime
(mcp via `tsx`, workers via Next). De CLI consument maken vraagt dus een submodule plus een
build- of runtime-wijziging, uit te rollen op mac, scrum4me-server en max2 — terwijl daar ook
de data-cutover (T-96) nog moet gebeuren. Niet proportioneel.

Gevolg: van drie kopieën naar twee. De CLI houdt een **bewuste, gedocumenteerde tweelingkopie**;
§5 beschrijft de gate die divergentie zichtbaar maakt.

**2.2 — Grens: alle gesloten woordenlijsten die de DB óók afdwingt, plus de triviale guards.**

Pure data, nul gedrag, nul gedragsrisico. `validateTaskMeta`, `AgentMessage`, `NotifyEnvelope`,
`CHANNEL` en `STALE_CLAIM_INTERVAL` blijven waar ze zijn (§4).

**2.3 — `scrum4me-mcp` krijgt geen re-export-shim.**

Het vocabulaire-blok verdwijnt uit de geplande `src/queue/types.ts`; de tools importeren direct
uit `@shared/queue-identity.js`. Er is nog geen code die aan dat blok hangt (Task 2 is niet
uitgevoerd), dus een shim koopt alleen een kleinere plandiff en introduceert de vraag welke
definitie de bron is — precies het probleem dat dit ontwerp oplost.

## 3. De module

Nieuw: `scrum4me-shared/lib/queue-identity.ts`. Pure TypeScript, geen imports, haalt de
dep-gate (`scripts/verify-no-deps.sh`) triviaal.

```ts
// Gedeeld adres- en statusvocabulaire van de s4m-queue (agent_message).
// Dit zijn de gesloten woordenlijsten die de DB óók afdwingt via CHECK-constraints
// (Scrum4Me/prisma/migrations/20260716113110_add_agent_message_queue_tables/migration.sql).
// De CLI (s4m-queue/src/types.ts) houdt hier een bewuste eigen kopie van — zie
// docs/superpowers/specs/2026-07-25-queue-identity-shared-module-design.md §7.

export const QUEUE_SERVERS = ['mac', 'scrum4me-server', 'max2'] as const
export const QUEUE_MODELS = ['claude', 'codex', 'jp'] as const
export const QUEUE_REQUEST_TYPES = ['task', 'info', 'review_request'] as const
export const QUEUE_RESPONSE_TYPES = ['result', 'data', 'reviewed'] as const
export const QUEUE_STATUSES = ['pending', 'claimed', 'done', 'failed', 'cancelled'] as const
export const QUEUE_TERMINAL_STATUSES = ['done', 'failed', 'cancelled'] as const
export const QUEUE_SOURCES = ['cli', 'dashboard', 'mcp'] as const

export type QueueServer = (typeof QUEUE_SERVERS)[number]
export type QueueModel = (typeof QUEUE_MODELS)[number]
export type QueueRequestType = (typeof QUEUE_REQUEST_TYPES)[number]
export type QueueResponseType = (typeof QUEUE_RESPONSE_TYPES)[number]
export type QueueMessageType = QueueRequestType | QueueResponseType
export type QueueStatus = (typeof QUEUE_STATUSES)[number]
export type QueueSource = (typeof QUEUE_SOURCES)[number]

export const QUEUE_REPLY_TYPE: Record<QueueRequestType, QueueResponseType> = {
  task: 'result',
  info: 'data',
  review_request: 'reviewed',
}

// Signaturen; implementaties zijn de triviale `includes`-guards.
export function isQueueServer(s: string): s is QueueServer
export function isQueueModel(m: string): m is QueueModel
export function isQueueRequestType(t: string): t is QueueRequestType
export function queueReplyTypeFor(t: QueueRequestType): QueueResponseType
```

`QUEUE_TERMINAL_STATUSES` en `QUEUE_SOURCES` zijn **toevoegingen**, geen verplaatsingen:
workers heeft ze vandaag niet als const (`TERMINAL_STATUSES` staat alleen in het fase-2-plan,
en `source` is daar een inline union). Workers krijgt ze er dus bij.

**Naamgeving.** `scrum4me-shared` is een platte lib van 21 modules die al `AGENT_RUNTIMES`,
`JOB_SOURCES` en `CODEX_SANDBOX_MODES` exporteert. Een kale `SOURCES` naast het bestaande
`JOB_SOURCES` is precies de verwarring die je niet wilt, dus krijgen de constanten een
`QUEUE_`-prefix — conform de huisstijl van de repo. De **types** houden de namen uit het
fase-2-plan (`QueueModel`, `QueueServer`, …), zodat in `scrum4me-mcp` niets hernoemd hoeft.
`scrum4me-workers` gebruikt `Model`/`Server`; die krijgt lokale aliassen (§6.2).

## 4. Wat er bewust buiten blijft

| Item | Reden |
|---|---|
| `AgentMessage`, `NotifyEnvelope` | Rij-vormen, geen vocabulaire. Workers heeft een `pg.QueryResultRow` met index-signature; mcp krijgt Prisma-gegenereerde types. Verschillende vormen voor dezelfde tabel — geen gedeelde definitie mogelijk zonder één van beide te verbouwen. |
| `validateTaskMeta`, `TaskMeta` | Twee verschillende signaturen: workers heeft `asserts meta is { task: TaskMeta }` (valideert de envelope, 5 velden), het fase-2-plan heeft `validateTaskMeta(task): QueueTaskMeta` (valideert het task-object, 4 optionele velden extra, `VALIDATION_ERROR:`-prefix). Samenvoegen is geen verplaatsing maar een verzoening mét gedragswijziging in een gedeployde app. Buiten de grens van besluit 2.2. |
| `CHANNEL`, `STALE_CLAIM_INTERVAL` | Geen DB-afgedwongen woordenlijst. Bovendien is `CHANNEL` geen constante: de CLI leest hem uit `S4M_QUEUE_CHANNEL` (`s4m-queue/src/config.ts`) terwijl workers en mcp `'agent_queue'` hardcoderen. Wie die env-var ooit zet, breekt het dashboard en de MCP-tools zonder waarschuwing. Bewust buiten deze grens gelaten; genoteerd als losse draad in §9. |

## 5. Verificatie

Een test die `QUEUE_MODELS` gelijkstelt aan `['claude','codex','jp']` bewijst niets — hij herhaalt
het literal. Twee lagen die wél iets bewijzen:

**5.1 — Interne consistentie, in `scrum4me-shared/__tests__/queue-identity.test.ts`:**

- `QUEUE_REPLY_TYPE` dekt elk request-type exact — uitputtend, dus een nieuw request-type
  zonder reply-mapping wordt rood.
- `QUEUE_REQUEST_TYPES` en `QUEUE_RESPONSE_TYPES` zijn disjunct.
- `QUEUE_TERMINAL_STATUSES` is een deelverzameling van `QUEUE_STATUSES`.
- Elke guard accepteert elk lid van zijn eigen lijst en weigert randgevallen: `'Claude'`
  (hoofdletter), `'kimi '` (spatie), `''`.

**5.2 — Pariteit met de DDL, in `Scrum4Me/__tests__/db/agent-message-queue-migration.test.ts`.**

Dit is de gate die het werk doet. Het bestand bestaat al (T-89) en `Scrum4Me` heeft de submodule.
Breid hem uit zodat hij de CHECK-lijsten uit `migration.sql` letterlijk parseert en gelijkstelt
aan de shared-arrays: `type`, `status` en `source`. Daarmee wordt de `source`-drift uit §1
onmiddellijk rood, en kan hij niet terugkomen.

**Deze gate dekt drie van de zeven lijsten, en dat is geen omissie maar een eigenschap van het
schema.** `from_server`, `from_model`, `to_server` en `to_model` zijn `text NOT NULL` **zonder**
CHECK (`migration.sql:49-52`, en identiek in `s4m-queue/migrations/001_init.sql`). Er is dus geen
DDL om `QUEUE_SERVERS` en `QUEUE_MODELS` tegen te toetsen. Die twee lijsten worden alleen door
§5.1 en door de typechecker bewaakt. Zie §7 voor wat dat betekent voor de CLI-kopie.

Deze test kán niet in `scrum4me-shared` wonen: de dep-gate verbiedt `fs` in `lib/`, en de
CHECK-constraints staan sowieso niet in het Prisma-schema — Prisma kent ze niet.

**5.3 — Bestaande gates blijven leidend:** `npm run verify` in shared (dep-gate + typecheck +
test), `npm test` + `npm run typecheck` in workers en mcp.

## 6. Wijzigingen per repo

### 6.1 `scrum4me-shared`

- Nieuw: `lib/queue-identity.ts` (§3).
- Nieuw: `__tests__/queue-identity.test.ts` (§5.1), huisstijl van `__tests__/task-status.test.ts`
  — vitest, import uit `../lib/queue-identity` (shared draait `moduleResolution: "Bundler"`,
  dus zonder extensie; consumers importeren mét `.js`, zoals bij elke bestaande module).
- `npm run verify` groen.

### 6.2 `scrum4me-workers`

- Bump `vendor/scrum4me-shared` naar de nieuwe main-SHA (staat al op main, dus alleen vooruit).
- `lib/queue/types.ts` verliest zijn vijf const-arrays (`SERVERS`, `MODELS`, `REQUEST_TYPES`,
  `RESPONSE_TYPES`, `STATUSES`), de afgeleide types, `REPLY_TYPE`/`replyTypeFor` en de drie
  guards. Daarvoor in de plaats expliciete re-exports met lokale aliassen:

  ```ts
  export { QUEUE_SERVERS as SERVERS, QUEUE_MODELS as MODELS, /* … */ } from '@shared/queue-identity.js'
  export type { QueueServer as Server, QueueModel as Model, /* … */ } from '@shared/queue-identity.js'
  ```

  Het bestand blijft bestaan — het houdt `AgentMessage`, `NotifyEnvelope`, `CHANNEL`,
  `STALE_CLAIM_INTERVAL` en `validateTaskMeta`. De re-export is dus geen extra laag maar één
  bestand met gemengde inhoud, waarvan de herkomst per export leesbaar is.
- Fix meteen mee: `AgentMessage.source` wordt `QueueSource` en krijgt daarmee `'mcp'` erbij (§1).
- **Geen** van de zeven consumenten wijzigt. Vijf in productiecode —
  `lib/rules/sync.ts:4`, `lib/queue/ops-db.ts:6`, `actions/queue-messages.ts:15`,
  `app/(app)/queue/messages/_components/messages-view.tsx:15`,
  `app/api/queue/messages/stream/route.ts:3` — plus twee tests:
  `__tests__/app/queue-messages-view.test.tsx` en `__tests__/lib/queue/ops-db-retention.test.ts`,
  die het bestand dynamisch importeert voor `parseRetentionDays`.

### 6.3 `scrum4me-mcp`

Het fase-2-plan (`docs/superpowers/plans/2026-07-12-s4m-queue-fase2-mcp-kernset.md`) is nog
niet uitgevoerd; dit past het plan aan, niet de code.

- **Task 1** ("Fase-1-dependency — vendor-bump + schema-sync") bumpt `vendor/scrum4me-shared`
  van `18caa21d` naar de nieuwe main-SHA. Die bump stond er al in en is sowieso nodig: het plan
  gebruikt `prisma.agentMessage.create` en `prisma.$transaction`, dus zonder de AgentMessage-
  modellen uit shared compileert fase 2 niet. De shared-adoptie kost hier dus vrijwel niets extra.
- **Task 2** verliest het vocabulaire-blok. `src/queue/types.ts` houdt `QueueAddress`,
  `requiresTaskMeta`, `QueueTaskMeta` en `validateTaskMeta`.
- `src/queue/identity.ts` en `parseQueueTarget` (Task 3) gebruiken `QUEUE_MODELS` en
  `QUEUE_SERVERS` uit `@shared/queue-identity.js`; foutteksten blijven ongewijzigd.

### 6.4 `s4m-queue`

Ongewijzigd. Zie §7.

## 7. De bewuste tweelingkopie

`s4m-queue/src/types.ts` blijft zijn eigen definitie houden. Dat is geen slordigheid maar een
afweging (besluit 2.1). Om te voorkomen dat het als vergeten drift leest:

- Zet in `s4m-queue/src/types.ts` een header-comment die naar deze spec verwijst en vastlegt
  dat `scrum4me-shared/lib/queue-identity.ts` de gedeelde definitie is, dat deze kopie bewust
  bestaat omdat de CLI geen submodule draagt, en op wélke plekken een wijziging moet landen.
  Zolang §6.2 niet is uitgevoerd zijn dat er **drie** — CLI, shared én workers — niet twee.
  Draagt de wijziging een `type`, `status` of `source`, dan hoort er bovendien een migratie in
  `Scrum4Me/prisma/migrations/` bij: de CHECK-constraints wonen daar, niet in TypeScript.
- **De pariteitstest van §5.2 dekt de CLI niet, en de DB evenmin — in de richting die telt.**
  De CHECKs op `type` en `status` vangen een CLI die *vóórloopt* op de DDL: die INSERT wordt
  geweigerd. Maar het header-comment waarschuwt voor het omgekeerde, een CLI die *achterloopt*
  op shared, en in die richting zwijgt vrijwel alles:

  | Lijst | Wat er gebeurt als de CLI-kopie achterloopt |
  |---|---|
  | `type` | `cli.ts:143` weigert een onbekend `--type` luid, maar `next`/`peek` filteren op `REQUEST_TYPES` (`cli.ts:155`, `:187`) — binnenkomende berichten van een nieuw type worden simpelweg niet gezien. Stil. |
  | `status` | `--status` wordt niet gevalideerd (`cli.ts:191`) en `db.ts:129` leest een onbekende status als "al afgesloten". Stil. |
  | `source` | De CLI schrijft altijd de literal `'cli'` (`db.ts:137`, `:292`), dus een ontbrekend lid wordt nooit uitgeprobeerd. Stil — precies de drift uit §1. |
  | `SERVERS` | Geen CHECK. `loadConfig` (`config.ts:26`) weigert een onbekende `S4M_SERVER`, dus de CLI start niet eens op een nieuwe host. Luid, maar pas op die host. |
  | `MODELS` | Geen CHECK. `parseTarget` weigert het adres. Luid voor wie het typt, onzichtbaar voor de rest. |

  Juist daarom is het header-comment geen formaliteit: het is de enige bewaking die de CLI-kopie
  heeft.

  > Deze spec beweerde eerder dat een achterlopende CLI zich uit als "een adres dat de CLI weigert
  > terwijl het dashboard het wél accepteert". Dat is onjuist zolang §6.2 niet is uitgevoerd:
  > `scrum4me-workers` valideert een push met zijn **eigen** kopie (`actions/queue-messages.ts:70`),
  > die vandaag identiek is aan die van de CLI. Beide kanten weigeren dan. De asymmetrie ontstaat
  > pas wanneer workers re-exporteert uit shared.

## 8. Volgorde

1. **shared** — module + tests, merge → nieuwe main-SHA.
2. **Scrum4Me** — bump submodule + pariteitstest (§5.2). Vóór de consumers, want die test bewijst
   dát het vocabulaire klopt; faalt hij, dan wil je dat weten voordat twee repos het overnemen.
3. **workers** — bump + re-export-omzetting + `source`-fix.
4. **mcp** — bump (Task 1) + planaanpassing (§6.3).

**Blokkade op stap 4.** Er loopt een achtergrondtaak die `scrum4me-mcp` op `ab6e97b` pint. Die
commit zit op branch `chore/canonical-drop-datasource-url`, **niet op main** (geverifieerd). Landt
die eerst, dan wijst mcp's gitlink naast main en moet stap 4 dat rechttrekken. Rond die taak af of
trek hem in vóór stap 4.

**Pins bij het schrijven van deze spec** (shared main = `2a6b9a7f`): workers `2a6b9a7f` (bij),
Scrum4Me `cd19b4cb` (5 achter), mcp `18caa21d` (12 achter). Alle drie zijn ancestors van main —
fast-forward, geen divergentie.

## 9. Wat dit oplevert

Kimi toevoegen wordt hierna: één regel in `shared/lib/queue-identity.ts`, één in
`s4m-queue/src/types.ts`, plus de submodule-bumps. Dat is **niet minder stappen** dan de drie
bestanden van vandaag — submodule-bumps zijn ook stappen. Wat het oplevert is dat er nog maar
één definitie is die ertoe doet, en een test die rood wordt als de tweelingkopie afdwaalt. De
winst zit in de gate, niet in de diff.

## 10. Buiten scope

- **`s4m-queue` als consument** (besluit 2.1).
- **Kimi zelf toevoegen.** Dit ontwerp maakt dat goedkoop; het doet het niet.
- **`validateTaskMeta` unificeren** (§4).
- **`CHANNEL` / `STALE_CLAIM_INTERVAL`** blijven gedupliceerd, inclusief de env-override-
  inconsistentie uit §4. Kandidaat voor een vervolgtaak.
- **`AGENT_RUNTIMES` / `normalizeAgentRuntime`** (`scrum4me-shared/lib/agent-runtime.ts`) blijft
  ongemoeid. Dat is een ander concept — welke runtime een job uitvoert, hoofdletters, zonder `jp` —
  met een eigen levensduur. Wel signaleren: `normalizeAgentRuntime` maakt van elke onbekende waarde
  stilzwijgend `'CLAUDE'`. Zodra Kimi jobs gaat draaien via scrum4us of scrum4me-jobs is dat een
  echte fout die zich als een geslaagde run voordoet. Aparte taak, aparte spec.
