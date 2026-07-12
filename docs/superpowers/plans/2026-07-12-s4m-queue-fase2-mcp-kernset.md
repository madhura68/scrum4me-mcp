# s4m-queue fase 2 (MCP-kernset: 7 queue-tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fase 2 van de s4m-queue-migratie: de 7 queue-tools (`queue_push`, `queue_wait_reply`, `queue_next`, `queue_done`, `queue_fail`, `queue_status`, `queue_list`) als stdio-only MCP-tools op de scrum4me-DB, met de correlatie-fix (`in_reply_to`-filter ín de claim-query), het proces-incarnatie-eigenaarscontract (in-memory lease-register + claim-token) en byte-compatibele NotifyEnvelope-emissie.

**Architecture:** Gedeelde helpers onder `src/queue/` (`types`, `identity`, `notify`, `lease-register`, `claim`, `listen`, `view`, `ownership`, `git-origin`), bestand-per-tool in `src/tools/queue-*.ts`, geregistreerd via een nieuwe `registerQueueTools()` in `src/register.ts` die alléén `src/index.ts` aanroept (stdio-only; `src/http.ts` blijft op `registerSharedTools`). Claims lopen via `FOR UPDATE SKIP LOCKED`-CTE's in interactieve Prisma-transacties met `pg_notify` bínnen de transactie (vuurt bij COMMIT); bounded waits via een dedicated `pg.Client` met LISTEN + 5 s-poll-vangnet en expliciete MCP-cancel-afhandeling via `extra.signal`.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/sdk` 1.29 (`registerTool`, `RequestHandlerExtra.signal`), Prisma 7 + `@prisma/adapter-pg`, `pg` (LISTEN/NOTIFY), zod v4, vitest (unit met `vi.mock`; integratie via `TEST_DATABASE_URL`, skip zonder env).

**Spec:** `docs/superpowers/specs/2026-07-12-s4m-queue-mcp-integration-design.md` — §3 (identiteit), §5 (alle 7 tools + LISTEN-mechaniek), §7 (errors) en §8 (tests) zijn na 6 codex-reviewrondes definitief; hiervan wordt NIET afgeweken.

**Fase-koppelingen (hard):**

- **Fase 1 (dependency):** de Prisma-modellen `AgentMessage`/`AgentMessageArchive` bestaan pas na de fase-1-migratie in scrum4me-shared (spec §4). Task 1 pint de vendor-submodule en STOPt als het model ontbreekt.
- **Fase 3 (interface-contract):** dit plan levert exact de interfaces die `docs/superpowers/plans/2026-07-12-s4m-queue-fase3-hardening.md` (Task 1) verwacht:
  - `src/queue/lease-register.ts`: `interface QueueLease { claimToken: string; claimedBy: string }`, `registerLease(messageId, lease)`, `getLease(messageId)`, `releaseLease(messageId)`, `leaseEntries(): Array<{ messageId; claimToken; claimedBy }>`, `clearLeases()`.
  - `src/queue/notify.ts`: `QUEUE_CHANNEL = 'agent_queue'` + `envelopeOf(m, previousStatus)` met de exacte CLI-veldvolgorde.
  - `src/tools/queue-done.ts`: `registerQueueDoneTool(server)`, input `{message_id, reply?, claim_token?}`, foutprefixen `QUEUE_CLAIM_EXPIRED:` / `QUEUE_NOT_CLAIMER:` via `toolError()`.
  - De lease-REFRESH-tick (10 s), de stale-sweep en de registry-pruning zijn **fase 3** — fase 2 bouwt uitsluitend het register + de checks. `src/presence/shutdown.ts` en de heartbeat blijven in fase 2 onaangeroerd.

**Werkplek-voorbereiding:** verse worktree → `git submodule update --init && npm install` (postinstall draait `gen-schema.sh` + `prisma generate`); zonder gegenereerde Prisma-client is `npm run typecheck` per definitie rood (bekende worktree-trap).

**Conventies (gelden voor élke taak):**

- TDD; tests volgen het `check-queue-empty`-patroon: `vi.mock` van `../src/prisma.js`/`../src/auth.js`, fake `McpServer` die de handler capture't (`__tests__/check-queue-empty.test.ts`).
- Alle handler-fouten als typed string-prefix via `toolError('CODE: …')`; `withToolErrors` (src/errors.ts) mapt `Error`/`ZodError`/`PermissionDeniedError` (§7-conventie). Helpers die identiteit/validatie doen gooien `Error` met het prefix al in de message.
- Alle 7 tools roepen `requireWriteAccess()` aan (repo-conventie, blokkeert demo-accounts) — óók de read-only tools, zoals `check_queue_empty` dat doet.
- Identiteit (`resolveQueueIdentity`) is alléén nodig in `queue_push`/`queue_wait_reply`/`queue_next`/`queue_list`. `queue_done`/`queue_fail` spiegelen adressen uit de request-rij en `queue_status` is puur id-gebaseerd (CLI-pariteit: `done`/`fail`/`status` kennen ook geen `--as`).
- Unit-tests roepen de gecapture'de handler direct aan — de zod-parsing van de SDK (die defaults invult) draait dan níet. Tests geven daarom `wait_seconds` altijd expliciet mee; handlers gebruiken defensief `wait_seconds ?? <default>` en `extra?.signal ?? new AbortController().signal`.
- Raw SQL altijd met `${param}` (tagged template, Prisma bindt) en `::uuid`/`::uuid[]`/`::text[]`-casts op parameters die tegen uuid-kolommen vergeleken worden.
- Code en comments in het Engels; plan-/committeksten mogen Nederlands.

---

### Task 1: Fase-1-dependency — vendor-bump + schema-sync (`AgentMessage`)

De `AgentMessage`-Prismamodellen bestaan pas na fase 1 in scrum4me-shared. Deze taak pint de submodule op een tip die het model bevat, regenereert `prisma/schema.prisma` en de client, en verifieert dat de kolomnamen exact die van `s4m-queue/migrations/001_init.sql` zijn — dit plan gebruikt die namen letterlijk in Prisma-calls en raw SQL. Zelfde patroon als eerdere vendor-pins (`git log --oneline -- vendor/scrum4me-shared`, bv. `5d4e9a7 chore(schema): vendor-pin f233187 (M23 shared) + schema-sync`).

**Files:**
- Modify: `vendor/scrum4me-shared` (submodule-pointer)
- Modify: `prisma/schema.prisma` (gegenereerd — commit mee, zoals eerdere schema-syncs)

**Stappen:**

- [ ] Initialiseer de werkplek: `git submodule update --init && npm install` → verwacht: exit 0, postinstall genereert schema + client.
- [ ] Controleer of fase 1 gemerged is in scrum4me-shared: `git -C vendor/scrum4me-shared fetch origin && git -C vendor/scrum4me-shared grep -n "AgentMessage" origin/main` → verwacht: minimaal één hit in een Prisma-schemabestand (het model met `@@map("agent_message")`). **Géén hit → STOP**: fase 1 is nog niet gemerged; meld aan JP en ga niet verder.
- [ ] Pin de submodule: `git -C vendor/scrum4me-shared checkout origin/main && git -C vendor/scrum4me-shared rev-parse --short HEAD` → noteer de sha voor de commit-message.
- [ ] Regenereer schema + client: `npm run prisma:generate` → verwacht: exit 0.
- [ ] Verifieer het model: `grep -n 'model AgentMessage' prisma/schema.prisma` → verwacht: één hit. Daarna veldnamen-check: `sed -n '/model AgentMessage /,/^}/p' prisma/schema.prisma` → verwacht de velden `id, type, from_server, from_model, to_server, to_model, body, meta, source, status, in_reply_to, error, claimed_by, claimed_at, started_at, finished_at, created_at` (kolom-getrouw aan `001_init.sql`; de fase-1-afwijking is alleen de `source`-CHECK met `'mcp'`). **Afwijkende veldnamen → STOP** en meld: fase-1-model is niet kolom-getrouw, dit plan mag dan niet blind verder.
- [ ] Nulmeting: `npm run typecheck && npm test` → verwacht: beide groen (pretest draait `typecheck:tests`).
- [ ] Commit: `git add vendor/scrum4me-shared prisma/schema.prisma && git commit -m "chore(schema): vendor-pin <sha> (fase 1 agent_message) + schema-sync"` (vul `<sha>` in uit de rev-parse-stap).

---

### Task 2: `src/queue/types.ts` — CLI-typevocabulaire + `validateTaskMeta`-port

Port van `~/Development/s4m-queue/src/types.ts`: servers/models/typen/statussen, de `REPLY_TYPE`-mapping (task→result, info→data, review_request→reviewed) en `validateTaskMeta`. Enige bewuste wijziging: foutmeldingen krijgen het `VALIDATION_ERROR:`-prefix (repo-conventie §7) en zijn Engels.

**Files:**
- Create: `src/queue/types.ts`
- Test: `__tests__/queue-types.test.ts`

**Stappen:**

- [ ] Schrijf de failing test `__tests__/queue-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  REPLY_TYPE, REQUEST_TYPES, RESPONSE_TYPES, TERMINAL_STATUSES,
  isRequestType, requiresTaskMeta, validateTaskMeta,
} from '../src/queue/types.js'

describe('queue types — CLI-pariteit (s4m-queue/src/types.ts)', () => {
  it('mapt request-types op de juiste reply-types', () => {
    expect(REPLY_TYPE).toEqual({ task: 'result', info: 'data', review_request: 'reviewed' })
  })

  it('kent de vaste type- en statusvocabulaires', () => {
    expect(REQUEST_TYPES).toEqual(['task', 'info', 'review_request'])
    expect(RESPONSE_TYPES).toEqual(['result', 'data', 'reviewed'])
    expect(TERMINAL_STATUSES).toEqual(['done', 'failed', 'cancelled'])
  })

  it('herkent request-types', () => {
    expect(isRequestType('task')).toBe(true)
    expect(isRequestType('result')).toBe(false)
  })

  it('vereist meta.task alleen voor task en review_request', () => {
    expect(requiresTaskMeta('task')).toBe(true)
    expect(requiresTaskMeta('review_request')).toBe(true)
    expect(requiresTaskMeta('info')).toBe(false)
  })
})

describe('validateTaskMeta — geport uit de CLI, met VALIDATION_ERROR-prefix', () => {
  const valid = {
    cwd: '/tmp/x',
    repo: 'https://git.example/r.git',
    objective: 'o',
    verification: 'v',
    response_format: 'rf',
  }

  it('accepteert een compleet meta.task-object en neemt optionele velden mee', () => {
    const result = validateTaskMeta({ ...valid, branch: 'feat/x', allowed_actions: ['test'] })
    expect(result).toEqual({ ...valid, branch: 'feat/x', allowed_actions: ['test'] })
  })

  it('gooit met VALIDATION_ERROR-prefix en veldnaam bij een ontbrekend verplicht veld', () => {
    const { verification: _omit, ...incomplete } = valid
    expect(() => validateTaskMeta(incomplete)).toThrowError(/^VALIDATION_ERROR: meta\.task\.verification/)
  })

  it('gooit wanneer meta.task geen object is', () => {
    expect(() => validateTaskMeta(undefined)).toThrowError(/^VALIDATION_ERROR: meta\.task is missing/)
  })

  it('laat niet-string optionele velden weg in plaats van te falen', () => {
    const result = validateTaskMeta({ ...valid, branch: 42 })
    expect(result).toEqual(valid)
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-types.test.ts` → verwacht: FAIL (module `src/queue/types.ts` bestaat niet).
- [ ] Maak `src/queue/types.ts` met exact deze inhoud:

```ts
// Ported from s4m-queue/src/types.ts — the CLI and the MCP tools must agree on
// address vocabulary, the request→reply type mapping and meta.task validation.
// Semantics identical to the CLI; only the VALIDATION_ERROR prefix is new
// (repo convention: typed string prefixes surfaced via toolError()).

export type QueueServer = 'mac' | 'scrum4me-server' | 'max2'
export type QueueModel = 'claude' | 'codex' | 'jp'
export type QueueRequestType = 'task' | 'info' | 'review_request'
export type QueueResponseType = 'result' | 'data' | 'reviewed'
export type QueueMessageType = QueueRequestType | QueueResponseType
export type QueueStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'cancelled'

export const SERVERS: readonly QueueServer[] = ['mac', 'scrum4me-server', 'max2']
export const MODELS: readonly QueueModel[] = ['claude', 'codex', 'jp']
export const REQUEST_TYPES: readonly QueueRequestType[] = ['task', 'info', 'review_request']
export const RESPONSE_TYPES: readonly QueueResponseType[] = ['result', 'data', 'reviewed']
export const TERMINAL_STATUSES: readonly QueueStatus[] = ['done', 'failed', 'cancelled']

export const REPLY_TYPE: Record<QueueRequestType, QueueResponseType> = {
  task: 'result',
  info: 'data',
  review_request: 'reviewed',
}

export interface QueueAddress {
  server: QueueServer
  model: QueueModel
}

export function isRequestType(t: string): t is QueueRequestType {
  return (REQUEST_TYPES as readonly string[]).includes(t)
}

export function requiresTaskMeta(t: QueueRequestType): boolean {
  return t === 'task' || t === 'review_request'
}

export interface QueueTaskMeta {
  cwd: string
  repo: string
  objective: string
  verification: string
  response_format: string
  branch?: string
  worktree?: string
  expected_result?: string
  allowed_actions?: string[]
}

const REQUIRED_TASK_META: readonly (keyof QueueTaskMeta)[] = [
  'cwd', 'repo', 'objective', 'verification', 'response_format',
]

/** Throws when the required meta.task contract is missing or incomplete. */
export function validateTaskMeta(task: unknown): QueueTaskMeta {
  if (!task || typeof task !== 'object') {
    throw new Error('VALIDATION_ERROR: meta.task is missing (required for task/review_request)')
  }
  const t = task as Record<string, unknown>
  for (const k of REQUIRED_TASK_META) {
    if (typeof t[k] !== 'string' || (t[k] as string).trim() === '') {
      throw new Error(`VALIDATION_ERROR: meta.task.${k} is missing or empty (required)`)
    }
  }
  const validated: QueueTaskMeta = {
    cwd: t.cwd as string,
    repo: t.repo as string,
    objective: t.objective as string,
    verification: t.verification as string,
    response_format: t.response_format as string,
  }
  if (typeof t.branch === 'string') validated.branch = t.branch
  if (typeof t.worktree === 'string') validated.worktree = t.worktree
  if (typeof t.expected_result === 'string') validated.expected_result = t.expected_result
  if (Array.isArray(t.allowed_actions) && t.allowed_actions.every((a) => typeof a === 'string')) {
    validated.allowed_actions = t.allowed_actions as string[]
  }
  return validated
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-types.test.ts` → verwacht: PASS (8 tests groen).
- [ ] Commit: `git add src/queue/types.ts __tests__/queue-types.test.ts && git commit -m "feat(queue): port CLI type-vocabulaire + validateTaskMeta (fase 2, spec §5.1)"`

---

### Task 3: `src/queue/identity.ts` — identiteit uit env + target-parsing

Spec §3: adres = `(S4M_SERVER, model)`. `S4M_SERVER` bestaat al per host; `S4M_MODEL` is nieuw in het `mcpServers`-config-blok. De optionele `as`-parameter per call override't alléén het model. Ontbrekende of ongeldige identiteit → `QUEUE_IDENTITY_REQUIRED` (§7). `parseQueueTarget` is de port van `s4m-queue/src/config.ts::parseTarget` met `VALIDATION_ERROR:`-prefix.

**Files:**
- Create: `src/queue/identity.ts`
- Test: `__tests__/queue-identity.test.ts`

**Stappen:**

- [ ] Schrijf de failing test `__tests__/queue-identity.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { parseQueueTarget, resolveQueueIdentity } from '../src/queue/identity.js'

beforeEach(() => {
  vi.stubEnv('S4M_SERVER', 'mac')
  vi.stubEnv('S4M_MODEL', 'claude')
})
afterEach(() => vi.unstubAllEnvs())

describe('resolveQueueIdentity — spec §3', () => {
  it('leest (S4M_SERVER, S4M_MODEL) uit env', () => {
    expect(resolveQueueIdentity()).toEqual({ server: 'mac', model: 'claude' })
  })

  it("laat 'as' alleen het model overriden", () => {
    expect(resolveQueueIdentity('codex')).toEqual({ server: 'mac', model: 'codex' })
  })

  it('gooit QUEUE_IDENTITY_REQUIRED zonder S4M_SERVER', () => {
    vi.stubEnv('S4M_SERVER', '')
    expect(() => resolveQueueIdentity()).toThrowError(/^QUEUE_IDENTITY_REQUIRED: S4M_SERVER/)
  })

  it('gooit QUEUE_IDENTITY_REQUIRED zonder S4M_MODEL en zonder as', () => {
    vi.stubEnv('S4M_MODEL', '')
    expect(() => resolveQueueIdentity()).toThrowError(/^QUEUE_IDENTITY_REQUIRED: S4M_MODEL/)
  })

  it('weigert een onbekende servernaam', () => {
    vi.stubEnv('S4M_SERVER', 'laptop')
    expect(() => resolveQueueIdentity()).toThrowError(/^QUEUE_IDENTITY_REQUIRED/)
  })

  it('weigert een onbekende as-waarde', () => {
    expect(() => resolveQueueIdentity('gpt')).toThrowError(/^QUEUE_IDENTITY_REQUIRED/)
  })
})

describe('parseQueueTarget — CLI-pariteit (parseTarget)', () => {
  it('parseert <server>:<model>', () => {
    expect(parseQueueTarget('scrum4me-server:claude')).toEqual({ server: 'scrum4me-server', model: 'claude' })
    expect(parseQueueTarget('mac:jp')).toEqual({ server: 'mac', model: 'jp' })
  })

  it('weigert onbekende combinaties met VALIDATION_ERROR', () => {
    expect(() => parseQueueTarget('mars:claude')).toThrowError(/^VALIDATION_ERROR: invalid target/)
    expect(() => parseQueueTarget('mac')).toThrowError(/^VALIDATION_ERROR/)
    expect(() => parseQueueTarget('mac:claude:extra')).toThrowError(/^VALIDATION_ERROR/)
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-identity.test.ts` → verwacht: FAIL (module bestaat niet).
- [ ] Maak `src/queue/identity.ts` met exact deze inhoud:

```ts
import { MODELS, SERVERS, type QueueAddress, type QueueModel, type QueueServer } from './types.js'

/**
 * Queue identity (spec §3): address = (S4M_SERVER, model). S4M_SERVER comes
 * from the host env (already present per host); S4M_MODEL is set in the
 * mcpServers config block (claude config: 'claude', codex config: 'codex').
 * The optional per-call `as` parameter overrides the model only.
 * Missing/invalid identity → QUEUE_IDENTITY_REQUIRED (spec §7).
 */
export function resolveQueueIdentity(asOverride?: string): QueueAddress {
  const server = process.env.S4M_SERVER?.trim()
  if (!server || !(SERVERS as readonly string[]).includes(server)) {
    throw new Error(
      `QUEUE_IDENTITY_REQUIRED: S4M_SERVER must be one of [${SERVERS.join(', ')}] (was: ${server || 'empty'})`,
    )
  }
  const model = (asOverride ?? process.env.S4M_MODEL)?.trim()
  if (!model || !(MODELS as readonly string[]).includes(model)) {
    throw new Error(
      `QUEUE_IDENTITY_REQUIRED: S4M_MODEL (or the 'as' parameter) must be one of [${MODELS.join(', ')}] (was: ${model || 'empty'})`,
    )
  }
  return { server: server as QueueServer, model: model as QueueModel }
}

/** Parses '<server>:<model>' targets — same vocabulary as the CLI's parseTarget. */
export function parseQueueTarget(s: string): QueueAddress {
  const parts = s.split(':')
  const [server, model] = parts
  if (
    parts.length !== 2 ||
    !(SERVERS as readonly string[]).includes(server) ||
    !(MODELS as readonly string[]).includes(model)
  ) {
    throw new Error(
      `VALIDATION_ERROR: invalid target '${s}', expected <server>:<model> with server in ` +
        `[${SERVERS.join(', ')}], model in [${MODELS.join(', ')}]`,
    )
  }
  return { server: server as QueueServer, model: model as QueueModel }
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-identity.test.ts` → verwacht: PASS (8 tests groen).
- [ ] Commit: `git add src/queue/identity.ts __tests__/queue-identity.test.ts && git commit -m "feat(queue): identiteit uit S4M_SERVER/S4M_MODEL met as-override (fase 2, spec §3)"`

---

### Task 4: `src/queue/notify.ts` — NotifyEnvelope + best-effort emit

Byte-compatibel met `s4m-queue/src/db.ts::envelopeOf`: zelfde velden, zelfde volgorde (`id, type, from_server, from_model, to_server, to_model, in_reply_to, status, previous_status`) op kanaal `agent_queue` — CLI `--wait` en het Messages-dashboard parsen deze payload ongewijzigd (spec §3). De interface (`QUEUE_CHANNEL` + `envelopeOf`) is het fase-3-contract; `emitQueueNotifyBestEffort` is de post-commit-emit voor `queue_push` (§5.1: "Insert + NOTIFY (na commit, best-effort)"), zelfde conventie als `notifyJobEnqueued` in `src/lib/dispatch/notify.ts`. Transactionele NOTIFYs (claim/done/fail) doen de tools zelf met `tx.$executeRaw` — pg_notify vuurt daar bij COMMIT.

**Files:**
- Create: `src/queue/notify.ts`
- Test: `__tests__/queue-notify.test.ts`

**Stappen:**

- [ ] Schrijf de failing test `__tests__/queue-notify.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({ prisma: { $executeRaw: vi.fn() } }))

import { prisma } from '../src/prisma.js'
import { QUEUE_CHANNEL, emitQueueNotifyBestEffort, envelopeOf } from '../src/queue/notify.js'

const mockPrisma = prisma as unknown as { $executeRaw: ReturnType<typeof vi.fn> }

const row = {
  id: 'id-1',
  type: 'task',
  from_server: 'mac',
  from_model: 'claude',
  to_server: 'scrum4me-server',
  to_model: 'claude',
  in_reply_to: null,
  status: 'pending',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$executeRaw.mockResolvedValue(1)
})

describe('envelopeOf — byte-compatibel met s4m-queue/src/db.ts', () => {
  it('emit exact de CLI-veldenset in dezelfde volgorde', () => {
    expect(Object.keys(envelopeOf(row, null))).toEqual([
      'id', 'type', 'from_server', 'from_model', 'to_server', 'to_model',
      'in_reply_to', 'status', 'previous_status',
    ])
  })

  it('draagt previous_status mee', () => {
    expect(envelopeOf({ ...row, status: 'claimed' }, 'pending').previous_status).toBe('pending')
  })

  it('gebruikt het CLI-kanaal agent_queue', () => {
    expect(QUEUE_CHANNEL).toBe('agent_queue')
  })
})

describe('emitQueueNotifyBestEffort', () => {
  it('stuurt pg_notify via prisma', async () => {
    await emitQueueNotifyBestEffort(envelopeOf(row, null))
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1)
  })

  it('slikt DB-fouten (best-effort, nooit tool-falen — §7)', async () => {
    mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('down'))
    await expect(emitQueueNotifyBestEffort(envelopeOf(row, null))).resolves.toBeUndefined()
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-notify.test.ts` → verwacht: FAIL (module bestaat niet).
- [ ] Maak `src/queue/notify.ts` met exact deze inhoud (het `QueueMessageRow`/`envelopeOf`-deel is identiek aan wat het fase-3-plan als fallback specificeert — fase 3 hergebruikt deze module dan ongewijzigd):

```ts
// NotifyEnvelope for the s4m-queue channel — byte-compatible with
// s4m-queue/src/db.ts envelopeOf(): same fields, same order.
// CLI --wait and the Messages-dashboard parse this payload unchanged.
import { prisma } from '../prisma.js'

export const QUEUE_CHANNEL = 'agent_queue'

export interface QueueMessageRow {
  id: string
  type: string
  from_server: string
  from_model: string
  to_server: string
  to_model: string
  in_reply_to: string | null
  status: string
}

export interface QueueNotifyEnvelope {
  id: string
  type: string
  from_server: string
  from_model: string
  to_server: string
  to_model: string
  in_reply_to: string | null
  status: string
  previous_status: string | null
}

export function envelopeOf(
  m: QueueMessageRow,
  previousStatus: string | null,
): QueueNotifyEnvelope {
  return {
    id: m.id,
    type: m.type,
    from_server: m.from_server,
    from_model: m.from_model,
    to_server: m.to_server,
    to_model: m.to_model,
    in_reply_to: m.in_reply_to,
    status: m.status,
    previous_status: previousStatus,
  }
}

/**
 * Best-effort NOTIFY for already-committed rows (queue_push). A failing notify
 * must never surface as a tool error (§7; same convention as notifyJobEnqueued
 * in src/lib/dispatch/notify.ts) — LISTEN consumers have a 5 s poll safety net.
 */
export async function emitQueueNotifyBestEffort(envelope: QueueNotifyEnvelope): Promise<void> {
  try {
    const payload = JSON.stringify(envelope)
    await prisma.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${payload}::text)`
  } catch (err) {
    console.error('[scrum4me-mcp] queue notify failed (row is already committed):', err)
  }
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-notify.test.ts` → verwacht: PASS (5 tests groen).
- [ ] Commit: `git add src/queue/notify.ts __tests__/queue-notify.test.ts && git commit -m "feat(queue): byte-compatibele NotifyEnvelope + best-effort emit (fase 2, spec §3/§5.1)"`

---

### Task 5: `src/queue/lease-register.ts` — in-memory lease-register (fase-3-interface, heilig)

Spec §5.4: het lease-register is een map `message_id → claim_token` per proces-incarnatie, mét de volledige `claimed_by`-waarde voor de strikte-gelijkheids-check. De exports en de entry-vorm zijn het harde fase-3-contract (fase 3 bouwt hierop de 10 s-refresh-tick + pruning — die komen hier dus bewust NIET). `clearLeases()` is de test-helper die een verse proces-incarnatie simuleert.

**Files:**
- Create: `src/queue/lease-register.ts`
- Test: `__tests__/queue-lease-register.test.ts`

**Stappen:**

- [ ] Schrijf de failing test `__tests__/queue-lease-register.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  clearLeases, getLease, leaseEntries, registerLease, releaseLease,
} from '../src/queue/lease-register.js'

beforeEach(() => clearLeases())

describe('lease-register — fase-3-interfacecontract (spec §5.4/§6.1)', () => {
  it('registreert en leest een lease per message_id', () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    expect(getLease('msg-1')).toEqual({ claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
  })

  it('geeft undefined voor onbekende ids', () => {
    expect(getLease('nope')).toBeUndefined()
  })

  it('verwijdert een lease met releaseLease', () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    releaseLease('msg-1')
    expect(getLease('msg-1')).toBeUndefined()
  })

  it('leaseEntries levert de platte vorm {messageId, claimToken, claimedBy} (fase-3-refresh-tick)', () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    registerLease('msg-2', { claimToken: 'tok-2', claimedBy: 'mcp:inst:tok-2' })
    expect(leaseEntries()).toEqual([
      { messageId: 'msg-1', claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' },
      { messageId: 'msg-2', claimToken: 'tok-2', claimedBy: 'mcp:inst:tok-2' },
    ])
  })

  it('clearLeases simuleert een verse proces-incarnatie', () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    clearLeases()
    expect(leaseEntries()).toEqual([])
  })

  it('overschrijft een bestaande entry bij herregistratie (herclaim door dit proces)', () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    registerLease('msg-1', { claimToken: 'tok-9', claimedBy: 'mcp:inst:tok-9' })
    expect(getLease('msg-1')?.claimToken).toBe('tok-9')
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-lease-register.test.ts` → verwacht: FAIL (module bestaat niet).
- [ ] Maak `src/queue/lease-register.ts` met exact deze inhoud:

```ts
// In-memory lease register (spec §5.4): claims are bound to THIS process
// incarnation. The map holds message_id → {claimToken, claimedBy}; queue_done/
// queue_fail require a matching local entry before touching the DB, so a
// successor process can never finish a predecessor's claim — even within the
// lease window. Phase 3 adds the 10 s refresh tick + pruning on top of this
// exact interface; do not rename these exports.

export interface QueueLease {
  claimToken: string
  claimedBy: string
}

const leases = new Map<string, QueueLease>()

export function registerLease(messageId: string, lease: QueueLease): void {
  leases.set(messageId, lease)
}

export function getLease(messageId: string): QueueLease | undefined {
  return leases.get(messageId)
}

export function releaseLease(messageId: string): void {
  leases.delete(messageId)
}

export function leaseEntries(): Array<{ messageId: string; claimToken: string; claimedBy: string }> {
  return [...leases.entries()].map(([messageId, lease]) => ({
    messageId,
    claimToken: lease.claimToken,
    claimedBy: lease.claimedBy,
  }))
}

/** Test helper: simulates a fresh process incarnation (empty register). */
export function clearLeases(): void {
  leases.clear()
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-lease-register.test.ts` → verwacht: PASS (6 tests groen).
- [ ] Commit: `git add src/queue/lease-register.ts __tests__/queue-lease-register.test.ts && git commit -m "feat(queue): in-memory lease-register per proces-incarnatie (fase 2, spec §5.4)"`

---

### Task 6: `src/queue/view.ts` + `src/queue/claim.ts` — presentatie + claim-primitieven

De claim-primitieven volgen het `tryClaimJob`-patroon (`src/tools/wait-for-job.ts` r753+): `FOR UPDATE SKIP LOCKED` in een interactieve `prisma.$transaction`, hier als CTE zoals de CLI (`s4m-queue/src/db.ts::claim`) zodat `previous_status` voor de envelope meekomt. Drie primitieven:

- `claimNextRequest` (§5.3): FIFO-claim van `task/info/review_request` voor het eigen adres, `status='claimed'` + `claimed_by`/`claimed_at`/`started_at`.
- `claimNextReply` (§5.2): het correlatiefilter `in_reply_to = ANY(message_ids)` **ín de WHERE-clause**; claim + auto-ack in één transactie (rij direct naar `done`, `finished_at` gezet — lezen = verwerkt, rij blijft voor audit/idempotente read).
- `rollbackQueueClaim` (§7, MCP-cancel op `queue_next`): `claimed → pending`, alléén bij exacte `claimed_by`-match.

Beide claim-query's bevatten de reclaim-clausule uit de spec-SQL (§5.2): `OR (status='claimed' AND claimed_at < now() - <reclaim>::interval)` met de CLI-default van 4 uur (`S4M_RECLAIM_DEFAULT`-override, zelfde sanity-regex als `s4m-queue/src/config.ts`). Elke statuswissel emit zijn envelope via `pg_notify` bínnen de transactie (vuurt bij COMMIT — geen notify zonder commit, geen commit zonder notify).

**Files:**
- Create: `src/queue/view.ts`
- Create: `src/queue/claim.ts`
- Test: `__tests__/queue-claim.test.ts` (dekt ook `messageView` impliciet via Task 8/9-tests)

**Stappen:**

- [ ] Maak `src/queue/view.ts` met exact deze inhoud (geen eigen test — puur presentatie, gedekt door de tool-tests van Task 9/12/13):

```ts
// Presentation shape shared by queue_status / queue_list / queue_next /
// queue_wait_reply. Structural input type so both Prisma model rows and raw
// AgentMessageRecord rows fit without casts.

export interface QueueMessageLike {
  id: string
  type: string
  from_server: string
  from_model: string
  to_server: string
  to_model: string
  body: string
  meta: unknown
  status: string
  in_reply_to: string | null
  error: string | null
  claimed_by: string | null
  created_at: Date
  finished_at: Date | null
}

export function messageView(row: QueueMessageLike) {
  return {
    id: row.id,
    type: row.type,
    from: `${row.from_server}:${row.from_model}`,
    to: `${row.to_server}:${row.to_model}`,
    status: row.status,
    body: row.body,
    meta: row.meta,
    in_reply_to: row.in_reply_to,
    error: row.error,
    claimed_by: row.claimed_by,
    created_at: row.created_at,
    finished_at: row.finished_at,
  }
}
```

- [ ] Schrijf de failing test `__tests__/queue-claim.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const txMock = vi.hoisted(() => ({ $queryRaw: vi.fn(), $executeRaw: vi.fn() }))

vi.mock('../src/prisma.js', () => ({
  prisma: { $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)) },
}))

import {
  DEFAULT_RECLAIM_AFTER, claimNextReply, claimNextRequest, reclaimInterval, rollbackQueueClaim,
} from '../src/queue/claim.js'

const claimedRow = {
  id: 'msg-1',
  type: 'task',
  from_server: 'max2',
  from_model: 'codex',
  to_server: 'mac',
  to_model: 'claude',
  body: 'do it',
  meta: {},
  source: 'cli',
  status: 'claimed',
  in_reply_to: null,
  error: null,
  claimed_by: 'mcp:inst:tok',
  claimed_at: new Date(),
  started_at: new Date(),
  finished_at: null,
  created_at: new Date(),
  previous_status: 'pending',
}

function sqlOf(call: unknown[]): string {
  return (call[0] as readonly string[]).join(' ')
}

beforeEach(() => {
  vi.clearAllMocks()
  txMock.$queryRaw.mockResolvedValue([])
  txMock.$executeRaw.mockResolvedValue(1)
})
afterEach(() => vi.unstubAllEnvs())

describe('reclaimInterval — CLI-pariteit (s4m-queue/src/config.ts)', () => {
  it('default 4 hours', () => {
    expect(reclaimInterval()).toBe(DEFAULT_RECLAIM_AFTER)
  })

  it('respecteert S4M_RECLAIM_DEFAULT', () => {
    vi.stubEnv('S4M_RECLAIM_DEFAULT', '30 minutes')
    expect(reclaimInterval()).toBe('30 minutes')
  })

  it('valt terug op de default bij een onveilige interval-string', () => {
    vi.stubEnv('S4M_RECLAIM_DEFAULT', "1'; DROP TABLE agent_message; --")
    expect(reclaimInterval()).toBe(DEFAULT_RECLAIM_AFTER)
  })
})

describe('claimNextRequest — FIFO-claim met FOR UPDATE SKIP LOCKED (§5.3)', () => {
  it('geeft null zonder claimbare rij en emit dan géén NOTIFY', async () => {
    const result = await claimNextRequest({ server: 'mac', model: 'claude', claimedBy: 'mcp:i:t' })
    expect(result).toBeNull()
    expect(txMock.$executeRaw).not.toHaveBeenCalled()
  })

  it('claimt atomair en emit een claimed-envelope in dezelfde transactie', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([claimedRow])
    const result = await claimNextRequest({ server: 'mac', model: 'claude', claimedBy: 'mcp:inst:tok' })
    expect(result?.id).toBe('msg-1')
    const sql = sqlOf(txMock.$queryRaw.mock.calls[0])
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain("status = 'pending'")
    expect(sql).toContain("status = 'claimed' AND claimed_at < now()")
    expect(sql).toContain('ORDER BY created_at, id')
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(txMock.$executeRaw.mock.calls[0][2] as string)
    expect(payload).toEqual({
      id: 'msg-1',
      type: 'task',
      from_server: 'max2',
      from_model: 'codex',
      to_server: 'mac',
      to_model: 'claude',
      in_reply_to: null,
      status: 'claimed',
      previous_status: 'pending',
    })
  })
})

describe('claimNextReply — correlatiefilter ín de WHERE-clause + auto-ack (§5.2)', () => {
  it('filtert op in_reply_to = ANY(message_ids) en zet de rij in één transactie op done', async () => {
    const replyRow = {
      ...claimedRow, id: 'r-1', type: 'data', in_reply_to: 'msg-1',
      status: 'done', finished_at: new Date(),
    }
    txMock.$queryRaw.mockResolvedValueOnce([replyRow])
    const result = await claimNextReply({
      server: 'mac', model: 'claude', messageIds: ['msg-1'], claimedBy: 'mcp:inst',
    })
    expect(result?.id).toBe('r-1')
    const sql = sqlOf(txMock.$queryRaw.mock.calls[0])
    expect(sql).toContain('in_reply_to = ANY(')
    expect(sql).toContain("SET status = 'done'")
    expect(sql).toContain('finished_at = now()')
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1)
  })

  it('geeft null als niets claimbaar is', async () => {
    const result = await claimNextReply({
      server: 'mac', model: 'claude', messageIds: ['x'], claimedBy: 'mcp:i',
    })
    expect(result).toBeNull()
  })
})

describe('rollbackQueueClaim — MCP-cancel ná claim (§7)', () => {
  it('zet claimed → pending alleen bij exacte claimed_by-match en emit een requeue-envelope', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([{ ...claimedRow, status: 'pending', claimed_by: null }])
    await rollbackQueueClaim('msg-1', 'mcp:inst:tok')
    const sql = sqlOf(txMock.$queryRaw.mock.calls[0])
    expect(sql).toContain("SET status = 'pending'")
    expect(sql).toContain("status = 'claimed' AND claimed_by =")
    const payload = JSON.parse(txMock.$executeRaw.mock.calls[0][2] as string)
    expect(payload.status).toBe('pending')
    expect(payload.previous_status).toBe('claimed')
  })

  it('doet niets (geen NOTIFY) als de rij inmiddels van een ander is', async () => {
    await rollbackQueueClaim('msg-1', 'mcp:inst:tok')
    expect(txMock.$executeRaw).not.toHaveBeenCalled()
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-claim.test.ts` → verwacht: FAIL (module `src/queue/claim.ts` bestaat niet).
- [ ] Maak `src/queue/claim.ts` met exact deze inhoud:

```ts
// Claim primitives for the s4m-queue tools (spec §5.2/§5.3).
// Pattern: FOR UPDATE SKIP LOCKED CTE inside an interactive Prisma transaction
// with pg_notify INSIDE the transaction (fires at COMMIT) — same consensus as
// pg-boss/Graphile Worker/River/Oban: NOTIFY is wake-up only, the claim query
// is the single source of truth.
import { prisma } from '../prisma.js'
import { QUEUE_CHANNEL, envelopeOf } from './notify.js'
import { REQUEST_TYPES, RESPONSE_TYPES, type QueueModel, type QueueServer } from './types.js'

export const DEFAULT_RECLAIM_AFTER = '4 hours'

/** Same semantics as s4m-queue/src/config.ts: env override with interval sanity check. */
export function reclaimInterval(): string {
  const fromEnv = process.env.S4M_RECLAIM_DEFAULT?.trim()
  if (fromEnv && /^[0-9 a-zA-Z.:-]+$/.test(fromEnv)) return fromEnv
  return DEFAULT_RECLAIM_AFTER
}

export interface AgentMessageRecord {
  id: string
  type: string
  from_server: string
  from_model: string
  to_server: string
  to_model: string
  body: string
  meta: Record<string, unknown>
  source: string
  status: string
  in_reply_to: string | null
  error: string | null
  claimed_by: string | null
  claimed_at: Date | null
  started_at: Date | null
  finished_at: Date | null
  created_at: Date
}

export interface ClaimedAgentMessage extends AgentMessageRecord {
  previous_status: string
}

export async function claimNextRequest(opts: {
  server: QueueServer
  model: QueueModel
  claimedBy: string
}): Promise<ClaimedAgentMessage | null> {
  const reclaim = reclaimInterval()
  const types = [...REQUEST_TYPES]
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimedAgentMessage[]>`
      WITH target AS (
        SELECT id, status FROM agent_message
         WHERE to_server = ${opts.server} AND to_model = ${opts.model}
           AND type = ANY(${types}::text[])
           AND (status = 'pending'
                OR (status = 'claimed' AND claimed_at < now() - ${reclaim}::interval))
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      ),
      updated AS (
        UPDATE agent_message
           SET status = 'claimed', claimed_by = ${opts.claimedBy},
               claimed_at = now(), started_at = now()
         WHERE id IN (SELECT id FROM target)
         RETURNING *
      )
      SELECT updated.*, target.status AS previous_status
        FROM updated JOIN target ON updated.id = target.id
    `
    const row = rows[0]
    if (!row) return null
    const payload = JSON.stringify(envelopeOf(row, row.previous_status))
    await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${payload})`
    return row
  })
}

export async function claimNextReply(opts: {
  server: QueueServer
  model: QueueModel
  messageIds: string[]
  claimedBy: string
}): Promise<ClaimedAgentMessage | null> {
  const reclaim = reclaimInterval()
  const types = [...RESPONSE_TYPES]
  return prisma.$transaction(async (tx) => {
    // §5.2: claim + auto-ack in ONE transaction — reading is processing; the
    // row itself stays (status done) for audit/queue_status and the idempotent
    // read. The correlation filter lives IN the WHERE clause: a session can
    // only ever claim replies to its own request handles.
    const rows = await tx.$queryRaw<ClaimedAgentMessage[]>`
      WITH target AS (
        SELECT id, status FROM agent_message
         WHERE to_server = ${opts.server} AND to_model = ${opts.model}
           AND type = ANY(${types}::text[])
           AND in_reply_to = ANY(${opts.messageIds}::uuid[])
           AND (status = 'pending'
                OR (status = 'claimed' AND claimed_at < now() - ${reclaim}::interval))
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      ),
      updated AS (
        UPDATE agent_message
           SET status = 'done', claimed_by = ${opts.claimedBy},
               claimed_at = now(), started_at = now(), finished_at = now()
         WHERE id IN (SELECT id FROM target)
         RETURNING *
      )
      SELECT updated.*, target.status AS previous_status
        FROM updated JOIN target ON updated.id = target.id
    `
    const row = rows[0]
    if (!row) return null
    const payload = JSON.stringify(envelopeOf(row, row.previous_status))
    await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${payload})`
    return row
  })
}

/** MCP-cancel after a queue_next claim (§7): claimed → pending, exact-owner only. */
export async function rollbackQueueClaim(messageId: string, claimedBy: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<AgentMessageRecord[]>`
      UPDATE agent_message
         SET status = 'pending', claimed_by = NULL, claimed_at = NULL, started_at = NULL
       WHERE id = ${messageId}::uuid
         AND status = 'claimed' AND claimed_by = ${claimedBy}
       RETURNING *
    `
    const row = rows[0]
    if (!row) return
    const payload = JSON.stringify(envelopeOf(row, 'claimed'))
    await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${payload})`
  })
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-claim.test.ts` → verwacht: PASS (9 tests groen).
- [ ] Commit: `git add src/queue/view.ts src/queue/claim.ts __tests__/queue-claim.test.ts && git commit -m "feat(queue): claim-primitieven met correlatiefilter + auto-ack en rollback (fase 2, spec §5.2/§5.3)"`

---

### Task 7: `src/queue/listen.ts` — LISTEN-wakeup-helper (NOTIFY = wake-up only)

De LISTEN-mechaniek uit §5, gedeeld door `queue_wait_reply` en `queue_next`: dedicated `pg.Client` per wait-call op `DATABASE_URL` (patroon `wait_for_job` r2083–2143, `finally { end() }` bij de caller), payload alléén als wake-up-filter (claim-query blijft de bron van waarheid), 5 s-poll-vangnet naast LISTEN, en abort-afhandeling zodat MCP-cancel de wait direct beëindigt. `LISTEN ${QUEUE_CHANNEL}` interpoleert een module-constante (`'agent_queue'`), geen user-input — veilig als identifier.

**Files:**
- Create: `src/queue/listen.ts`
- Test: `__tests__/queue-listen.test.ts`

**Stappen:**

- [ ] Schrijf de failing test `__tests__/queue-listen.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Client } from 'pg'
import { QUEUE_POLL_INTERVAL_MS, waitForQueueWakeup } from '../src/queue/listen.js'

function fakeClient() {
  return new EventEmitter() as unknown as Client & EventEmitter
}

afterEach(() => vi.useRealTimers())

describe('waitForQueueWakeup — NOTIFY is wake-up-only (§5 LISTEN-mechaniek)', () => {
  it('resolvet op een relevante notification en ruimt zijn listener op', async () => {
    const client = fakeClient()
    const ac = new AbortController()
    const p = waitForQueueWakeup(client, ac.signal, (payload) => payload.in_reply_to === 'msg-1')
    client.emit('notification', {
      channel: 'agent_queue',
      payload: JSON.stringify({ in_reply_to: 'msg-1' }),
    })
    await expect(p).resolves.toBeUndefined()
    expect(client.listenerCount('notification')).toBe(0)
  })

  it('negeert irrelevante payloads en kapotte JSON; het poll-vangnet resolvet alsnog', async () => {
    vi.useFakeTimers()
    const client = fakeClient()
    const ac = new AbortController()
    const resolved = vi.fn()
    const p = waitForQueueWakeup(client, ac.signal, (payload) => payload.in_reply_to === 'msg-1')
      .then(resolved)
    client.emit('notification', {
      channel: 'agent_queue',
      payload: JSON.stringify({ in_reply_to: 'ander' }),
    })
    client.emit('notification', { channel: 'agent_queue', payload: 'geen json' })
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    vi.advanceTimersByTime(QUEUE_POLL_INTERVAL_MS)
    await p
    expect(resolved).toHaveBeenCalled()
  })

  it('resolvet op het poll-interval zonder notification (gemiste NOTIFY kost hooguit latency)', async () => {
    vi.useFakeTimers()
    const client = fakeClient()
    const ac = new AbortController()
    const p = waitForQueueWakeup(client, ac.signal, () => false)
    vi.advanceTimersByTime(QUEUE_POLL_INTERVAL_MS)
    await expect(p).resolves.toBeUndefined()
  })

  it('resolvet direct op abort (MCP-cancel tijdens wait)', async () => {
    const client = fakeClient()
    const ac = new AbortController()
    const p = waitForQueueWakeup(client, ac.signal, () => false)
    ac.abort()
    await expect(p).resolves.toBeUndefined()
    expect(client.listenerCount('notification')).toBe(0)
  })

  it('negeert notifications op een ander kanaal', async () => {
    vi.useFakeTimers()
    const client = fakeClient()
    const ac = new AbortController()
    const resolved = vi.fn()
    void waitForQueueWakeup(client, ac.signal, () => true).then(resolved)
    client.emit('notification', { channel: 'scrum4me_changes', payload: '{}' })
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    ac.abort()
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-listen.test.ts` → verwacht: FAIL (module bestaat niet).
- [ ] Maak `src/queue/listen.ts` met exact deze inhoud:

```ts
// LISTEN mechanics shared by the bounded-wait queue tools (spec §5):
// NOTIFY is exclusively a wake-up signal — the claim query is the single
// source of truth (payloads can be lost or duplicated). Dedicated pg.Client
// per wait call on DATABASE_URL; callers own the `finally { end() }`.
// openQueueListener is covered by the integration test (needs a real DB).
import { Client } from 'pg'
import { QUEUE_CHANNEL } from './notify.js'

export const QUEUE_POLL_INTERVAL_MS = 5_000

export async function openQueueListener(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  // QUEUE_CHANNEL is a module constant ('agent_queue'), safe as identifier.
  await client.query(`LISTEN ${QUEUE_CHANNEL}`)
  return client
}

/**
 * Resolves on a relevant NOTIFY payload, on the poll interval, or on abort —
 * whichever comes first. A missed NOTIFY costs at most poll latency, never a
 * hanging agent. The caller re-runs its claim query after every wake-up.
 */
export function waitForQueueWakeup(
  client: Client,
  signal: AbortSignal,
  isRelevant: (payload: Record<string, unknown>) => boolean,
  pollIntervalMs: number = QUEUE_POLL_INTERVAL_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const onNotification = (msg: { channel: string; payload?: string }) => {
      if (msg.channel !== QUEUE_CHANNEL) return
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(msg.payload ?? '{}') as Record<string, unknown>
      } catch {
        return
      }
      if (isRelevant(payload)) finish()
    }
    const onAbort = () => finish()
    const timer = setTimeout(() => finish(), pollIntervalMs)
    function finish() {
      clearTimeout(timer)
      client.removeListener('notification', onNotification)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    client.on('notification', onNotification)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-listen.test.ts` → verwacht: PASS (5 tests groen).
- [ ] Commit: `git add src/queue/listen.ts __tests__/queue-listen.test.ts && git commit -m "feat(queue): LISTEN-wakeup-helper met poll-vangnet en abort (fase 2, spec §5)"`

---

### Task 8: `queue_push` — insert + best-effort NOTIFY + repo-autofill

Spec §5.1. `source='mcp'` (CHECK is in fase 1 uitgebreid). Gemak voor `task`/`review_request`: agent levert `cwd` + inhoudelijke velden in `meta.task`; de tool vult `meta.task.cwd` (expliciete `meta.task.cwd` wint van de parameter) en leidt `meta.task.repo` best-effort af via `git remote get-url origin` in die cwd. Niet afleidbaar én geen expliciete `meta.task.repo` → `VALIDATION_ERROR` met die uitleg. Daarna dezelfde meta-validatie als de CLI (`validateTaskMeta`, Task 2). Respons bevat `message_id` + de `queue_wait_reply`-hint.

**Files:**
- Create: `src/queue/git-origin.ts`
- Create: `src/tools/queue-push.ts`
- Test: `__tests__/queue-git-origin.test.ts`, `__tests__/queue-push.test.ts`

**Stappen:**

- [ ] Schrijf de failing test `__tests__/queue-git-origin.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveRepoFromCwd } from '../src/queue/git-origin.js'

describe('deriveRepoFromCwd — best-effort git remote get-url origin (§5.1)', () => {
  it('geeft null buiten een git-repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-no-repo-'))
    expect(await deriveRepoFromCwd(dir)).toBeNull()
  })

  it('geeft null voor een niet-bestaande cwd', async () => {
    expect(await deriveRepoFromCwd('/pad/dat/niet/bestaat')).toBeNull()
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-git-origin.test.ts` → verwacht: FAIL (module bestaat niet).
- [ ] Maak `src/queue/git-origin.ts` met exact deze inhoud:

```ts
// Best-effort repo derivation for queue_push (spec §5.1): `git remote get-url
// origin` in the caller-supplied cwd. Every failure mode (no repo, no origin,
// missing dir, timeout) returns null — the tool then requires explicit
// meta.task.repo. Separate module so tool tests can vi.mock it.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function deriveRepoFromCwd(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 5_000 })
    const url = stdout.trim()
    return url.length > 0 ? url : null
  } catch {
    return null
  }
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-git-origin.test.ts` → verwacht: PASS (2 tests groen).
- [ ] Schrijf de failing test `__tests__/queue-push.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { agentMessage: { create: vi.fn() }, $executeRaw: vi.fn() },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})
vi.mock('../src/queue/git-origin.js', () => ({ deriveRepoFromCwd: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { deriveRepoFromCwd } from '../src/queue/git-origin.js'
import { registerQueuePushTool } from '../src/tools/queue-push.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as {
  agentMessage: { create: ReturnType<typeof vi.fn> }
  $executeRaw: ReturnType<typeof vi.fn>
}
const mockDerive = deriveRepoFromCwd as ReturnType<typeof vi.fn>
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>

type ToolResult = { isError?: boolean; content: { text: string }[] }

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>) => handler(args) as Promise<ToolResult>,
  }
  registerQueuePushTool(server as unknown as McpServer)
  return server
}

const createdRow = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  type: 'info',
  from_server: 'mac',
  from_model: 'claude',
  to_server: 'scrum4me-server',
  to_model: 'claude',
  body: 'vraag',
  meta: {},
  source: 'mcp',
  status: 'pending',
  in_reply_to: null,
  error: null,
  claimed_by: null,
  claimed_at: null,
  started_at: null,
  finished_at: null,
  created_at: new Date(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('S4M_SERVER', 'mac')
  vi.stubEnv('S4M_MODEL', 'claude')
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
  mockPrisma.agentMessage.create.mockResolvedValue(createdRow)
  mockPrisma.$executeRaw.mockResolvedValue(1)
  mockDerive.mockResolvedValue('https://git.jp-visser.nl/janpeter/x.git')
})
afterEach(() => vi.unstubAllEnvs())

describe('queue_push — §5.1', () => {
  it('insert met source=mcp, status=pending en afzender uit de identiteit', async () => {
    const server = makeServer()
    const result = await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'vraag' })
    const body = JSON.parse(result.content[0].text)
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'info',
        source: 'mcp',
        status: 'pending',
        from_server: 'mac',
        from_model: 'claude',
        to_server: 'scrum4me-server',
        to_model: 'claude',
        body: 'vraag',
      }),
    })
    expect(body.message_id).toBe(createdRow.id)
    expect(body.hint).toContain('queue_wait_reply')
    expect(body.hint).toContain(createdRow.id)
  })

  it('emit een NOTIFY-envelope ná de insert (best-effort)', async () => {
    const server = makeServer()
    await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'vraag' })
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1)
  })

  it('faalt niet wanneer de NOTIFY faalt', async () => {
    mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('notify down'))
    const server = makeServer()
    const result = await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'vraag' })
    expect(result.isError).toBeUndefined()
  })

  it('vult meta.task aan met cwd + afgeleide repo en valideert het task-contract', async () => {
    const server = makeServer()
    await server.call({
      to: 'scrum4me-server:claude',
      type: 'task',
      body: 'doe iets',
      cwd: '/work/dir',
      meta: { task: { objective: 'o', verification: 'v', response_format: 'rf' } },
    })
    expect(mockDerive).toHaveBeenCalledWith('/work/dir')
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: {
          task: {
            cwd: '/work/dir',
            repo: 'https://git.jp-visser.nl/janpeter/x.git',
            objective: 'o',
            verification: 'v',
            response_format: 'rf',
          },
        },
      }),
    })
  })

  it('expliciete meta.task.repo wint van afleiding', async () => {
    const server = makeServer()
    await server.call({
      to: 'scrum4me-server:claude',
      type: 'task',
      body: 'doe iets',
      cwd: '/work/dir',
      meta: {
        task: {
          repo: 'https://elders/x.git', objective: 'o', verification: 'v', response_format: 'rf',
        },
      },
    })
    expect(mockDerive).not.toHaveBeenCalled()
  })

  it('geeft VALIDATION_ERROR met uitleg als repo niet afleidbaar is', async () => {
    mockDerive.mockResolvedValue(null)
    const server = makeServer()
    const result = await server.call({
      to: 'scrum4me-server:claude',
      type: 'task',
      body: 'doe iets',
      cwd: '/geen/repo',
      meta: { task: { objective: 'o', verification: 'v', response_format: 'rf' } },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('VALIDATION_ERROR')
    expect(result.content[0].text).toContain('git remote get-url origin')
    expect(mockPrisma.agentMessage.create).not.toHaveBeenCalled()
  })

  it('geeft VALIDATION_ERROR bij een incompleet task-contract', async () => {
    const server = makeServer()
    const result = await server.call({
      to: 'scrum4me-server:claude',
      type: 'review_request',
      body: 'review dit',
      cwd: '/work/dir',
      meta: { task: { objective: 'o' } },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/VALIDATION_ERROR: meta\.task\./)
  })

  it('info heeft géén meta.task nodig', async () => {
    const server = makeServer()
    const result = await server.call({ to: 'mac:jp', type: 'info', body: 'akkoord?' })
    expect(result.isError).toBeUndefined()
  })

  it("'as' override't het afzender-model", async () => {
    const server = makeServer()
    await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'x', as: 'codex' })
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ from_model: 'codex' }),
    })
  })

  it('QUEUE_IDENTITY_REQUIRED zonder S4M_SERVER', async () => {
    vi.stubEnv('S4M_SERVER', '')
    const server = makeServer()
    const result = await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_IDENTITY_REQUIRED')
  })

  it('VALIDATION_ERROR bij een ongeldig doel', async () => {
    const server = makeServer()
    const result = await server.call({ to: 'mars:claude', type: 'info', body: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('VALIDATION_ERROR: invalid target')
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-push.test.ts` → verwacht: FAIL (module `src/tools/queue-push.ts` bestaat niet).
- [ ] Maak `src/tools/queue-push.ts` met exact deze inhoud:

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { parseQueueTarget, resolveQueueIdentity } from '../queue/identity.js'
import { requiresTaskMeta, validateTaskMeta } from '../queue/types.js'
import { deriveRepoFromCwd } from '../queue/git-origin.js'
import { emitQueueNotifyBestEffort, envelopeOf } from '../queue/notify.js'

const inputSchema = z.object({
  to: z.string().min(1),
  type: z.enum(['task', 'info', 'review_request']),
  body: z.string().min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
  cwd: z.string().min(1).optional(),
  as: z.enum(['claude', 'codex', 'jp']).optional(),
})

export function registerQueuePushTool(server: McpServer) {
  server.registerTool(
    'queue_push',
    {
      title: 'Queue push',
      description:
        'Send a message to another agent or human via the s4m-queue. ' +
        "Target: '<server>:<model>' (servers: mac, scrum4me-server, max2; models: claude, codex, jp). " +
        'Types: task (do something + report result), info (question/data — also for yes/no to jp), ' +
        'review_request (review a document). For task/review_request supply cwd plus meta.task ' +
        '{objective, verification, response_format}; the tool derives meta.task.repo via ' +
        '`git remote get-url origin` in that cwd (pass meta.task.repo explicitly when derivation fails). ' +
        'Returns message_id — fetch the answer later with queue_wait_reply({ message_ids: [message_id] }).',
      inputSchema,
    },
    async ({ to, type, body, meta, cwd, as }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const from = resolveQueueIdentity(as)
        const target = parseQueueTarget(to)

        const finalMeta: Record<string, unknown> = { ...(meta ?? {}) }
        if (requiresTaskMeta(type)) {
          const task: Record<string, unknown> = {
            ...((finalMeta.task as Record<string, unknown> | undefined) ?? {}),
          }
          // Explicit meta.task.cwd wins over the convenience parameter.
          if (cwd && typeof task.cwd !== 'string') task.cwd = cwd
          if (typeof task.repo !== 'string' && typeof task.cwd === 'string') {
            const derived = await deriveRepoFromCwd(task.cwd)
            if (derived) task.repo = derived
          }
          if (typeof task.repo !== 'string') {
            return toolError(
              'VALIDATION_ERROR: meta.task.repo is missing and could not be derived via ' +
                '`git remote get-url origin` in cwd — pass meta.task.repo explicitly',
            )
          }
          finalMeta.task = validateTaskMeta(task) as unknown as Record<string, unknown>
        }

        const row = await prisma.agentMessage.create({
          data: {
            type,
            from_server: from.server,
            from_model: from.model,
            to_server: target.server,
            to_model: target.model,
            body,
            meta: finalMeta as Prisma.InputJsonValue,
            source: 'mcp',
            status: 'pending',
          },
        })
        // NOTIFY after commit, best-effort (§5.1) — CLI --wait and the
        // Messages-dashboard receive the same byte-compatible envelope.
        await emitQueueNotifyBestEffort(envelopeOf(row, null))
        return toolJson({
          message_id: row.id,
          to: `${target.server}:${target.model}`,
          type,
          hint: `Fetch the reply with queue_wait_reply({ message_ids: ["${row.id}"] })`,
        })
      }),
  )
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-push.test.ts` → verwacht: PASS (11 tests groen).
- [ ] Commit: `git add src/queue/git-origin.ts src/tools/queue-push.ts __tests__/queue-git-origin.test.ts __tests__/queue-push.test.ts && git commit -m "feat(queue): queue_push met source=mcp, meta-validatie en repo-autofill (fase 2, spec §5.1)"`

---

### Task 9: `queue_status` + `queue_list` — read-only, niet-claimend

Spec §5.6/§5.7. `queue_status`: bericht + alle replies (`in_reply_to = message_id`), zonder mutatie — "is er al antwoord?". `queue_list`: alle niet-terminale berichten waar het eigen adres afzender óf geadresseerde is; `direction` `sent|received|both` (default `both`), `include_terminal` default `false`. Verloren-handle-herstel (§5.7): na een sessie-crash vindt een nieuwe sessie via `queue_list({direction:'sent'})` de uitstaande request-ids terug voor `queue_wait_reply`.

**Files:**
- Create: `src/tools/queue-status.ts`
- Create: `src/tools/queue-list.ts`
- Test: `__tests__/queue-status.test.ts`, `__tests__/queue-list.test.ts`

**Stappen:**

- [ ] Schrijf de failing test `__tests__/queue-status.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { agentMessage: { findUnique: vi.fn(), findMany: vi.fn() } },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { registerQueueStatusTool } from '../src/tools/queue-status.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as {
  agentMessage: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }
}
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>

type ToolResult = { isError?: boolean; content: { text: string }[] }

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>) => handler(args) as Promise<ToolResult>,
  }
  registerQueueStatusTool(server as unknown as McpServer)
  return server
}

const MSG_ID = 'aaaaaaaa-0000-4000-8000-000000000010'

const requestRow = {
  id: MSG_ID,
  type: 'info',
  from_server: 'mac',
  from_model: 'claude',
  to_server: 'scrum4me-server',
  to_model: 'claude',
  body: 'vraag',
  meta: {},
  source: 'mcp',
  status: 'done',
  in_reply_to: null,
  error: null,
  claimed_by: null,
  claimed_at: null,
  started_at: null,
  finished_at: new Date(),
  created_at: new Date(),
}

const replyRow = {
  ...requestRow,
  id: 'aaaaaaaa-0000-4000-8000-000000000011',
  type: 'data',
  from_server: 'scrum4me-server',
  to_server: 'mac',
  body: 'antwoord',
  in_reply_to: MSG_ID,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
})

describe('queue_status — §5.6', () => {
  it('retourneert bericht + replies in messageView-vorm (from/to samengesteld)', async () => {
    mockPrisma.agentMessage.findUnique.mockResolvedValue(requestRow)
    mockPrisma.agentMessage.findMany.mockResolvedValue([replyRow])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID })
    const body = JSON.parse(result.content[0].text)
    expect(body.message.id).toBe(MSG_ID)
    expect(body.message.from).toBe('mac:claude')
    expect(body.message.to).toBe('scrum4me-server:claude')
    expect(body.replies).toHaveLength(1)
    expect(body.replies[0].in_reply_to).toBe(MSG_ID)
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith({
      where: { in_reply_to: MSG_ID },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })
  })

  it('QUEUE_NOT_FOUND voor een onbekend id', async () => {
    mockPrisma.agentMessage.findUnique.mockResolvedValue(null)
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_FOUND')
    expect(mockPrisma.agentMessage.findMany).not.toHaveBeenCalled()
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-status.test.ts` → verwacht: FAIL (module bestaat niet).
- [ ] Maak `src/tools/queue-status.ts` met exact deze inhoud:

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { messageView } from '../queue/view.js'

const inputSchema = z.object({
  message_id: z.string().uuid(),
})

export function registerQueueStatusTool(server: McpServer) {
  server.registerTool(
    'queue_status',
    {
      title: 'Queue status',
      description:
        'Read-only, non-claiming: one queue message plus all replies to it ' +
        '(in_reply_to = message_id). Use for "is there an answer yet?" without mutating anything.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ message_id }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const row = await prisma.agentMessage.findUnique({ where: { id: message_id } })
        if (!row) return toolError(`QUEUE_NOT_FOUND: message ${message_id} does not exist`)
        const replies = await prisma.agentMessage.findMany({
          where: { in_reply_to: message_id },
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        })
        return toolJson({ message: messageView(row), replies: replies.map(messageView) })
      }),
  )
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-status.test.ts` → verwacht: PASS (2 tests groen).
- [ ] Schrijf de failing test `__tests__/queue-list.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { agentMessage: { findMany: vi.fn() } },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { registerQueueListTool } from '../src/tools/queue-list.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as {
  agentMessage: { findMany: ReturnType<typeof vi.fn> }
}
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>

type ToolResult = { isError?: boolean; content: { text: string }[] }

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>) => handler(args) as Promise<ToolResult>,
  }
  registerQueueListTool(server as unknown as McpServer)
  return server
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('S4M_SERVER', 'mac')
  vi.stubEnv('S4M_MODEL', 'claude')
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
  mockPrisma.agentMessage.findMany.mockResolvedValue([])
})
afterEach(() => vi.unstubAllEnvs())

describe('queue_list — §5.7', () => {
  it("default both + niet-terminaal: OR over eigen adres én status in ('pending','claimed')", async () => {
    const server = makeServer()
    await server.call({ direction: 'both', include_terminal: false })
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { from_server: 'mac', from_model: 'claude' },
          { to_server: 'mac', to_model: 'claude' },
        ],
        status: { in: ['pending', 'claimed'] },
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    })
  })

  it("direction 'sent' filtert alleen op afzender (verloren-handle-herstel)", async () => {
    const server = makeServer()
    await server.call({ direction: 'sent', include_terminal: false })
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ from_server: 'mac', from_model: 'claude' }),
      }),
    )
  })

  it("direction 'received' filtert alleen op geadresseerde", async () => {
    const server = makeServer()
    await server.call({ direction: 'received', include_terminal: false })
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ to_server: 'mac', to_model: 'claude' }),
      }),
    )
  })

  it('include_terminal true laat het statusfilter weg', async () => {
    const server = makeServer()
    await server.call({ direction: 'both', include_terminal: true })
    const arg = mockPrisma.agentMessage.findMany.mock.calls[0][0] as { where: Record<string, unknown> }
    expect(arg.where.status).toBeUndefined()
  })

  it('retourneert messageView-rijen + count', async () => {
    mockPrisma.agentMessage.findMany.mockResolvedValue([
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000020',
        type: 'task',
        from_server: 'mac', from_model: 'claude',
        to_server: 'max2', to_model: 'claude',
        body: 'b', meta: {}, source: 'mcp', status: 'pending',
        in_reply_to: null, error: null, claimed_by: null,
        claimed_at: null, started_at: null, finished_at: null, created_at: new Date(),
      },
    ])
    const server = makeServer()
    const result = await server.call({ direction: 'both', include_terminal: false })
    const body = JSON.parse(result.content[0].text)
    expect(body.count).toBe(1)
    expect(body.messages[0].from).toBe('mac:claude')
    expect(body.messages[0].to).toBe('max2:claude')
  })

  it('QUEUE_IDENTITY_REQUIRED zonder identiteit', async () => {
    vi.stubEnv('S4M_MODEL', '')
    const server = makeServer()
    const result = await server.call({ direction: 'both', include_terminal: false })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_IDENTITY_REQUIRED')
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-list.test.ts` → verwacht: FAIL (module bestaat niet).
- [ ] Maak `src/tools/queue-list.ts` met exact deze inhoud:

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'
import { resolveQueueIdentity } from '../queue/identity.js'
import { messageView } from '../queue/view.js'

const inputSchema = z.object({
  direction: z.enum(['sent', 'received', 'both']).default('both'),
  include_terminal: z.boolean().default(false),
  as: z.enum(['claude', 'codex', 'jp']).optional(),
})

export function registerQueueListTool(server: McpServer) {
  server.registerTool(
    'queue_list',
    {
      title: 'Queue list',
      description:
        'Read-only, non-claiming: queue messages where your own address is sender or addressee. ' +
        'Default: non-terminal only (pending/claimed) — outstanding own requests plus waiting work. ' +
        "Lost-handle recovery: after a session crash, queue_list({direction:'sent'}) returns the " +
        'outstanding request ids — feed them straight into queue_wait_reply; nothing is orphaned.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ direction, include_terminal, as }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const self = resolveQueueIdentity(as)
        const dir = direction ?? 'both'
        const includeTerminal = include_terminal ?? false
        const sent = { from_server: self.server, from_model: self.model }
        const received = { to_server: self.server, to_model: self.model }
        const where: Record<string, unknown> =
          dir === 'sent' ? { ...sent } : dir === 'received' ? { ...received } : { OR: [sent, received] }
        if (!includeTerminal) where.status = { in: ['pending', 'claimed'] }
        const rows = await prisma.agentMessage.findMany({
          where,
          orderBy: { created_at: 'desc' },
          take: 50,
        })
        return toolJson({
          direction: dir,
          include_terminal: includeTerminal,
          count: rows.length,
          messages: rows.map(messageView),
        })
      }),
  )
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-list.test.ts` → verwacht: PASS (6 tests groen).
- [ ] Commit: `git add src/tools/queue-status.ts src/tools/queue-list.ts __tests__/queue-status.test.ts __tests__/queue-list.test.ts && git commit -m "feat(queue): queue_status + queue_list read-only tools (fase 2, spec §5.6/§5.7)"`

---

### Task 10: `src/queue/ownership.ts` + `queue_done` — tweetraps-claimer-check + doneWithReply

Spec §5.4 mét de exacte foutprecedentie uit reviewronde 6, plus de §7-tabelrijen. De beslismatrix (bindend voor code én testnamen; stap a is de token-dragende variant uit §8 — "proces B met A's token … (stap a)"; de tokenloze variant op een claimed rij valt onder §7-rij "zonder geldig claim_token … incl. CLI-claims" → `QUEUE_NOT_CLAIMER`):

| rij-status | lokale lease-entry | claim_token | uitkomst |
|---|---|---|---|
| terminal (done/failed/cancelled) | n.v.t. | n.v.t. | `QUEUE_ALREADY_TERMINAL` (atomair, onder `FOR UPDATE`) |
| pending | n.v.t. | afwezig | ok — FIFO-bypass (per id antwoorden/sluiten zonder claim, CLI-pariteit) |
| pending | n.v.t. | aanwezig | `QUEUE_CLAIM_EXPIRED` (zombie-afronder: zijn claim is gerequeued) |
| claimed | afwezig | aanwezig | `QUEUE_CLAIM_EXPIRED` (stap a — niet van deze proces-incarnatie, óók binnen het lease-venster) |
| claimed | afwezig | afwezig | `QUEUE_NOT_CLAIMER` (CLI-claim/ander proces; MCP rondt andermans claims nooit af) |
| claimed | aanwezig | afwezig of mismatch | `QUEUE_NOT_CLAIMER` (stap b) |
| claimed | aanwezig | match | stap c: atomair in de tx — `claimed_by` moet **exact** gelijk zijn aan `lease.claimedBy` (strikte gelijkheid, geen substring/`LIKE`); mismatch → `QUEUE_NOT_CLAIMER` (vangt races met sweep/herclaim) |

Mét `reply`: transactioneel reply-rij (type volgens `REPLY_TYPE`, `in_reply_to` = request-id, from/to gespiegeld uit de request-rij, `source='mcp'`) + request → `done` + **beide** NOTIFYs in dezelfde transactie — zoals CLI `doneWithReply`. Zónder `reply`: ack (status → `done`). `reply` op een response-type bericht → `VALIDATION_ERROR` (CLI-pariteit: "is geen verzoek"). Na terminale afronding: `releaseLease(message_id)` (§5.4: entry wordt na afronding verwijderd).

**Files:**
- Create: `src/queue/ownership.ts`
- Create: `src/tools/queue-done.ts` (export-naam `registerQueueDoneTool` — fase-3-contract)
- Test: `__tests__/queue-ownership.test.ts`, `__tests__/queue-done.test.ts`

**Stappen:**

- [ ] Schrijf de failing test `__tests__/queue-ownership.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { clearLeases, registerLease } from '../src/queue/lease-register.js'
import { verifyLocalOwnership } from '../src/queue/ownership.js'

beforeEach(() => clearLeases())

describe('verifyLocalOwnership — §5.4-precedentiematrix', () => {
  it('pending zonder token → ok met expectedClaimedBy null (FIFO-bypass)', () => {
    expect(verifyLocalOwnership({ messageId: 'm', rowStatus: 'pending', claimToken: undefined }))
      .toEqual({ ok: true, expectedClaimedBy: null })
  })

  it('pending mét token → QUEUE_CLAIM_EXPIRED (zombie-afronder)', () => {
    const verdict = verifyLocalOwnership({ messageId: 'm', rowStatus: 'pending', claimToken: 'tok' })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toMatch(/^QUEUE_CLAIM_EXPIRED/)
  })

  it('claimed zonder lokale entry, mét token → QUEUE_CLAIM_EXPIRED (stap a, ook binnen het lease-venster)', () => {
    const verdict = verifyLocalOwnership({ messageId: 'm', rowStatus: 'claimed', claimToken: 'tok' })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toMatch(/^QUEUE_CLAIM_EXPIRED/)
  })

  it('claimed zonder lokale entry, zonder token → QUEUE_NOT_CLAIMER (CLI-claims, §7)', () => {
    const verdict = verifyLocalOwnership({ messageId: 'm', rowStatus: 'claimed', claimToken: undefined })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toMatch(/^QUEUE_NOT_CLAIMER/)
  })

  it('entry aanwezig maar token mismatcht → QUEUE_NOT_CLAIMER (stap b)', () => {
    registerLease('m', { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    const verdict = verifyLocalOwnership({ messageId: 'm', rowStatus: 'claimed', claimToken: 'fout' })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toMatch(/^QUEUE_NOT_CLAIMER/)
  })

  it('entry aanwezig maar token ontbreekt → QUEUE_NOT_CLAIMER (stap b)', () => {
    registerLease('m', { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    const verdict = verifyLocalOwnership({ messageId: 'm', rowStatus: 'claimed', claimToken: undefined })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toMatch(/^QUEUE_NOT_CLAIMER/)
  })

  it('entry + matchend token → ok met de volledige verwachte claimed_by voor stap c', () => {
    registerLease('m', { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    expect(verifyLocalOwnership({ messageId: 'm', rowStatus: 'claimed', claimToken: 'tok' }))
      .toEqual({ ok: true, expectedClaimedBy: 'mcp:inst:tok' })
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-ownership.test.ts` → verwacht: FAIL (module bestaat niet).
- [ ] Maak `src/queue/ownership.ts` met exact deze inhoud:

```ts
// Two-stage claimer check (spec §5.4, error precedence pinned in review round 6).
// See the decision matrix in the phase-2 plan. Stage (a)/(b) run against the
// in-memory lease register of THIS process incarnation; stage (c) — strict
// claimed_by equality — is the caller's responsibility inside the same
// FOR UPDATE transaction that read the row.
import { getLease } from './lease-register.js'

export type OwnershipVerdict =
  | { ok: true; expectedClaimedBy: string | null }
  | { ok: false; error: string }

export function verifyLocalOwnership(opts: {
  messageId: string
  rowStatus: string
  claimToken: string | undefined
}): OwnershipVerdict {
  const { messageId, rowStatus, claimToken } = opts

  if (rowStatus === 'pending') {
    if (claimToken !== undefined) {
      // A done/fail WITH token on a pending row signals an expired claim: the
      // zombie finisher must not slip in silently via the FIFO bypass (§5.4).
      return {
        ok: false,
        error:
          `QUEUE_CLAIM_EXPIRED: message ${messageId} is pending again — the claim behind this ` +
          'token was requeued; discard local work and re-claim via queue_next',
      }
    }
    // Tokenless FIFO bypass: answer/close by id without claiming (CLI parity).
    return { ok: true, expectedClaimedBy: null }
  }

  // rowStatus === 'claimed' from here (terminal is handled by the caller).
  const lease = getLease(messageId)
  if (!lease) {
    if (claimToken !== undefined) {
      // Step (a): claim is not from this process incarnation — even while the
      // row is still claimed and even within the lease window.
      return {
        ok: false,
        error:
          `QUEUE_CLAIM_EXPIRED: no active lease for message ${messageId} in this process — ` +
          'claims do not survive an MCP restart; discard local work and re-claim via queue_next',
      }
    }
    // §7: tokenless finish on someone else's claim (CLI or other worker).
    return {
      ok: false,
      error:
        `QUEUE_NOT_CLAIMER: message ${messageId} is claimed by another owner (CLI or another ` +
        'process); the MCP never finishes claims it did not issue — use CLI requeue if stuck',
    }
  }
  if (claimToken === undefined || claimToken !== lease.claimToken) {
    // Step (b): entry present but supplied token missing or mismatching.
    return {
      ok: false,
      error: `QUEUE_NOT_CLAIMER: claim_token does not match the active lease for message ${messageId}`,
    }
  }
  // Step (c) is the caller's atomic DB check against this exact value.
  return { ok: true, expectedClaimedBy: lease.claimedBy }
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-ownership.test.ts` → verwacht: PASS (7 tests groen).
- [ ] Schrijf de failing test `__tests__/queue-done.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const txMock = vi.hoisted(() => ({ $queryRaw: vi.fn(), $executeRaw: vi.fn() }))

vi.mock('../src/prisma.js', () => ({
  prisma: { $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)) },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})

import { requireWriteAccess } from '../src/auth.js'
import { clearLeases, getLease, registerLease } from '../src/queue/lease-register.js'
import { registerQueueDoneTool } from '../src/tools/queue-done.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>

type ToolResult = { isError?: boolean; content: { text: string }[] }

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>) => handler(args) as Promise<ToolResult>,
  }
  registerQueueDoneTool(server as unknown as McpServer)
  return server
}

const MSG_ID = 'aaaaaaaa-0000-4000-8000-000000000030'
const REPLY_ID = 'aaaaaaaa-0000-4000-8000-000000000031'

function requestRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: MSG_ID,
    type: 'task',
    from_server: 'max2',
    from_model: 'codex',
    to_server: 'mac',
    to_model: 'claude',
    body: 'do it',
    meta: {},
    source: 'cli',
    status: 'claimed',
    in_reply_to: null,
    error: null,
    claimed_by: 'mcp:inst:tok',
    claimed_at: new Date(),
    started_at: new Date(),
    finished_at: null,
    created_at: new Date(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearLeases()
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
  txMock.$queryRaw.mockResolvedValue([])
  txMock.$executeRaw.mockResolvedValue(1)
})

describe('queue_done — validaties (§5.4/§7)', () => {
  it('QUEUE_NOT_FOUND voor een onbekend id', async () => {
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_FOUND')
  })

  it('QUEUE_ALREADY_TERMINAL op een al-done bericht', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([requestRow({ status: 'done' })])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_ALREADY_TERMINAL')
  })

  it('mét token op een pending bericht → QUEUE_CLAIM_EXPIRED (zombie-bypass geblokkeerd)', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([requestRow({ status: 'pending', claimed_by: null })])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, claim_token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_CLAIM_EXPIRED')
  })

  it('claimed zonder lokale lease, mét token → QUEUE_CLAIM_EXPIRED (stap a)', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([requestRow()])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, claim_token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_CLAIM_EXPIRED')
  })

  it('claimed zonder lokale lease, tokenloos (CLI-claim) → QUEUE_NOT_CLAIMER', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([requestRow({ claimed_by: 'mac:12345' })])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('entry aanwezig maar verkeerd token → QUEUE_NOT_CLAIMER (stap b)', async () => {
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    txMock.$queryRaw.mockResolvedValueOnce([requestRow()])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, claim_token: 'fout' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('herclaimd door een ander ondanks lokale entry → QUEUE_NOT_CLAIMER (stap c, strikte gelijkheid)', async () => {
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    txMock.$queryRaw.mockResolvedValueOnce([requestRow({ claimed_by: 'mac:99999' })])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, claim_token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('reply op een response-type bericht → VALIDATION_ERROR (CLI-pariteit)', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([
      requestRow({ type: 'data', in_reply_to: 'ander-id', status: 'pending', claimed_by: null }),
    ])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, reply: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('VALIDATION_ERROR')
  })
})

describe('queue_done — happy paths (§5.4)', () => {
  it('eigen claim + reply: reply-rij gespiegeld, request done, beide NOTIFYs, lease released', async () => {
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    const req = requestRow()
    const replyRow = {
      ...req, id: REPLY_ID, type: 'result',
      from_server: 'mac', from_model: 'claude', to_server: 'max2', to_model: 'codex',
      body: 'klaar', in_reply_to: MSG_ID, status: 'pending', claimed_by: null, source: 'mcp',
    }
    const doneRow = { ...req, status: 'done', finished_at: new Date() }
    txMock.$queryRaw
      .mockResolvedValueOnce([req])       // SELECT ... FOR UPDATE
      .mockResolvedValueOnce([replyRow])  // INSERT reply RETURNING *
      .mockResolvedValueOnce([doneRow])   // UPDATE request RETURNING *
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, reply: 'klaar', claim_token: 'tok' })
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ message_id: MSG_ID, status: 'done', reply_id: REPLY_ID })
    // INSERT values: reply type via REPLY_TYPE, from/to gespiegeld, in_reply_to = request-id.
    const insertValues = txMock.$queryRaw.mock.calls[1].slice(1)
    expect(insertValues).toEqual(['result', 'mac', 'claude', 'max2', 'codex', 'klaar', MSG_ID])
    const insertSql = (txMock.$queryRaw.mock.calls[1][0] as readonly string[]).join(' ')
    expect(insertSql).toContain("'mcp'")
    // Twee envelopes: reply (pending/null) en request (done/claimed).
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(2)
    const first = JSON.parse(txMock.$executeRaw.mock.calls[0][2] as string)
    const second = JSON.parse(txMock.$executeRaw.mock.calls[1][2] as string)
    expect(first).toMatchObject({ id: REPLY_ID, status: 'pending', previous_status: null })
    expect(second).toMatchObject({ id: MSG_ID, status: 'done', previous_status: 'claimed' })
    expect(getLease(MSG_ID)).toBeUndefined()
  })

  it('eigen claim zonder reply: ack → done, één NOTIFY, lease released', async () => {
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    const req = requestRow()
    txMock.$queryRaw
      .mockResolvedValueOnce([req])
      .mockResolvedValueOnce([{ ...req, status: 'done', finished_at: new Date() }])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, claim_token: 'tok' })
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ message_id: MSG_ID, status: 'done', reply_id: null })
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1)
    expect(getLease(MSG_ID)).toBeUndefined()
  })

  it('tokenloze FIFO-bypass met reply op een pending request blijft werken', async () => {
    const req = requestRow({ status: 'pending', claimed_by: null })
    const replyRow = {
      ...req, id: REPLY_ID, type: 'result',
      from_server: 'mac', from_model: 'claude', to_server: 'max2', to_model: 'codex',
      body: 'bypass', in_reply_to: MSG_ID, source: 'mcp',
    }
    txMock.$queryRaw
      .mockResolvedValueOnce([req])
      .mockResolvedValueOnce([replyRow])
      .mockResolvedValueOnce([{ ...req, status: 'done', finished_at: new Date() }])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, reply: 'bypass' })
    expect(result.isError).toBeUndefined()
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-done.test.ts` → verwacht: FAIL (module `src/tools/queue-done.ts` bestaat niet).
- [ ] Maak `src/tools/queue-done.ts` met exact deze inhoud:

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { REPLY_TYPE, TERMINAL_STATUSES, isRequestType } from '../queue/types.js'
import { releaseLease } from '../queue/lease-register.js'
import { verifyLocalOwnership } from '../queue/ownership.js'
import { QUEUE_CHANNEL, envelopeOf } from '../queue/notify.js'
import type { AgentMessageRecord } from '../queue/claim.js'

const inputSchema = z.object({
  message_id: z.string().uuid(),
  reply: z.string().min(1).optional(),
  claim_token: z.string().min(1).optional(),
})

type DoneOutcome =
  | { error: string }
  | { done: AgentMessageRecord; replyRow: AgentMessageRecord | null }

export function registerQueueDoneTool(server: McpServer) {
  server.registerTool(
    'queue_done',
    {
      title: 'Queue done',
      description:
        'Finish a queue message. With reply: transactionally insert the reply row ' +
        '(result/data/reviewed, addressed back to the requester) and set the request to done. ' +
        'Without reply: ack/close. Pass the claim_token from queue_next when finishing your own ' +
        'claim. On QUEUE_CLAIM_EXPIRED or QUEUE_NOT_CLAIMER: discard local work and re-claim via ' +
        'queue_next (JOB_CANCELLED pattern) — never resubmit results of an expired claim.',
      inputSchema,
    },
    async ({ message_id, reply, claim_token }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const outcome = await prisma.$transaction(async (tx): Promise<DoneOutcome> => {
          const rows = await tx.$queryRaw<AgentMessageRecord[]>`
            SELECT * FROM agent_message WHERE id = ${message_id}::uuid FOR UPDATE
          `
          const req = rows[0]
          if (!req) return { error: `QUEUE_NOT_FOUND: message ${message_id} does not exist` }
          if ((TERMINAL_STATUSES as readonly string[]).includes(req.status)) {
            return { error: `QUEUE_ALREADY_TERMINAL: message ${message_id} is already ${req.status}` }
          }
          const verdict = verifyLocalOwnership({
            messageId: message_id,
            rowStatus: req.status,
            claimToken: claim_token,
          })
          if (!verdict.ok) return { error: verdict.error }
          // Step (c) — atomic under the FOR UPDATE lock: claimed_by must equal
          // the full expected value EXACTLY (no substring/LIKE). Catches races
          // with sweep/re-claim (§5.4 round-6 precedence).
          if (verdict.expectedClaimedBy !== null && req.claimed_by !== verdict.expectedClaimedBy) {
            return { error: `QUEUE_NOT_CLAIMER: message ${message_id} was re-claimed by another owner` }
          }

          if (reply !== undefined) {
            if (!isRequestType(req.type)) {
              return {
                error:
                  'VALIDATION_ERROR: reply is only possible on request messages ' +
                  `(task/info/review_request); message ${message_id} has type ${req.type}`,
              }
            }
            const replyType = REPLY_TYPE[req.type]
            const ins = await tx.$queryRaw<AgentMessageRecord[]>`
              INSERT INTO agent_message
                (type, from_server, from_model, to_server, to_model, body, in_reply_to, source)
              VALUES
                (${replyType}, ${req.to_server}, ${req.to_model},
                 ${req.from_server}, ${req.from_model}, ${reply}, ${req.id}::uuid, 'mcp')
              RETURNING *
            `
            const upd = await tx.$queryRaw<AgentMessageRecord[]>`
              UPDATE agent_message SET status = 'done', finished_at = now()
               WHERE id = ${req.id}::uuid RETURNING *
            `
            // Both envelopes inside the transaction (fire at COMMIT) — same as
            // CLI doneWithReply: reply row (pending/null) + request (done/prev).
            const replyPayload = JSON.stringify(envelopeOf(ins[0], null))
            await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${replyPayload})`
            const donePayload = JSON.stringify(envelopeOf(upd[0], req.status))
            await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${donePayload})`
            return { done: upd[0], replyRow: ins[0] }
          }

          const upd = await tx.$queryRaw<AgentMessageRecord[]>`
            UPDATE agent_message SET status = 'done', finished_at = now()
             WHERE id = ${req.id}::uuid RETURNING *
          `
          const donePayload = JSON.stringify(envelopeOf(upd[0], req.status))
          await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${donePayload})`
          return { done: upd[0], replyRow: null }
        })

        if ('error' in outcome) return toolError(outcome.error)
        // §5.4: entry removed after terminal completion.
        releaseLease(message_id)
        return toolJson({
          message_id,
          status: 'done',
          reply_id: outcome.replyRow?.id ?? null,
        })
      }),
  )
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-done.test.ts __tests__/queue-ownership.test.ts` → verwacht: PASS (18 tests groen).
- [ ] Commit: `git add src/queue/ownership.ts src/tools/queue-done.ts __tests__/queue-ownership.test.ts __tests__/queue-done.test.ts && git commit -m "feat(queue): queue_done met tweetraps-claimer-check en doneWithReply (fase 2, spec §5.4)"`

---

### Task 11: `queue_fail` — zelfde contract als `queue_done`

Spec §5.5: status → `failed` + error-tekst; zelfde validaties en eigenaarscontract als `queue_done` (hergebruikt `verifyLocalOwnership` — de matrixcellen zelf zijn al gedekt in Task 10; hier alleen de fail-specifieke paden plus een steekproef uit de matrix).

**Files:**
- Create: `src/tools/queue-fail.ts`
- Test: `__tests__/queue-fail.test.ts`

**Stappen:**

- [ ] Schrijf de failing test `__tests__/queue-fail.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const txMock = vi.hoisted(() => ({ $queryRaw: vi.fn(), $executeRaw: vi.fn() }))

vi.mock('../src/prisma.js', () => ({
  prisma: { $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)) },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})

import { requireWriteAccess } from '../src/auth.js'
import { clearLeases, getLease, registerLease } from '../src/queue/lease-register.js'
import { registerQueueFailTool } from '../src/tools/queue-fail.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>

type ToolResult = { isError?: boolean; content: { text: string }[] }

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>) => handler(args) as Promise<ToolResult>,
  }
  registerQueueFailTool(server as unknown as McpServer)
  return server
}

const MSG_ID = 'aaaaaaaa-0000-4000-8000-000000000040'

function requestRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: MSG_ID,
    type: 'task',
    from_server: 'max2',
    from_model: 'codex',
    to_server: 'mac',
    to_model: 'claude',
    body: 'do it',
    meta: {},
    source: 'cli',
    status: 'claimed',
    in_reply_to: null,
    error: null,
    claimed_by: 'mcp:inst:tok',
    claimed_at: new Date(),
    started_at: new Date(),
    finished_at: null,
    created_at: new Date(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearLeases()
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
  txMock.$queryRaw.mockResolvedValue([])
  txMock.$executeRaw.mockResolvedValue(1)
})

describe('queue_fail — §5.5', () => {
  it('QUEUE_NOT_FOUND voor een onbekend id', async () => {
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, error: 'ging mis' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_FOUND')
  })

  it('QUEUE_ALREADY_TERMINAL op een al-failed bericht', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([requestRow({ status: 'failed' })])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, error: 'ging mis' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_ALREADY_TERMINAL')
  })

  it('claimed zonder lokale lease, mét token → QUEUE_CLAIM_EXPIRED (stap a)', async () => {
    txMock.$queryRaw.mockResolvedValueOnce([requestRow()])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, error: 'ging mis', claim_token: 'tok' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_CLAIM_EXPIRED')
  })

  it('entry aanwezig maar verkeerd token → QUEUE_NOT_CLAIMER (stap b)', async () => {
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    txMock.$queryRaw.mockResolvedValueOnce([requestRow()])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, error: 'ging mis', claim_token: 'fout' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('eigen claim: status → failed met error-tekst, NOTIFY-envelope, lease released', async () => {
    registerLease(MSG_ID, { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    const req = requestRow()
    txMock.$queryRaw
      .mockResolvedValueOnce([req])
      .mockResolvedValueOnce([{ ...req, status: 'failed', error: 'ging mis', finished_at: new Date() }])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, error: 'ging mis', claim_token: 'tok' })
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ message_id: MSG_ID, status: 'failed' })
    const updateSql = (txMock.$queryRaw.mock.calls[1][0] as readonly string[]).join(' ')
    expect(updateSql).toContain("SET status = 'failed'")
    expect(txMock.$queryRaw.mock.calls[1][1]).toBe('ging mis')
    const payload = JSON.parse(txMock.$executeRaw.mock.calls[0][2] as string)
    expect(payload).toMatchObject({ id: MSG_ID, status: 'failed', previous_status: 'claimed' })
    expect(getLease(MSG_ID)).toBeUndefined()
  })

  it('tokenloze fail op een pending bericht is toegestaan (CLI-pariteit)', async () => {
    const req = requestRow({ status: 'pending', claimed_by: null })
    txMock.$queryRaw
      .mockResolvedValueOnce([req])
      .mockResolvedValueOnce([{ ...req, status: 'failed', error: 'kapot', finished_at: new Date() }])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID, error: 'kapot' })
    expect(result.isError).toBeUndefined()
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-fail.test.ts` → verwacht: FAIL (module bestaat niet).
- [ ] Maak `src/tools/queue-fail.ts` met exact deze inhoud:

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { TERMINAL_STATUSES } from '../queue/types.js'
import { releaseLease } from '../queue/lease-register.js'
import { verifyLocalOwnership } from '../queue/ownership.js'
import { QUEUE_CHANNEL, envelopeOf } from '../queue/notify.js'
import type { AgentMessageRecord } from '../queue/claim.js'

const inputSchema = z.object({
  message_id: z.string().uuid(),
  error: z.string().min(1),
  claim_token: z.string().min(1).optional(),
})

type FailOutcome = { error: string } | { failed: AgentMessageRecord }

export function registerQueueFailTool(server: McpServer) {
  server.registerTool(
    'queue_fail',
    {
      title: 'Queue fail',
      description:
        'Mark a queue message as failed with an error text (stop-at-first-error contract: ' +
        'when required context is missing, fail — do not guess). Same validations and ownership ' +
        'contract as queue_done: pass the claim_token from queue_next for your own claim; on ' +
        'QUEUE_CLAIM_EXPIRED or QUEUE_NOT_CLAIMER discard local work and re-claim via queue_next.',
      inputSchema,
    },
    async ({ message_id, error, claim_token }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const outcome = await prisma.$transaction(async (tx): Promise<FailOutcome> => {
          const rows = await tx.$queryRaw<AgentMessageRecord[]>`
            SELECT * FROM agent_message WHERE id = ${message_id}::uuid FOR UPDATE
          `
          const req = rows[0]
          if (!req) return { error: `QUEUE_NOT_FOUND: message ${message_id} does not exist` }
          if ((TERMINAL_STATUSES as readonly string[]).includes(req.status)) {
            return { error: `QUEUE_ALREADY_TERMINAL: message ${message_id} is already ${req.status}` }
          }
          const verdict = verifyLocalOwnership({
            messageId: message_id,
            rowStatus: req.status,
            claimToken: claim_token,
          })
          if (!verdict.ok) return { error: verdict.error }
          if (verdict.expectedClaimedBy !== null && req.claimed_by !== verdict.expectedClaimedBy) {
            return { error: `QUEUE_NOT_CLAIMER: message ${message_id} was re-claimed by another owner` }
          }

          const upd = await tx.$queryRaw<AgentMessageRecord[]>`
            UPDATE agent_message SET status = 'failed', error = ${error}, finished_at = now()
             WHERE id = ${req.id}::uuid RETURNING *
          `
          const payload = JSON.stringify(envelopeOf(upd[0], req.status))
          await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${payload})`
          return { failed: upd[0] }
        })

        if ('error' in outcome) return toolError(outcome.error)
        releaseLease(message_id)
        return toolJson({ message_id, status: 'failed' })
      }),
  )
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-fail.test.ts` → verwacht: PASS (6 tests groen).
- [ ] Commit: `git add src/tools/queue-fail.ts __tests__/queue-fail.test.ts && git commit -m "feat(queue): queue_fail met zelfde eigenaarscontract als queue_done (fase 2, spec §5.5)"`

---

### Task 12: `queue_wait_reply` — de mis-routing-fix (idempotente read + drain + bounded wait)

Spec §5.2. Flow: (1) **idempotente read** — alle al-`done` replies op de opgegeven set (at-least-once: een commit waarvan het toolresultaat de client nooit bereikte gaat niet verloren); (2) **drain** — alle nu claimbare replies via `claimNextReply` (claim+auto-ack in één transactie per rij); (3) alles beschikbaar → álle replies in één respons, elk mét `in_reply_to` (voortgangscontract — nooit één-voor-één met herhaling); (4) niets beschikbaar → bounded wait via LISTEN met `in_reply_to`-filter op de payload + 5 s-poll, `wait_seconds` 0–600 default 300; (5) timeout → `{status:'timeout', replies: []}` — géén error. Geen cancel-rollback nodig: claim+ack is één transactie; de idempotente read vangt post-commit-verlies. Caller-protocol in de description: beantwoorde ids uit de volgende aanroep verwijderen.

**Files:**
- Create: `src/tools/queue-wait-reply.ts`
- Test: `__tests__/queue-wait-reply.test.ts`

**Stappen:**

- [ ] Schrijf de failing test `__tests__/queue-wait-reply.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { agentMessage: { findMany: vi.fn() } },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})
vi.mock('../src/queue/claim.js', () => ({ claimNextReply: vi.fn() }))
vi.mock('../src/queue/listen.js', () => ({
  QUEUE_POLL_INTERVAL_MS: 5_000,
  openQueueListener: vi.fn(),
  waitForQueueWakeup: vi.fn(),
}))
vi.mock('../src/presence/instance.js', () => ({ getInstanceId: vi.fn(() => 'inst-1') }))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { claimNextReply } from '../src/queue/claim.js'
import { openQueueListener, waitForQueueWakeup } from '../src/queue/listen.js'
import { registerQueueWaitReplyTool } from '../src/tools/queue-wait-reply.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as { agentMessage: { findMany: ReturnType<typeof vi.fn> } }
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockClaim = claimNextReply as ReturnType<typeof vi.fn>
const mockOpen = openQueueListener as ReturnType<typeof vi.fn>
const mockWakeup = waitForQueueWakeup as ReturnType<typeof vi.fn>

type ToolResult = { isError?: boolean; content: { text: string }[] }
type Extra = { signal?: AbortSignal }

function makeServer() {
  let handler: (args: Record<string, unknown>, extra?: Extra) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>, extra?: Extra) => handler(args, extra) as Promise<ToolResult>,
  }
  registerQueueWaitReplyTool(server as unknown as McpServer)
  return server
}

const REQ_A = 'aaaaaaaa-0000-4000-8000-0000000000a1'
const REQ_B = 'aaaaaaaa-0000-4000-8000-0000000000b1'

function reply(id: string, inReplyTo: string) {
  return {
    id,
    type: 'data',
    from_server: 'scrum4me-server',
    from_model: 'claude',
    to_server: 'mac',
    to_model: 'claude',
    body: `antwoord op ${inReplyTo}`,
    meta: {},
    source: 'cli',
    status: 'done',
    in_reply_to: inReplyTo,
    error: null,
    claimed_by: 'mcp:inst-1',
    claimed_at: new Date(),
    started_at: new Date(),
    finished_at: new Date(),
    created_at: new Date(),
  }
}
const REPLY_A = reply('aaaaaaaa-0000-4000-8000-0000000000a2', REQ_A)
const REPLY_B = reply('aaaaaaaa-0000-4000-8000-0000000000b2', REQ_B)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('S4M_SERVER', 'mac')
  vi.stubEnv('S4M_MODEL', 'claude')
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
  mockPrisma.agentMessage.findMany.mockResolvedValue([])
  mockClaim.mockResolvedValue(null)
  mockOpen.mockResolvedValue({ end: vi.fn().mockResolvedValue(undefined) })
  mockWakeup.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllEnvs())

describe('queue_wait_reply — §5.2', () => {
  it('idempotente read: al-done replies komen direct terug, elk met in_reply_to', async () => {
    mockPrisma.agentMessage.findMany.mockResolvedValue([REPLY_A])
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A], wait_seconds: 0 })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('ok')
    expect(body.replies).toHaveLength(1)
    expect(body.replies[0].in_reply_to).toBe(REQ_A)
    expect(body.hint).toContain('Remove answered request-ids')
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith({
      where: {
        in_reply_to: { in: [REQ_A] },
        to_server: 'mac',
        to_model: 'claude',
        status: 'done',
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })
  })

  it('drain: alle nu claimbare replies in één respons (voortgangscontract)', async () => {
    mockClaim
      .mockResolvedValueOnce({ ...REPLY_A, previous_status: 'pending' })
      .mockResolvedValueOnce({ ...REPLY_B, previous_status: 'pending' })
      .mockResolvedValueOnce(null)
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A, REQ_B], wait_seconds: 0 })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('ok')
    expect(body.replies.map((r: { in_reply_to: string }) => r.in_reply_to).sort())
      .toEqual([REQ_A, REQ_B].sort())
  })

  it('dedupliceert op reply-id (idempotente read + drain overlappen nooit dubbel)', async () => {
    mockPrisma.agentMessage.findMany.mockResolvedValue([REPLY_A])
    mockClaim
      .mockResolvedValueOnce({ ...REPLY_A, previous_status: 'pending' })
      .mockResolvedValueOnce(null)
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A], wait_seconds: 0 })
    const body = JSON.parse(result.content[0].text)
    expect(body.replies).toHaveLength(1)
  })

  it('audit-claimedBy is mcp:<instance_id>', async () => {
    mockClaim.mockResolvedValueOnce({ ...REPLY_A, previous_status: 'pending' }).mockResolvedValueOnce(null)
    const server = makeServer()
    await server.call({ message_ids: [REQ_A], wait_seconds: 0 })
    expect(mockClaim).toHaveBeenCalledWith({
      server: 'mac',
      model: 'claude',
      messageIds: [REQ_A],
      claimedBy: 'mcp:inst-1',
    })
  })

  it('wait_seconds 0 zonder replies → status timeout, replies [], géén LISTEN', async () => {
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A], wait_seconds: 0 })
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ status: 'timeout', replies: [] })
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('bounded wait: LISTEN + herclaim na wake-up, listener wordt altijd gesloten', async () => {
    const end = vi.fn().mockResolvedValue(undefined)
    mockOpen.mockResolvedValue({ end })
    mockPrisma.agentMessage.findMany
      .mockResolvedValueOnce([])        // collect 1 (pre-LISTEN)
      .mockResolvedValueOnce([])        // collect 2 (direct na LISTEN)
      .mockResolvedValueOnce([REPLY_A]) // collect 3 (na wake-up)
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A], wait_seconds: 30 })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('ok')
    expect(body.replies[0].id).toBe(REPLY_A.id)
    expect(mockWakeup).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('abort vóór de wait → direct timeout zonder LISTEN', async () => {
    const ac = new AbortController()
    ac.abort()
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A], wait_seconds: 300 }, { signal: ac.signal })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('timeout')
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('QUEUE_IDENTITY_REQUIRED zonder identiteit', async () => {
    vi.stubEnv('S4M_SERVER', '')
    const server = makeServer()
    const result = await server.call({ message_ids: [REQ_A], wait_seconds: 0 })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_IDENTITY_REQUIRED')
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-wait-reply.test.ts` → verwacht: FAIL (module bestaat niet).
- [ ] Maak `src/tools/queue-wait-reply.ts` met exact deze inhoud:

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'
import { resolveQueueIdentity } from '../queue/identity.js'
import { claimNextReply } from '../queue/claim.js'
import { openQueueListener, waitForQueueWakeup } from '../queue/listen.js'
import { getInstanceId } from '../presence/instance.js'
import { messageView, type QueueMessageLike } from '../queue/view.js'
import type { QueueAddress } from '../queue/types.js'

const CALLER_PROTOCOL =
  'Remove answered request-ids from the next queue_wait_reply call; every reply carries its in_reply_to.'

const DEFAULT_WAIT_SECONDS = 300

const inputSchema = z.object({
  message_ids: z.array(z.string().uuid()).min(1).max(100),
  wait_seconds: z.number().int().min(0).max(600).default(DEFAULT_WAIT_SECONDS),
  as: z.enum(['claude', 'codex', 'jp']).optional(),
})

interface ToolExtra {
  signal?: AbortSignal
}

/**
 * §5.2: idempotent read (already-done replies stay retrievable — at-least-once
 * delivery to the requester) + drain of every currently claimable reply
 * (claim + auto-ack per row). Returns ALL available replies in one response.
 */
async function collectAvailableReplies(
  self: QueueAddress,
  messageIds: string[],
  claimedBy: string,
): Promise<Array<ReturnType<typeof messageView>>> {
  const alreadyDone = (await prisma.agentMessage.findMany({
    where: {
      in_reply_to: { in: messageIds },
      to_server: self.server,
      to_model: self.model,
      status: 'done',
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  })) as QueueMessageLike[]
  const byId = new Map<string, ReturnType<typeof messageView>>()
  for (const row of alreadyDone) byId.set(row.id, messageView(row))
  for (;;) {
    const claimed = await claimNextReply({
      server: self.server,
      model: self.model,
      messageIds,
      claimedBy,
    })
    if (!claimed) break
    byId.set(claimed.id, messageView(claimed))
  }
  return [...byId.values()]
}

export function registerQueueWaitReplyTool(server: McpServer) {
  server.registerTool(
    'queue_wait_reply',
    {
      title: 'Queue wait reply',
      description:
        'Fetch replies to YOUR OWN queue_push requests — the correlation filter (in_reply_to) is ' +
        'part of the claim query, so parallel sessions can never steal each other\'s answers. ' +
        'Returns ALL currently available replies for the given set in one response, each with its ' +
        'in_reply_to; remove answered request-ids from the next call. Already-delivered replies are ' +
        'returned again (idempotent read, at-least-once). wait_seconds 0 = non-blocking check; ' +
        'default 300 = block until the first reply. Timeout returns {status:"timeout"} — not an ' +
        'error, simply call again.',
      inputSchema,
    },
    async ({ message_ids, wait_seconds, as }, extra?: ToolExtra) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const self = resolveQueueIdentity(as)
        const waitSeconds = wait_seconds ?? DEFAULT_WAIT_SECONDS
        const signal = extra?.signal ?? new AbortController().signal
        // Audit-only claimed_by for auto-acked replies; no lease (claim+ack is
        // one transaction — there is nothing to finish later).
        const claimedBy = `mcp:${getInstanceId()}`

        let replies = await collectAvailableReplies(self, message_ids, claimedBy)
        if (replies.length > 0) return toolJson({ status: 'ok', replies, hint: CALLER_PROTOCOL })
        if (waitSeconds === 0 || signal.aborted) return toolJson({ status: 'timeout', replies: [] })

        const deadline = Date.now() + waitSeconds * 1000
        const idSet = new Set<string>(message_ids)
        const listenClient = await openQueueListener()
        try {
          // One direct attempt right after LISTEN — closes the setup gap (§5).
          replies = await collectAvailableReplies(self, message_ids, claimedBy)
          if (replies.length > 0) return toolJson({ status: 'ok', replies, hint: CALLER_PROTOCOL })
          while (Date.now() < deadline && !signal.aborted) {
            await waitForQueueWakeup(listenClient, signal, (payload) =>
              typeof payload.in_reply_to === 'string' && idSet.has(payload.in_reply_to),
            )
            if (signal.aborted) break
            replies = await collectAvailableReplies(self, message_ids, claimedBy)
            if (replies.length > 0) return toolJson({ status: 'ok', replies, hint: CALLER_PROTOCOL })
          }
        } finally {
          await listenClient.end().catch(() => {})
        }
        // §7: timeout is not an error. No cancel rollback needed either —
        // claim+ack is one transaction; the idempotent read catches
        // post-commit loss on the next call.
        return toolJson({ status: 'timeout', replies: [] })
      }),
  )
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-wait-reply.test.ts` → verwacht: PASS (8 tests groen).
- [ ] Commit: `git add src/tools/queue-wait-reply.ts __tests__/queue-wait-reply.test.ts && git commit -m "feat(queue): queue_wait_reply met correlatiefilter, idempotente read en drain (fase 2, spec §5.2)"`

---

### Task 13: `queue_next` — FIFO-claim met claim-token, bounded wait en MCP-cancel

Spec §5.3. FIFO-claim van het volgende request voor het eigen adres (competing consumers is hier gewénst — geen `in_reply_to`-filter). De claim genereert een onvoorspelbaar token (`crypto.randomUUID()`), schrijft `claimed_by = 'mcp:<instance_id>:<claim_token>'` (bestaand text-veld; `<instance_id>` is puur audit) en registreert de lease lokaal. Respons = bericht + `claim_token` + uitvoeringsinstructie. `wait_seconds` 0–600 **default 0**.

**MCP-cancel-onderzoek (afgerond, vastgelegd):** `@modelcontextprotocol/sdk` 1.29.0 geeft het abort-signal als tweede handler-argument: `ToolCallback = (args, extra: RequestHandlerExtra<…>) => …` met `extra.signal: AbortSignal` — "An abort signal used to communicate if the request was cancelled from the sender's side" (geverifieerd in `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts` en `server/mcp.d.ts` r250/r261; het signal vuurt op `notifications/cancelled`). `wait_for_job` gebruikt dit vandaag níet — `queue_next` wél (§5 LISTEN-mechaniek, expliciet nieuw): cancel **vóór** de claim → niets muteren; **tijdens** de wait → wait direct beëindigen, timeout; **direct ná** de claim-transactie → `rollbackQueueClaim` (claimed → pending) + `releaseLease` (§7).

**Files:**
- Create: `src/tools/queue-next.ts`
- Test: `__tests__/queue-next.test.ts`

**Stappen:**

- [ ] Verifieer het SDK-contract (documentatiestap, geen code): `grep -n "signal: AbortSignal" node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts` → verwacht: één hit in `RequestHandlerExtra`.
- [ ] Schrijf de failing test `__tests__/queue-next.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})
vi.mock('../src/queue/claim.js', () => ({
  claimNextRequest: vi.fn(),
  rollbackQueueClaim: vi.fn(),
}))
vi.mock('../src/queue/listen.js', () => ({
  QUEUE_POLL_INTERVAL_MS: 5_000,
  openQueueListener: vi.fn(),
  waitForQueueWakeup: vi.fn(),
}))
vi.mock('../src/presence/instance.js', () => ({ getInstanceId: vi.fn(() => 'inst-1') }))

import { requireWriteAccess } from '../src/auth.js'
import { claimNextRequest, rollbackQueueClaim } from '../src/queue/claim.js'
import { openQueueListener, waitForQueueWakeup } from '../src/queue/listen.js'
import { clearLeases, getLease, leaseEntries } from '../src/queue/lease-register.js'
import { registerQueueNextTool } from '../src/tools/queue-next.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockClaim = claimNextRequest as ReturnType<typeof vi.fn>
const mockRollback = rollbackQueueClaim as ReturnType<typeof vi.fn>
const mockOpen = openQueueListener as ReturnType<typeof vi.fn>
const mockWakeup = waitForQueueWakeup as ReturnType<typeof vi.fn>

type ToolResult = { isError?: boolean; content: { text: string }[] }
type Extra = { signal?: AbortSignal }

function makeServer() {
  let handler: (args: Record<string, unknown>, extra?: Extra) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>, extra?: Extra) => handler(args, extra) as Promise<ToolResult>,
  }
  registerQueueNextTool(server as unknown as McpServer)
  return server
}

const MSG_ID = 'aaaaaaaa-0000-4000-8000-000000000050'

function claimedRow(claimedBy: string) {
  return {
    id: MSG_ID,
    type: 'task',
    from_server: 'max2',
    from_model: 'codex',
    to_server: 'mac',
    to_model: 'claude',
    body: 'do it',
    meta: { task: { cwd: '/w', repo: 'r', objective: 'o', verification: 'v', response_format: 'rf' } },
    source: 'cli',
    status: 'claimed',
    in_reply_to: null,
    error: null,
    claimed_by: claimedBy,
    claimed_at: new Date(),
    started_at: new Date(),
    finished_at: null,
    created_at: new Date(),
    previous_status: 'pending',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearLeases()
  vi.stubEnv('S4M_SERVER', 'mac')
  vi.stubEnv('S4M_MODEL', 'claude')
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
  mockClaim.mockResolvedValue(null)
  mockRollback.mockResolvedValue(undefined)
  mockOpen.mockResolvedValue({ end: vi.fn().mockResolvedValue(undefined) })
  mockWakeup.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllEnvs())

describe('queue_next — §5.3', () => {
  it('claimt FIFO met claimed_by = mcp:<instance_id>:<token> en registreert de lease', async () => {
    mockClaim.mockImplementation(async ({ claimedBy }: { claimedBy: string }) => claimedRow(claimedBy))
    const server = makeServer()
    const result = await server.call({ wait_seconds: 0 })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('claimed')
    expect(body.message.id).toBe(MSG_ID)
    expect(body.claim_token).toBeTruthy()
    expect(body.instructions).toContain('meta.task.cwd')
    expect(body.instructions).toContain('queue_fail')
    const claimedBy = mockClaim.mock.calls[0][0].claimedBy as string
    expect(claimedBy).toBe(`mcp:inst-1:${body.claim_token}`)
    expect(getLease(MSG_ID)).toEqual({ claimToken: body.claim_token, claimedBy })
  })

  it('geen bericht + wait_seconds 0 → timeout zonder LISTEN', async () => {
    const server = makeServer()
    const result = await server.call({ wait_seconds: 0 })
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ status: 'timeout', message: null })
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('bounded wait: herclaim na wake-up, listener wordt gesloten', async () => {
    const end = vi.fn().mockResolvedValue(undefined)
    mockOpen.mockResolvedValue({ end })
    mockClaim
      .mockResolvedValueOnce(null) // directe poging
      .mockResolvedValueOnce(null) // direct na LISTEN
      .mockImplementationOnce(async ({ claimedBy }: { claimedBy: string }) => claimedRow(claimedBy))
    const server = makeServer()
    const result = await server.call({ wait_seconds: 30 })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('claimed')
    expect(mockWakeup).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('cancel vóór de claim: er wordt niets geclaimd of geregistreerd', async () => {
    const ac = new AbortController()
    ac.abort()
    const server = makeServer()
    const result = await server.call({ wait_seconds: 0 }, { signal: ac.signal })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('timeout')
    expect(mockClaim).not.toHaveBeenCalled()
    expect(leaseEntries()).toEqual([])
  })

  it('cancel tijdens de wait: wait stopt, geen claim, timeout', async () => {
    const ac = new AbortController()
    mockWakeup.mockImplementation(async () => {
      ac.abort()
    })
    const server = makeServer()
    const result = await server.call({ wait_seconds: 30 }, { signal: ac.signal })
    const body = JSON.parse(result.content[0].text)
    expect(body.status).toBe('timeout')
    expect(mockClaim).toHaveBeenCalledTimes(2) // directe poging + direct na LISTEN, niet ná abort
  })

  it('cancel direct ná de claim-transactie: rollbackClaim + lease released (§7)', async () => {
    const ac = new AbortController()
    mockClaim.mockImplementation(async ({ claimedBy }: { claimedBy: string }) => {
      ac.abort() // cancel arriveert precies tussen commit en respons
      return claimedRow(claimedBy)
    })
    const server = makeServer()
    const result = await server.call({ wait_seconds: 0 }, { signal: ac.signal })
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ status: 'cancelled', message: null })
    const claimedBy = mockClaim.mock.calls[0][0].claimedBy as string
    expect(mockRollback).toHaveBeenCalledWith(MSG_ID, claimedBy)
    expect(getLease(MSG_ID)).toBeUndefined()
  })

  it('QUEUE_IDENTITY_REQUIRED zonder identiteit', async () => {
    vi.stubEnv('S4M_MODEL', '')
    const server = makeServer()
    const result = await server.call({ wait_seconds: 0 })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_IDENTITY_REQUIRED')
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-next.test.ts` → verwacht: FAIL (module bestaat niet).
- [ ] Maak `src/tools/queue-next.ts` met exact deze inhoud:

```ts
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'
import { resolveQueueIdentity } from '../queue/identity.js'
import { claimNextRequest, rollbackQueueClaim, type ClaimedAgentMessage } from '../queue/claim.js'
import { registerLease, releaseLease } from '../queue/lease-register.js'
import { openQueueListener, waitForQueueWakeup } from '../queue/listen.js'
import { getInstanceId } from '../presence/instance.js'
import { messageView } from '../queue/view.js'
import { REQUEST_TYPES, type QueueAddress } from '../queue/types.js'

const INSTRUCTIONS_TEXT =
  'Execute within meta.task.cwd. If required context is missing → queue_fail, do not guess. ' +
  'Finish from THIS session with queue_done({ message_id, reply, claim_token }) or ' +
  'queue_fail({ message_id, error, claim_token }); claims do not survive an MCP restart.'

const inputSchema = z.object({
  wait_seconds: z.number().int().min(0).max(600).default(0),
  as: z.enum(['claude', 'codex', 'jp']).optional(),
})

interface ToolExtra {
  signal?: AbortSignal
}

interface ClaimResult {
  row: ClaimedAgentMessage
  claimToken: string
  claimedBy: string
}

async function tryClaim(self: QueueAddress): Promise<ClaimResult | null> {
  // Unpredictable per-claim token — ownership proof for queue_done/queue_fail
  // (§5.3). <instance_id> in claimed_by is audit only; the checks compare the
  // full string and the local lease register, never the instance id.
  const claimToken = randomUUID()
  const claimedBy = `mcp:${getInstanceId()}:${claimToken}`
  const row = await claimNextRequest({ server: self.server, model: self.model, claimedBy })
  if (!row) return null
  registerLease(row.id, { claimToken, claimedBy })
  return { row, claimToken, claimedBy }
}

export function registerQueueNextTool(server: McpServer) {
  server.registerTool(
    'queue_next',
    {
      title: 'Queue next',
      description:
        'Claim the next queue request (task/info/review_request) addressed to you, FIFO. ' +
        'Returns the message plus a claim_token — keep it and pass it to queue_done/queue_fail. ' +
        'Execute within meta.task.cwd; missing required context → queue_fail, do not guess. ' +
        'wait_seconds 0 (default) = non-blocking; up to 600 = bounded wait for new work. ' +
        'Timeout returns {status:"timeout"} — not an error.',
      inputSchema,
    },
    async ({ wait_seconds, as }, extra?: ToolExtra) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const self = resolveQueueIdentity(as)
        const waitSeconds = wait_seconds ?? 0
        const signal = extra?.signal ?? new AbortController().signal

        // MCP-cancel BEFORE any claim: nothing was mutated (§7).
        if (signal.aborted) return toolJson({ status: 'timeout', message: null })

        let claimed = await tryClaim(self)
        if (!claimed && waitSeconds > 0) {
          const deadline = Date.now() + waitSeconds * 1000
          const listenClient = await openQueueListener()
          try {
            // One direct attempt right after LISTEN — closes the setup gap (§5).
            claimed = await tryClaim(self)
            while (!claimed && Date.now() < deadline && !signal.aborted) {
              await waitForQueueWakeup(listenClient, signal, (payload) =>
                (payload.status === undefined || payload.status === 'pending') &&
                payload.to_server === self.server &&
                payload.to_model === self.model &&
                typeof payload.type === 'string' &&
                (REQUEST_TYPES as readonly string[]).includes(payload.type),
              )
              if (signal.aborted) break
              claimed = await tryClaim(self)
            }
          } finally {
            await listenClient.end().catch(() => {})
          }
        }

        if (!claimed) return toolJson({ status: 'timeout', message: null })

        if (signal.aborted) {
          // MCP-cancel right after the claim transaction: the response will
          // never reach the client — roll back (claimed → pending) and drop
          // the lease (§7). Rollback matches on exact claimed_by only.
          releaseLease(claimed.row.id)
          await rollbackQueueClaim(claimed.row.id, claimed.claimedBy)
          return toolJson({ status: 'cancelled', message: null })
        }

        return toolJson({
          status: 'claimed',
          message: messageView(claimed.row),
          claim_token: claimed.claimToken,
          instructions: INSTRUCTIONS_TEXT,
        })
      }),
  )
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-next.test.ts` → verwacht: PASS (7 tests groen).
- [ ] Commit: `git add src/tools/queue-next.ts __tests__/queue-next.test.ts && git commit -m "feat(queue): queue_next met claim-token, bounded wait en MCP-cancel-rollback (fase 2, spec §5.3)"`

---

### Task 14: Registratie stdio-only + bewijs dat HTTP ze niet exposeert

Spec §5-intro: queue-tools stdio-only — niet vanwege filesystem-binding (worktree-groep) maar vanwege **caller-identiteit**: het stdio-proces draagt `S4M_SERVER`/`S4M_MODEL` én het in-memory lease-register; de centrale HTTP-server heeft geen van beide. Daarom een **eigen** registratiegroep `registerQueueTools()` in `src/register.ts` (niet in `registerWorktreeTools` gestopt — andere reden, eigen groep, zelfde patroon), aangeroepen door alléén `src/index.ts`. `src/http.ts` krijgt één minimale wijziging: `createMcpServer` wordt exporteerbaar zodat de test op de geregistreerde toolnamen van de échte HTTP-server kan asserteren (§8 E2E-matrix, MCP-deel).

**Files:**
- Modify: `src/register.ts` (imports na r75; nieuwe functie na `registerWorktreeTools`, r146–153)
- Modify: `src/index.ts` (import r4; registratie na r40 `registerWorktreeTools(server)`)
- Modify: `src/http.ts` (r69: `function createMcpServer` → `export function createMcpServer`)
- Test: `__tests__/queue-registration.test.ts`

**Stappen:**

- [ ] Schrijf de failing test `__tests__/queue-registration.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/prisma.js', () => ({ prisma: {} }))

import { registerQueueTools, registerSharedTools, registerWorktreeTools } from '../src/register.js'
import { createMcpServer } from '../src/http.js'

const QUEUE_TOOL_NAMES = [
  'queue_push', 'queue_wait_reply', 'queue_next', 'queue_done',
  'queue_fail', 'queue_status', 'queue_list',
] as const

function captureNames() {
  const names: string[] = []
  const server = {
    registerTool: (n: string) => {
      names.push(n)
    },
    registerPrompt: () => {},
  }
  return { server, names }
}

describe('queue-tools registratie — stdio-only (spec §5-intro/§9)', () => {
  it('registerQueueTools registreert exact de 7 kernset-tools', () => {
    const { server, names } = captureNames()
    registerQueueTools(server as never)
    expect([...names].sort()).toEqual([...QUEUE_TOOL_NAMES].sort())
  })

  it('registerSharedTools bevat géén queue-tools', () => {
    const { server, names } = captureNames()
    registerSharedTools(server as never)
    for (const name of QUEUE_TOOL_NAMES) expect(names).not.toContain(name)
  })

  it('registerWorktreeTools bevat géén queue-tools', () => {
    const { server, names } = captureNames()
    registerWorktreeTools(server as never)
    for (const name of QUEUE_TOOL_NAMES) expect(names).not.toContain(name)
  })

  it('de échte HTTP-server exposeert géén queue-tools (assert op geregistreerde toolnamen)', () => {
    const server = createMcpServer()
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    )
    expect(registered.length).toBeGreaterThan(0)
    for (const name of QUEUE_TOOL_NAMES) expect(registered).not.toContain(name)
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-registration.test.ts` → verwacht: FAIL (`registerQueueTools` en de `createMcpServer`-export bestaan niet).
- [ ] Pas `src/register.ts` aan. Voeg ná de bestaande worktree-imports (r75, `import { registerImplementNextStoryPrompt } …`) toe:

```ts
// s4m-queue kernset (fase 2) — stdio-only, zie registerQueueTools hieronder.
import { registerQueuePushTool } from './tools/queue-push.js'
import { registerQueueWaitReplyTool } from './tools/queue-wait-reply.js'
import { registerQueueNextTool } from './tools/queue-next.js'
import { registerQueueDoneTool } from './tools/queue-done.js'
import { registerQueueFailTool } from './tools/queue-fail.js'
import { registerQueueStatusTool } from './tools/queue-status.js'
import { registerQueueListTool } from './tools/queue-list.js'
```

En voeg ná `registerWorktreeTools` (r146–153) deze functie toe:

```ts
/**
 * s4m-queue core tools (phase 2) — stdio-only, for a different reason than the
 * worktree tools: not filesystem binding but CALLER IDENTITY. The stdio process
 * runs on the caller's host, carries their S4M_SERVER/S4M_MODEL and holds the
 * in-memory lease register of the claims it issued; the central HTTP server has
 * none of those and would attach claims to the wrong identity (spec §5-intro/§9).
 * http.ts must therefore never call this function.
 */
export function registerQueueTools(server: McpServer): void {
  registerQueuePushTool(server)
  registerQueueWaitReplyTool(server)
  registerQueueNextTool(server)
  registerQueueDoneTool(server)
  registerQueueFailTool(server)
  registerQueueStatusTool(server)
  registerQueueListTool(server)
}
```

- [ ] Pas `src/index.ts` aan. Vervang r4:

```ts
import { registerSharedTools, registerWorktreeTools } from './register.js'
```

door:

```ts
import { registerQueueTools, registerSharedTools, registerWorktreeTools } from './register.js'
```

en vervang het registratieblok (r37–40):

```ts
  // stdio mode serves the full toolset: DB/network tools + the worktree-bound
  // tools (this process runs co-located with the agent's git worktree).
  registerSharedTools(server)
  registerWorktreeTools(server)
```

door:

```ts
  // stdio mode serves the full toolset: DB/network tools + the worktree-bound
  // tools (this process runs co-located with the agent's git worktree).
  registerSharedTools(server)
  registerWorktreeTools(server)
  // s4m-queue core tools — stdio-only: this process carries the caller's
  // queue identity (S4M_SERVER/S4M_MODEL) and the lease register (spec §5).
  registerQueueTools(server)
```

- [ ] Pas `src/http.ts` aan (r69): vervang

```ts
function createMcpServer(): McpServer {
```

door:

```ts
export function createMcpServer(): McpServer {
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-registration.test.ts` → verwacht: PASS (4 tests groen).
- [ ] Verifieer stdio-only op broncode-niveau: `grep -n 'registerQueueTools' src/http.ts` → verwacht: géén hits; `grep -n 'registerQueueTools' src/index.ts` → verwacht: 2 hits (import + aanroep).
- [ ] Typecheck + volledige suite: `npm run typecheck && npm test` → verwacht: beide groen.
- [ ] Commit: `git add src/register.ts src/index.ts src/http.ts __tests__/queue-registration.test.ts && git commit -m "feat(queue): registerQueueTools stdio-only + http-non-exposure-test (fase 2, spec §5/§9)"`

---

### Task 15: Integratietests §8 + eindverificatie

De §8-scenario's die in deze repo passen, tegen een echte Postgres via het bestaande `TEST_DATABASE_URL`-patroon (`describeWithDatabase`, conventie `*.integration.test.ts` — zie `__tests__/create-concurrency.integration.test.ts`; zonder env wordt de suite geskipt). **Vereist dat de test-DB de fase-1-migratie bevat** (`agent_message`-tabel met `'mcp'` in de `source`-CHECK). Testen: correlatie-race (deterministisch: replies in omgekeerde volgorde), claim-atomiciteit (parallel, exact één winnaar), idempotente-read-voortgang (twee done-replies in één respons), de eigenaarscontract-precedentiematrix per proces-incarnatie (`clearLeases()` = nieuwe incarnatie), delivery/cancel (vóór/tijdens/ná; het deterministische ná-claim-pad zit al in de unit-test van Task 13 — hier de `rollbackQueueClaim`-semantiek tegen echte rijen) en de repo-autofill. Cancel-tests draaien op het `mac:codex`-adres zodat pending restrijen de FIFO-tests op `mac:claude` niet vervuilen. De sweep-/lease-refresh-§8-scenario's zijn fase 3.

**Files:**
- Test: `__tests__/queue-tools.integration.test.ts`

**Stappen:**

- [ ] Schrijf `__tests__/queue-tools.integration.test.ts`:

```ts
// Fase 2 §8 — correlatie-race, claim-atomiciteit, idempotente-read-voortgang,
// eigenaarscontract-precedentiematrix en delivery/cancel tegen een echte
// Postgres (TEST_DATABASE_URL; zonder env: skip). Vereist de fase-1-migratie
// (agent_message-tabel met source='mcp' in de CHECK). Tests draaien serieel
// binnen dit bestand; FIFO-gevoelige stappen asserteren daarom expliciet
// wélke rij geclaimd werd.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl
process.env.S4M_SERVER = 'mac'
process.env.S4M_MODEL = 'claude'

vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(async () => ({
    userId: 'u-queue-int',
    tokenId: 'integration-test',
    username: 'agent',
    isDemo: false,
  })),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))

import { prisma } from '../src/prisma.js'
import { claimNextReply, claimNextRequest, rollbackQueueClaim } from '../src/queue/claim.js'
import { clearLeases, getLease, registerLease } from '../src/queue/lease-register.js'
import { registerQueuePushTool } from '../src/tools/queue-push.js'
import { registerQueueWaitReplyTool } from '../src/tools/queue-wait-reply.js'
import { registerQueueNextTool } from '../src/tools/queue-next.js'
import { registerQueueDoneTool } from '../src/tools/queue-done.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

type ToolResult = { isError?: boolean; content: { text: string }[] }
type Extra = { signal?: AbortSignal }
type Handler = (args: Record<string, unknown>, extra?: Extra) => Promise<ToolResult>

function capture(register: (s: McpServer) => void): Handler {
  let handler: Handler | undefined
  register({
    registerTool: vi.fn((_n: string, _m: unknown, fn: Handler) => {
      handler = fn
    }),
  } as unknown as McpServer)
  return (args, extra) => handler!(args, extra)
}

const push = capture(registerQueuePushTool)
const waitReply = capture(registerQueueWaitReplyTool)
const next = capture(registerQueueNextTool)
const done = capture(registerQueueDoneTool)

const MARKER = `queue-int-${randomUUID()}`
const mark = (text: string) => `${MARKER} ${text}`
const parse = (result: ToolResult) => JSON.parse(result.content[0].text) as Record<string, any>

async function insertReply(requestId: string, text: string) {
  return prisma.agentMessage.create({
    data: {
      type: 'data',
      from_server: 'scrum4me-server',
      from_model: 'claude',
      to_server: 'mac',
      to_model: 'claude',
      body: mark(text),
      meta: {},
      source: 'cli',
      status: 'pending',
      in_reply_to: requestId,
    },
  })
}

async function insertRequest(text: string, toModel: 'claude' | 'codex' = 'claude') {
  return prisma.agentMessage.create({
    data: {
      type: 'info',
      from_server: 'max2',
      from_model: 'codex',
      to_server: 'mac',
      to_model: toModel,
      body: mark(text),
      meta: {},
      source: 'cli',
      status: 'pending',
    },
  })
}

describeWithDatabase('fase 2 — queue-tools integratie (§8, TEST_DATABASE_URL)', () => {
  beforeEach(() => clearLeases())

  afterAll(async () => {
    await prisma.agentMessage.deleteMany({ where: { body: { contains: MARKER } } })
  })

  it('correlatie-race: elke sessie krijgt het antwoord op zijn éigen request (replies in omgekeerde volgorde)', async () => {
    const a = parse(await push({ to: 'scrum4me-server:claude', type: 'info', body: mark('req A') }))
    const b = parse(await push({ to: 'scrum4me-server:claude', type: 'info', body: mark('req B') }))
    await insertReply(b.message_id, 'antwoord B')
    await insertReply(a.message_id, 'antwoord A')

    const ra = parse(await waitReply({ message_ids: [a.message_id], wait_seconds: 0 }))
    expect(ra.status).toBe('ok')
    expect(ra.replies).toHaveLength(1)
    expect(ra.replies[0].in_reply_to).toBe(a.message_id)
    expect(ra.replies[0].body).toContain('antwoord A')

    const rb = parse(await waitReply({ message_ids: [b.message_id], wait_seconds: 0 }))
    expect(rb.replies[0].in_reply_to).toBe(b.message_id)
    expect(rb.replies[0].body).toContain('antwoord B')
  })

  it('claim-atomiciteit: exact één winnaar bij parallelle claims; idempotente read levert de verliezer dezelfde reply', async () => {
    const req = parse(await push({ to: 'scrum4me-server:claude', type: 'info', body: mark('req parallel') }))
    const reply = await insertReply(req.message_id, 'antwoord parallel')

    const winners = await Promise.all([
      claimNextReply({ server: 'mac', model: 'claude', messageIds: [req.message_id], claimedBy: 'mcp:int-a' }),
      claimNextReply({ server: 'mac', model: 'claude', messageIds: [req.message_id], claimedBy: 'mcp:int-b' }),
    ])
    expect(winners.filter((w) => w !== null)).toHaveLength(1)

    const again = parse(await waitReply({ message_ids: [req.message_id], wait_seconds: 0 }))
    expect(again.status).toBe('ok')
    expect(again.replies[0].id).toBe(reply.id)
  })

  it('idempotente-read-voortgang: twee al-done replies komen samen in één respons (§5.2)', async () => {
    const c = parse(await push({ to: 'scrum4me-server:claude', type: 'info', body: mark('req C') }))
    const d = parse(await push({ to: 'scrum4me-server:claude', type: 'info', body: mark('req D') }))
    await insertReply(c.message_id, 'antwoord C')
    await insertReply(d.message_id, 'antwoord D')

    const first = parse(await waitReply({ message_ids: [c.message_id, d.message_id], wait_seconds: 0 }))
    expect(first.replies).toHaveLength(2)

    const second = parse(await waitReply({ message_ids: [c.message_id, d.message_id], wait_seconds: 0 }))
    expect(second.status).toBe('ok')
    expect(second.replies.map((r: { in_reply_to: string }) => r.in_reply_to).sort())
      .toEqual([c.message_id, d.message_id].sort())
  })

  it('eigenaarscontract: afronden met het eigen lokaal geregistreerde token slaagt (stap c slaagt)', async () => {
    const row = await insertRequest('own claim')
    const claimed = parse(await next({ wait_seconds: 0 }))
    expect(claimed.status).toBe('claimed')
    expect(claimed.message.id).toBe(row.id)
    const result = parse(await done({
      message_id: row.id, reply: mark('klaar'), claim_token: claimed.claim_token,
    }))
    expect(result.status).toBe('done')
    expect(result.reply_id).toBeTruthy()
    expect(getLease(row.id)).toBeUndefined()
  })

  it('proces B met A-token → QUEUE_CLAIM_EXPIRED, óók binnen het lease-venster (stap a)', async () => {
    const row = await insertRequest('incarnatie')
    const claimed = parse(await next({ wait_seconds: 0 }))
    expect(claimed.message.id).toBe(row.id)
    clearLeases() // nieuwe proces-incarnatie: in-memory register is leeg
    const res = await done({ message_id: row.id, claim_token: claimed.claim_token })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('QUEUE_CLAIM_EXPIRED')
  })

  it('mét token op een gerequeued (pending) bericht → QUEUE_CLAIM_EXPIRED; tokenloze bypass-reply blijft werken', async () => {
    const row = await insertRequest('requeue')
    const claimed = parse(await next({ wait_seconds: 0 }))
    expect(claimed.message.id).toBe(row.id)
    await prisma.agentMessage.update({
      where: { id: row.id },
      data: { status: 'pending', claimed_by: null, claimed_at: null, started_at: null },
    })
    clearLeases()
    const zombie = await done({ message_id: row.id, claim_token: claimed.claim_token })
    expect(zombie.isError).toBe(true)
    expect(zombie.content[0].text).toContain('QUEUE_CLAIM_EXPIRED')
    const bypass = parse(await done({ message_id: row.id, reply: mark('bypass-reply') }))
    expect(bypass.status).toBe('done')
  })

  it('entry aanwezig maar verkeerd token → QUEUE_NOT_CLAIMER (stap b)', async () => {
    const row = await insertRequest('verkeerd token')
    const claimed = parse(await next({ wait_seconds: 0 }))
    expect(claimed.message.id).toBe(row.id)
    const res = await done({ message_id: row.id, claim_token: 'niet-het-token' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('herclaim door een ander (CLI) ondanks lokale entry → QUEUE_NOT_CLAIMER (stap c)', async () => {
    const row = await insertRequest('cli herclaim')
    await prisma.agentMessage.update({
      where: { id: row.id },
      data: { status: 'claimed', claimed_by: 'mac:12345', claimed_at: new Date(), started_at: new Date() },
    })
    registerLease(row.id, { claimToken: 'tok-c', claimedBy: 'mcp:int:tok-c' })
    const res = await done({ message_id: row.id, claim_token: 'tok-c' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('tokenloze done op een CLI-geclaimde rij → QUEUE_NOT_CLAIMER (MCP rondt claims van anderen nooit af)', async () => {
    const row = await insertRequest('cli claim tokenloos')
    await prisma.agentMessage.update({
      where: { id: row.id },
      data: { status: 'claimed', claimed_by: 'mac:67890', claimed_at: new Date(), started_at: new Date() },
    })
    const res = await done({ message_id: row.id })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('QUEUE_NOT_CLAIMER')
  })

  it('cancel vóór de claim: er wordt niets geclaimd (mac:codex, geïsoleerd)', async () => {
    const row = await insertRequest('cancel vooraf', 'codex')
    const ac = new AbortController()
    ac.abort()
    const res = parse(await next({ wait_seconds: 0, as: 'codex' }, { signal: ac.signal }))
    expect(res.status).toBe('timeout')
    const after = await prisma.agentMessage.findUnique({ where: { id: row.id } })
    expect(after?.status).toBe('pending')
    // Opruimen zodat de volgende cancel-test een lege codex-queue heeft.
    await prisma.agentMessage.delete({ where: { id: row.id } })
  })

  it('cancel tijdens de wait: keert snel terug zonder claim (mac:codex, lege queue)', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const started = Date.now()
    const res = parse(await next({ wait_seconds: 8, as: 'codex' }, { signal: ac.signal }))
    expect(res.status).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(6000)
  })

  it('cancel ná de claim-transactie: rollbackQueueClaim zet claimed → pending, alleen bij exacte claimed_by-match', async () => {
    const row = await insertRequest('cancel na claim', 'codex')
    const claimed = await claimNextRequest({ server: 'mac', model: 'codex', claimedBy: 'mcp:int:tok-r' })
    expect(claimed?.id).toBe(row.id)
    await rollbackQueueClaim(row.id, 'iemand-anders') // verkeerde eigenaar: no-op
    let after = await prisma.agentMessage.findUnique({ where: { id: row.id } })
    expect(after?.status).toBe('claimed')
    await rollbackQueueClaim(row.id, 'mcp:int:tok-r') // eigenaar: rollback
    after = await prisma.agentMessage.findUnique({ where: { id: row.id } })
    expect(after?.status).toBe('pending')
    expect(after?.claimed_by).toBeNull()
  })

  it('queue_push vult meta.task.repo automatisch via git remote get-url origin', async () => {
    const res = parse(await push({
      to: 'scrum4me-server:claude',
      type: 'task',
      body: mark('task autofill'),
      cwd: process.cwd(),
      meta: { task: { objective: 'o', verification: 'v', response_format: 'rf' } },
    }))
    const row = await prisma.agentMessage.findUnique({ where: { id: res.message_id } })
    const task = (row?.meta as { task?: { repo?: string; cwd?: string } } | null)?.task
    expect(task?.cwd).toBe(process.cwd())
    expect(task?.repo).toContain('scrum4me-mcp')
  })
})
```

- [ ] Draai zonder DB: `npx vitest run __tests__/queue-tools.integration.test.ts` → verwacht: suite geskipt (`describe.skip`), exit 0.
- [ ] Draai mét DB (zelfde test-DB-conventie als `create-concurrency.integration.test.ts`; vereist fase-1-migratie): `TEST_DATABASE_URL=<scrum4me-test-db-url> npx vitest run __tests__/queue-tools.integration.test.ts` → verwacht: PASS (13 tests groen).
- [ ] Eindverificatie volledige repo: `npm run typecheck && npm test` → verwacht: beide groen.
- [ ] Commit: `git add __tests__/queue-tools.integration.test.ts && git commit -m "test(queue): §8-integratietests — correlatie, atomiciteit, eigenaarscontract, cancel (fase 2)"`

---

## Deploy-notitie (na merge, geen taak in deze repo)

- `S4M_MODEL` toevoegen aan het `mcpServers`-config-blok per host (Claude-config: `claude`; codex-config: `codex`); `S4M_SERVER` bestaat al per host (spec §3). Zonder beide geven de queue-tools `QUEUE_IDENTITY_REQUIRED`.
- De rules-file-herschrijving (`~/.claude/rules/s4m-queue.md`: triggers eerst naar MCP-tools, verlopen-claim-protocol) is expliciet **fase 3** (spec §6.4).
- Integratie- en E2E-cutover-matrix (dashboard-`source='mcp'`-weergave, CLI-suite tegen de scrum4me-test-DB) horen bij fase 1/3 (spec §8); deze repo levert het MCP-deel.

## Openstaande vragen / bewuste keuzes (voor JP/codex)

1. **Precedentie tokenloze done/fail op een claimed rij zonder lokale lease → `QUEUE_NOT_CLAIMER`** (conform §7-tabel "zonder geldig claim_token … incl. CLI-claims"). §5.4 stap (a) letterlijk gelezen ("géén registry-entry → QUEUE_CLAIM_EXPIRED") zou ook zonder token EXPIRED impliceren, maar §8 koppelt stap (a) expliciet aan "proces B met A's token". Dit plan volgt §7+§8; matrix in Task 10.
2. **`requireWriteAccess()` op alle 7 queue-tools** — repo-conventie (demo-block), niet expliciet in de spec. De queue zelf is identiteits-, niet user-gescoped.
3. **`queue_wait_reply` schrijft audit-`claimed_by = 'mcp:<instance_id>'`** (zonder token — claim+ack is één transactie, er is geen lease). De spec schrijft voor auto-acked replies geen `claimed_by`-formaat voor.
4. **Reclaim-clausule (4 h CLI-default) ook in de `queue_next`-claim** — §5.2-SQL bevat hem voor `queue_wait_reply`; voor `queue_next` aangenomen op CLI-pariteit (`claim()` past `reclaimDefault` toe). De fase-3-sweep maakt hem grotendeels overbodig maar hij is onschadelijk.
5. **Timeout-vorm `{status:'timeout', replies: []}`** in plaats van het letterlijke `{status:'timeout', reply: null}` uit §5.2 — het meervouds-voortgangscontract (ronde-2-finding 3) maakt `replies` het consistente veld.
6. **`export createMcpServer` in `src/http.ts`** — minimale wijziging puur zodat de non-exposure-test op de geregistreerde toolnamen van de échte HTTP-server kan asserteren (§8).
7. **Fase-1-dependency**: Task 1 STOPt als scrum4me-shared het `AgentMessage`-model nog niet heeft; de integratietest (Task 15) vereist bovendien dat de fase-1-migratie op de test-DB staat.

