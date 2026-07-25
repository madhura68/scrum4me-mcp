# s4m-queue fase 3 (hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fase 3 van de s4m-queue-migratie: proces-gebonden claim-lease (10s-refresh-tick met pruning), gerandomiseerde idempotente stale-sweep met byte-compatibele NotifyEnvelope-emissie, CLI-pariteit `inbox --in-reply-to`, en de herschreven rules-file.

**Architecture:** Twee nieuwe achtergrond-timers in het stdio-MCP-proces (`src/queue/lease-refresh.ts` op 10 s, `src/queue/sweep.ts` op gerandomiseerd 8–10 min), gestart in de `index.ts`-bootstrap naast `startHeartbeat` en gestopt via `registerShutdownHandlers`. De refresh ververst `claimed_at` uitsluitend voor rijen die exact matchen op het in-memory lease-register uit fase 2 (strikte gelijkheid, geen `LIKE`) en snoeit entries waarvoor géén rij geraakt wordt; de sweep requeue't verweesde `mcp:`-claims na ~5 min en CLI-claims na de reclaim-default (4 h) met `FOR UPDATE SKIP LOCKED`. In de s4m-queue-repo krijgt de CLI alleen `inbox --in-reply-to <id,...>` (correlatiefilter in de claim-query); verder blijft de CLI ongemoeid.

**Tech Stack:** TypeScript (ESM), Prisma 7 + `@prisma/adapter-pg`, `pg` (LISTEN/NOTIFY), vitest (unit met `vi.mock` van prisma; integratie via `TEST_DATABASE_URL` resp. `S4M_TEST_DATABASE_URL`), Node `util.parseArgs` (CLI).

**Spec:** `docs/superpowers/specs/2026-07-12-s4m-queue-mcp-integration-design.md` — §6, §7, §8 en §11 (rondes 3–6) zijn na 6 reviewrondes definitief; hiervan wordt NIET afgeweken.

**Werkplek-voorbereiding (scrum4me-mcp):** in een verse worktree eerst `git submodule update --init && npm install` (postinstall draait `gen-schema.sh` + `prisma generate`) — zonder gegenereerde Prisma-client is `npm run typecheck` per definitie rood (bekende worktree-trap).

---

### Task 1: Fase-1/fase-2-afhankelijkheden verifiëren (scrum4me-mcp)

Fase 3 bouwt op fase 1 (Prisma-model `AgentMessage`) en fase 2 (lease-register, notify-helper, `queue_done`-tool). Dit plan is geschreven tegen de onderstaande interface-contracten; deze taak verifieert ze vóór er code geschreven wordt. **Ontbreekt een module volledig → STOP en meld aan JP dat fase 1/2 nog niet gemerged is.** Wijken alléén export-námen af terwijl de semantiek identiek is → noteer de werkelijke namen en gebruik die consequent in Task 2–5 (mechanische substitutie).

**Verwacht contract `src/queue/lease-register.ts` (fase 2, §5.4/§6.1):** in-memory map `message_id → claim_token` mét de volledige `claimed_by`-waarde:

```ts
export interface QueueLease { claimToken: string; claimedBy: string }
export function registerLease(messageId: string, lease: QueueLease): void
export function getLease(messageId: string): QueueLease | undefined
export function releaseLease(messageId: string): void
export function leaseEntries(): Array<{ messageId: string; claimToken: string; claimedBy: string }>
export function clearLeases(): void // test-helper: simuleert een verse proces-incarnatie
```

**Verwacht contract `src/queue/notify.ts` (fase 2, §3/§5.1):**

```ts
export const QUEUE_CHANNEL = 'agent_queue'
export function envelopeOf(m: QueueMessageRow, previousStatus: string | null): QueueNotifyEnvelope
// Envelope-velden in exact deze volgorde (byte-compatibel met s4m-queue/src/db.ts):
// id, type, from_server, from_model, to_server, to_model, in_reply_to, status, previous_status
```

**Verwacht contract `src/tools/queue-done.ts` (fase 2, §5.4):** `registerQueueDoneTool(server)`, input `{message_id, reply?, claim_token?}`, tweetraps-claimer-check met foutprefixen `QUEUE_CLAIM_EXPIRED: …` / `QUEUE_NOT_CLAIMER: …` via `toolError()`.

**Files:**
- Geen wijzigingen — alleen verificatie (read-only).

**Stappen:**

- [ ] Prisma-model uit fase 1 aanwezig: `cd <repo-root> && npm run prisma:generate && grep -n 'model AgentMessage' prisma/schema.prisma` → verwacht: één hit met `@@map("agent_message")` in het blok. Geen hit → STOP (fase 1 niet gemerged).
- [ ] Lease-register uit fase 2 aanwezig: `grep -n 'export' src/queue/lease-register.ts` → verwacht: de exports uit het contract hierboven (minimaal `registerLease`, `releaseLease`, `leaseEntries`, `clearLeases`, en `claimedBy` in de entry-vorm). Bestand ontbreekt → STOP (fase 2 niet gemerged).
- [ ] Notify-helper aanwezig: `grep -n 'envelopeOf\|QUEUE_CHANNEL' src/queue/notify.ts` → verwacht: beide exports. Ontbreekt het bestand of de export → noteer dit; Task 3 stap 1 bevat de exacte fallback-code om hem aan te maken (fase-2-code wordt dan NIET gerefactord).
- [ ] `queue_done`-tool aanwezig: `grep -n 'registerQueueDoneTool\|QUEUE_CLAIM_EXPIRED\|QUEUE_NOT_CLAIMER' src/tools/queue-done.ts` → verwacht: alle drie. Ontbreekt → STOP (fase 2 niet gemerged; het verlopen-claim-protocol in Task 5 test tegen deze tool).
- [ ] Nulmeting: `npm test` → verwacht: volledige suite groen (pretest draait `typecheck:tests`).

---

### Task 2: Lease-refresh-tick met pruning (`src/queue/lease-refresh.ts`)

Het MCP-proces ververst op een eigen 10 s-tick `claimed_at` van precies de rijen in zijn lease-register. **Ontwerpkeuze (bewust, vastleggen in de module-kop):** een parallelle interval in de bootstrap, niet inhaken op `startHeartbeat` in `src/presence/heartbeat.ts` — die tick doet een `ApiToken`-lookup en returnt vroegtijdig bij een gerevoked/verdwenen token (r25: `if (!token || token.revoked_at) return`); de lease-verversing mag niet aan presence-/token-status gekoppeld zijn. Zelfde 10 s-cadans, gescheiden domein. De UPDATE matcht uitsluitend `status='claimed' AND claimed_by = <exacte verwachte waarde>` (Prisma-`updateMany` met equals — strikte gelijkheid, geen `LIKE`, §6.1); raakt de update géén rij, dan wordt de entry direct gesnoeid (geen eeuwig doorverversende wees-entries). Bij een DB-fout blijft de entry staan (volgende tick probeert opnieuw) — snoeien mag alléén op een geslaagde update met `count === 0`.

**Files:**
- Create: `src/queue/lease-refresh.ts`
- Test: `__tests__/queue-lease-refresh.test.ts`

**Stappen:**

- [ ] Schrijf de failing test `__tests__/queue-lease-refresh.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    agentMessage: { updateMany: vi.fn() },
  },
}))

import { prisma } from '../src/prisma.js'
import { refreshQueueLeases, startQueueLeaseRefresh } from '../src/queue/lease-refresh.js'
import { registerLease, leaseEntries, clearLeases } from '../src/queue/lease-register.js'

const mockPrisma = prisma as unknown as {
  agentMessage: { updateMany: ReturnType<typeof vi.fn> }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearLeases()
  mockPrisma.agentMessage.updateMany.mockResolvedValue({ count: 1 })
})

describe('refreshQueueLeases — §6.1 lease-verversing', () => {
  it('ververst claimed_at uitsluitend voor exact matchende rijen (strikte gelijkheid, geen LIKE)', async () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    await refreshQueueLeases()
    expect(mockPrisma.agentMessage.updateMany).toHaveBeenCalledWith({
      where: { id: 'msg-1', status: 'claimed', claimed_by: 'mcp:inst:tok-1' },
      data: { claimed_at: expect.any(Date) },
    })
  })

  it('ververst alle geregistreerde leases per tick', async () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    registerLease('msg-2', { claimToken: 'tok-2', claimedBy: 'mcp:inst:tok-2' })
    await refreshQueueLeases()
    expect(mockPrisma.agentMessage.updateMany).toHaveBeenCalledTimes(2)
  })

  it('snoeit een entry zodra de update géén rij raakt (§8 lease-pruning: handmatige requeue + refresh-tick)', async () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    // Handmatige CLI-requeue buiten de MCP om: rij is niet langer claimed door ons.
    mockPrisma.agentMessage.updateMany.mockResolvedValueOnce({ count: 0 })
    await refreshQueueLeases()
    expect(leaseEntries()).toHaveLength(0)
    // Volgende tick ververst niets meer voor deze entry.
    await refreshQueueLeases()
    expect(mockPrisma.agentMessage.updateMany).toHaveBeenCalledTimes(1)
  })

  it('behoudt de entry bij een DB-fout (volgende tick probeert opnieuw)', async () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    mockPrisma.agentMessage.updateMany.mockRejectedValueOnce(new Error('db weg'))
    await refreshQueueLeases()
    expect(leaseEntries()).toHaveLength(1)
  })
})

describe('startQueueLeaseRefresh', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('tikt op het opgegeven interval en stopt via stop()', async () => {
    registerLease('msg-1', { claimToken: 'tok-1', claimedBy: 'mcp:inst:tok-1' })
    const { stop } = startQueueLeaseRefresh({ intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(250)
    expect(mockPrisma.agentMessage.updateMany).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(mockPrisma.agentMessage.updateMany).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-lease-refresh.test.ts` → verwacht: FAIL (module `src/queue/lease-refresh.ts` bestaat niet).
- [ ] Maak `src/queue/lease-refresh.ts` met exact deze inhoud:

```ts
// Fase 3 §6.1 — lease-verversing per proces-incarnatie.
//
// Parallelle 10s-interval naast startHeartbeat (src/presence/heartbeat.ts),
// bewust NIET ingehaakt op de presence-tick: die returnt vroegtijdig bij een
// gerevoked/verdwenen ApiToken en de lease mag niet aan presence-status
// hangen. De UPDATE matcht uitsluitend status='claimed' AND claimed_by =
// <exact verwachte waarde> (strikte gelijkheid, geen LIKE). Raakt de update
// géén rij (bv. handmatige CLI-requeue of -done buiten de MCP om), dan wordt
// de registry-entry direct gesnoeid. Bij DB-fouten blijft de entry staan —
// snoeien mag alléén op een geslaagde update met count === 0.
import { prisma } from '../prisma.js'
import { leaseEntries, releaseLease } from './lease-register.js'

export const LEASE_REFRESH_INTERVAL_MS = 10_000

export async function refreshQueueLeases(): Promise<void> {
  for (const { messageId, claimedBy } of leaseEntries()) {
    try {
      const result = await prisma.agentMessage.updateMany({
        where: { id: messageId, status: 'claimed', claimed_by: claimedBy },
        data: { claimed_at: new Date() },
      })
      if (result.count === 0) {
        releaseLease(messageId)
      }
    } catch {
      // non-fatal — DB onbereikbaar e.d.; entry behouden, volgende tick retryt.
    }
  }
}

export function startQueueLeaseRefresh(opts: { intervalMs?: number } = {}): {
  stop: () => void
} {
  const timer = setInterval(() => {
    void refreshQueueLeases()
  }, opts.intervalMs ?? LEASE_REFRESH_INTERVAL_MS)
  return { stop: () => clearInterval(timer) }
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-lease-refresh.test.ts` → verwacht: PASS (6 tests groen).
- [ ] Commit: `git add src/queue/lease-refresh.ts __tests__/queue-lease-refresh.test.ts && git commit -m "feat(queue): lease-refresh-tick met pruning (fase 3, spec §6.1)"`

---

### Task 3: Stale-sweep met NotifyEnvelope (`src/queue/sweep.ts`)

Idempotente sweep op gerandomiseerd interval 8–10 min (Graphile-patroon; drie hosts mogen tegelijk sweepen, geen leader-election). Requeue't in één transactie met `FOR UPDATE SKIP LOCKED`: (a) `mcp:`-claims met `claimed_at` ouder dan 5 min (≈ tientallen gemiste refresh-ticks — herstel uitsluitend ná procesdood, een levend proces ververst door), en (b) CLI-claims (`claimed_by` zonder `mcp:`-prefix) ouder dan de reclaim-default van 4 h (override via env `S4M_RECLAIM_DEFAULT`, zelfde semantiek als `s4m-queue/src/config.ts`). Per gerequeuede rij een byte-compatibele NotifyEnvelope op kanaal `agent_queue`, binnen dezelfde transactie (pg_notify vuurt bij COMMIT — zelfde patroon als de CLI).

**Files:**
- Create: `src/queue/sweep.ts`
- Create (ALLEEN als Task 1 constateerde dat `src/queue/notify.ts` ontbreekt of `envelopeOf`/`QUEUE_CHANNEL` niet exporteert): `src/queue/notify.ts`
- Test: `__tests__/queue-sweep.test.ts`

**Stappen:**

- [ ] Alleen als Task 1 dit constateerde — maak `src/queue/notify.ts` met exact deze inhoud (anders: overslaan, fase-2-module gebruiken):

```ts
// NotifyEnvelope voor het s4m-queue-kanaal — byte-compatibel met
// s4m-queue/src/db.ts envelopeOf(): zelfde velden, zelfde volgorde.
// CLI --wait en het Messages-dashboard parsen deze payload ongewijzigd.
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
```

- [ ] Schrijf de failing test `__tests__/queue-sweep.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const txMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
}))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
  },
}))

import { prisma } from '../src/prisma.js'
import {
  sweepStaleQueueClaims,
  startQueueStaleSweep,
  cliReclaimInterval,
  MCP_LEASE_STALE_INTERVAL,
  SWEEP_MIN_INTERVAL_MS,
  SWEEP_JITTER_MS,
} from '../src/queue/sweep.js'

const mockTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  txMock.$queryRaw.mockResolvedValue([])
  txMock.$executeRaw.mockResolvedValue(0)
  delete process.env.S4M_RECLAIM_DEFAULT
})

describe('cliReclaimInterval', () => {
  it('default 4 hours, env-override, en fallback bij ongeldige waarde', () => {
    expect(cliReclaimInterval({})).toBe('4 hours')
    expect(cliReclaimInterval({ S4M_RECLAIM_DEFAULT: '90 minutes' })).toBe('90 minutes')
    expect(cliReclaimInterval({ S4M_RECLAIM_DEFAULT: "4) OR (1=1" })).toBe('4 hours')
  })
})

describe('sweepStaleQueueClaims — §6.1', () => {
  it('gebruikt SKIP LOCKED en de mcp-/CLI-drempels als bind-parameters', async () => {
    await sweepStaleQueueClaims()
    const [strings, ...values] = txMock.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ]
    const sql = strings.join('$')
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain("claimed_by LIKE 'mcp:%'")
    expect(sql).toContain("status = 'claimed'")
    expect(sql).toContain("SET status = 'pending', claimed_by = NULL, claimed_at = NULL, started_at = NULL")
    expect(values).toEqual([MCP_LEASE_STALE_INTERVAL, '4 hours'])
  })

  it('emit per gerequeuede rij een byte-compatibele NotifyEnvelope op agent_queue', async () => {
    txMock.$queryRaw.mockResolvedValue([
      {
        id: 'msg-1',
        type: 'task',
        from_server: 'mac',
        from_model: 'claude',
        to_server: 'scrum4me-server',
        to_model: 'codex',
        in_reply_to: null,
      },
    ])
    const { requeued } = await sweepStaleQueueClaims()
    expect(requeued).toEqual(['msg-1'])
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1)
    const [, channel, payload] = txMock.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      string,
      string,
    ]
    expect(channel).toBe('agent_queue')
    expect(payload).toBe(
      JSON.stringify({
        id: 'msg-1',
        type: 'task',
        from_server: 'mac',
        from_model: 'claude',
        to_server: 'scrum4me-server',
        to_model: 'codex',
        in_reply_to: null,
        status: 'pending',
        previous_status: 'claimed',
      }),
    )
  })

  it('geen stale rijen → geen notify', async () => {
    const { requeued } = await sweepStaleQueueClaims()
    expect(requeued).toEqual([])
    expect(txMock.$executeRaw).not.toHaveBeenCalled()
  })
})

describe('startQueueStaleSweep — gerandomiseerd interval', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('draait op minimaal 8 min (random 0) en stopt via stop()', async () => {
    const { stop } = startQueueStaleSweep({ random: () => 0 })
    expect(mockTransaction).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SWEEP_MIN_INTERVAL_MS)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SWEEP_MIN_INTERVAL_MS)
    expect(mockTransaction).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(SWEEP_MIN_INTERVAL_MS * 3)
    expect(mockTransaction).toHaveBeenCalledTimes(2)
  })

  it('random () => 1 schuift de run naar min + jitter (10 min)', async () => {
    const { stop } = startQueueStaleSweep({ random: () => 1 })
    await vi.advanceTimersByTimeAsync(SWEEP_MIN_INTERVAL_MS)
    expect(mockTransaction).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SWEEP_JITTER_MS)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    stop()
  })

  it('een falende sweep breekt de loop niet', async () => {
    mockTransaction.mockRejectedValueOnce(new Error('db weg'))
    const { stop } = startQueueStaleSweep({ random: () => 0 })
    await vi.advanceTimersByTimeAsync(SWEEP_MIN_INTERVAL_MS)
    expect(mockTransaction).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SWEEP_MIN_INTERVAL_MS)
    expect(mockTransaction).toHaveBeenCalledTimes(2)
    stop()
  })
})
```

Let op: `afterEach` importeren in de eerste importregel (`import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`).

- [ ] Draai de test: `npx vitest run __tests__/queue-sweep.test.ts` → verwacht: FAIL (module `src/queue/sweep.ts` bestaat niet).
- [ ] Maak `src/queue/sweep.ts` met exact deze inhoud:

```ts
// Fase 3 §6.1 — automatische stale-sweep met proces-gebonden claim-lease.
//
// Idempotent; gerandomiseerd interval 8–10 min (Graphile-patroon). Drie hosts
// mogen tegelijk sweepen: FOR UPDATE SKIP LOCKED + het status-filter zorgen
// dat elke rij precies één keer gerequeued wordt. Twee klassen:
//   - mcp:-claims  → stale zodra claimed_at > 5 min oud (lease-refresh dood);
//   - CLI-claims   → alleen de reclaim-default van 4 h, zoals vandaag.
// Per gerequeuede rij een byte-compatibele NotifyEnvelope op agent_queue,
// binnen dezelfde transactie (pg_notify vuurt bij COMMIT).
import { prisma } from '../prisma.js'
import { envelopeOf, QUEUE_CHANNEL } from './notify.js'

export const MCP_LEASE_STALE_INTERVAL = '5 minutes'
export const SWEEP_MIN_INTERVAL_MS = 8 * 60_000
export const SWEEP_JITTER_MS = 2 * 60_000

/** Zelfde default + sanity-check als s4m-queue/src/config.ts; Postgres
 *  valideert de echte interval-syntax. Ongeldig → veilige default. */
export function cliReclaimInterval(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.S4M_RECLAIM_DEFAULT?.trim()
  if (fromEnv && /^[0-9 a-zA-Z.:-]+$/.test(fromEnv)) return fromEnv
  return '4 hours'
}

type SweptRow = {
  id: string
  type: string
  from_server: string
  from_model: string
  to_server: string
  to_model: string
  in_reply_to: string | null
}

export async function sweepStaleQueueClaims(): Promise<{ requeued: string[] }> {
  const cliInterval = cliReclaimInterval()
  const rows = await prisma.$transaction(async (tx) => {
    const swept = await tx.$queryRaw<SweptRow[]>`
      WITH target AS (
        SELECT id FROM agent_message
         WHERE status = 'claimed'
           AND (
             (claimed_by LIKE 'mcp:%' AND claimed_at < now() - ${MCP_LEASE_STALE_INTERVAL}::interval)
             OR ((claimed_by IS NULL OR claimed_by NOT LIKE 'mcp:%')
                 AND claimed_at < now() - ${cliInterval}::interval)
           )
         ORDER BY claimed_at
         FOR UPDATE SKIP LOCKED
      )
      UPDATE agent_message m
         SET status = 'pending', claimed_by = NULL, claimed_at = NULL, started_at = NULL
        FROM target
       WHERE m.id = target.id
       RETURNING m.id, m.type, m.from_server, m.from_model, m.to_server, m.to_model, m.in_reply_to
    `
    for (const row of swept) {
      const payload = JSON.stringify(envelopeOf({ ...row, status: 'pending' }, 'claimed'))
      await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${payload})`
    }
    return swept
  })
  return { requeued: rows.map((r) => r.id) }
}

export function startQueueStaleSweep(
  opts: { minIntervalMs?: number; jitterMs?: number; random?: () => number } = {},
): { stop: () => void } {
  const minIntervalMs = opts.minIntervalMs ?? SWEEP_MIN_INTERVAL_MS
  const jitterMs = opts.jitterMs ?? SWEEP_JITTER_MS
  const random = opts.random ?? Math.random
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(async () => {
      try {
        await sweepStaleQueueClaims()
      } catch {
        // non-fatal — volgende run retryt.
      }
      schedule()
    }, minIntervalMs + Math.floor(random() * jitterMs))
  }
  schedule()
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-sweep.test.ts` → verwacht: PASS (8 tests groen).
- [ ] Commit: `git add src/queue/sweep.ts __tests__/queue-sweep.test.ts && git commit -m "feat(queue): gerandomiseerde idempotente stale-sweep met NotifyEnvelope (fase 3, spec §6.1)"` — voeg `src/queue/notify.ts` toe aan de `git add` als de fallback-stap hem aanmaakte.

---

### Task 4: Bootstrap- en shutdown-wiring (stdio-only)

Refresh + sweep starten in de stdio-bootstrap (`src/index.ts`, ná `startHeartbeat`, r64–71) en stoppen in de shutdown-handler. **Stdio-only:** `src/http.ts` blijft onaangeroerd — de centrale HTTP-server heeft geen queue-identiteit en geen lease-register (spec §5-intro/§9).

**Files:**
- Modify: `src/presence/shutdown.ts` (opts-blok r3–8, shutdown-body r11–21)
- Modify: `src/index.ts` (imports r4–12; wiring r64–77)
- Test: `__tests__/queue-shutdown-wiring.test.ts`

**Stappen:**

- [ ] Schrijf de failing test `__tests__/queue-shutdown-wiring.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/presence/worker.js', () => ({
  unregisterWorker: vi.fn().mockResolvedValue(undefined),
}))

import { registerShutdownHandlers } from '../src/presence/shutdown.js'
import { unregisterWorker } from '../src/presence/worker.js'

describe('registerShutdownHandlers — queue-maintenance stop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
  })

  it('stopt heartbeat én queue-maintenance op SIGTERM', async () => {
    const stopHeartbeat = vi.fn()
    const stopQueueMaintenance = vi.fn()
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    registerShutdownHandlers({
      userId: 'u',
      tokenId: 't',
      instanceId: 'i',
      stopHeartbeat,
      stopQueueMaintenance,
    })
    process.emit('SIGTERM')
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())
    expect(stopHeartbeat).toHaveBeenCalledOnce()
    expect(stopQueueMaintenance).toHaveBeenCalledOnce()
    expect(unregisterWorker).toHaveBeenCalledOnce()
    exitSpy.mockRestore()
  })

  it('blijft werken zonder stopQueueMaintenance (optioneel veld)', async () => {
    const stopHeartbeat = vi.fn()
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    registerShutdownHandlers({ userId: 'u', tokenId: 't', instanceId: 'i', stopHeartbeat })
    process.emit('SIGINT')
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())
    expect(stopHeartbeat).toHaveBeenCalledOnce()
    exitSpy.mockRestore()
  })
})
```

- [ ] Draai de test: `npx vitest run __tests__/queue-shutdown-wiring.test.ts` → verwacht: FAIL (TS-fout: `stopQueueMaintenance` bestaat niet op het opts-type).
- [ ] Pas `src/presence/shutdown.ts` aan — vervang het hele bestand door:

```ts
import { unregisterWorker } from './worker.js'

export function registerShutdownHandlers(opts: {
  userId: string
  tokenId: string
  instanceId: string
  stopHeartbeat: () => void
  /** Fase 3: stopt de queue-lease-refresh + stale-sweep (stdio-only). */
  stopQueueMaintenance?: () => void
}): void {
  let exiting = false

  const shutdown = async () => {
    if (exiting) return
    exiting = true
    opts.stopHeartbeat()
    opts.stopQueueMaintenance?.()
    await unregisterWorker({
      userId: opts.userId,
      tokenId: opts.tokenId,
      instanceId: opts.instanceId,
    })
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}
```

- [ ] Draai de test opnieuw: `npx vitest run __tests__/queue-shutdown-wiring.test.ts` → verwacht: PASS (2 tests groen).
- [ ] Wire de bootstrap in `src/index.ts`. Voeg bij de imports (na r10, `import { getInstanceId } …`) toe:

```ts
import { startQueueLeaseRefresh } from './queue/lease-refresh.js'
import { startQueueStaleSweep } from './queue/sweep.js'
```

En vervang het `registerShutdownHandlers`-blok (r72–77) door:

```ts
  // Fase 3: queue-maintenance — lease-refresh (10 s) + stale-sweep (8–10 min).
  // Stdio-only: dit proces draagt de caller-identiteit en het lease-register;
  // http.ts start dit bewust NIET.
  const { stop: stopLeaseRefresh } = startQueueLeaseRefresh()
  const { stop: stopStaleSweep } = startQueueStaleSweep()
  registerShutdownHandlers({
    userId: auth.userId,
    tokenId: auth.tokenId,
    instanceId,
    stopHeartbeat,
    stopQueueMaintenance: () => {
      stopLeaseRefresh()
      stopStaleSweep()
    },
  })
```

- [ ] Verifieer stdio-only: `grep -n 'startQueueStaleSweep\|startQueueLeaseRefresh' src/http.ts` → verwacht: géén hits.
- [ ] Typecheck + volledige suite: `npm run typecheck && npm test` → verwacht: beide groen.
- [ ] Commit: `git add src/presence/shutdown.ts src/index.ts __tests__/queue-shutdown-wiring.test.ts && git commit -m "feat(queue): start/stop queue-maintenance in stdio-bootstrap (fase 3)"`

---

### Task 5: Integratietests §8 — sweep/lease, incarnatie en verlopen-claim-protocol

De §8-scenario's draaien tegen een echte Postgres via het bestaande `TEST_DATABASE_URL`-patroon (`describeWithDatabase`, zie `__tests__/create-concurrency.integration.test.ts`); zonder die env wordt de suite geskipt. Vereist dat de scrum4me-test-DB de fase-1-migratie (`agent_message`-tabel, `source='mcp'` in de CHECK) bevat.

**Files:**
- Test: `__tests__/queue-sweep-lease.integration.test.ts`

**Stappen:**

- [ ] Schrijf `__tests__/queue-sweep-lease.integration.test.ts`:

```ts
// Fase 3 §8 — Sweep/lease, incarnatie-scenario en verlopen-claim-protocol
// tegen een echte Postgres (TEST_DATABASE_URL; zonder env: skip).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'pg'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl

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
import { sweepStaleQueueClaims } from '../src/queue/sweep.js'
import { refreshQueueLeases } from '../src/queue/lease-refresh.js'
import { registerLease, clearLeases } from '../src/queue/lease-register.js'
import { registerQueueDoneTool } from '../src/tools/queue-done.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

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

describeWithDatabase('fase 3 — sweep/lease (§8, TEST_DATABASE_URL)', () => {
  const createdIds: string[] = []

  async function insertClaimed(opts: { claimedBy: string; ageMinutes: number }) {
    const at = new Date(Date.now() - opts.ageMinutes * 60_000)
    const row = await prisma.agentMessage.create({
      data: {
        type: 'task',
        from_server: 'mac',
        from_model: 'claude',
        to_server: 'mac',
        to_model: 'claude',
        body: 'integration sweep test',
        meta: {},
        source: 'mcp',
        status: 'claimed',
        claimed_by: opts.claimedBy,
        claimed_at: at,
        started_at: at,
      },
    })
    createdIds.push(row.id)
    return row
  }

  beforeAll(() => {
    process.env.S4M_SERVER = 'mac'
    process.env.S4M_MODEL = 'claude'
  })

  beforeEach(() => {
    clearLeases()
  })

  afterAll(async () => {
    await prisma.agentMessage.deleteMany({ where: { in_reply_to: { in: createdIds } } })
    await prisma.agentMessage.deleteMany({ where: { id: { in: createdIds } } })
    await prisma.$disconnect()
  })

  it('sweep-idempotentie: twee opeenvolgende sweeps requeuen samen precies één keer', async () => {
    const row = await insertClaimed({ claimedBy: 'mcp:inst-a:tok-1', ageMinutes: 10 })
    const first = await sweepStaleQueueClaims()
    const second = await sweepStaleQueueClaims()
    const hits = [...first.requeued, ...second.requeued].filter((id) => id === row.id)
    expect(hits).toHaveLength(1)
    const after = await prisma.agentMessage.findUnique({ where: { id: row.id } })
    expect(after?.status).toBe('pending')
    expect(after?.claimed_by).toBeNull()
    expect(after?.claimed_at).toBeNull()
    expect(after?.started_at).toBeNull()
  })

  it('twee gelijktijdige sweeps requeuen samen precies één keer (SKIP LOCKED)', async () => {
    const row = await insertClaimed({ claimedBy: 'mcp:inst-a:tok-2', ageMinutes: 10 })
    const [a, b] = await Promise.all([sweepStaleQueueClaims(), sweepStaleQueueClaims()])
    const hits = [...a.requeued, ...b.requeued].filter((id) => id === row.id)
    expect(hits).toHaveLength(1)
  })

  it('een levende lease wordt nooit gerequeued, ook niet voorbij het reclaim-window', async () => {
    const claimedBy = 'mcp:inst-a:tok-levend'
    const row = await insertClaimed({ claimedBy, ageMinutes: 5 * 60 }) // 5 uur oud
    registerLease(row.id, { claimToken: 'tok-levend', claimedBy })
    await refreshQueueLeases() // levende proces-tick ververst claimed_at
    const swept = await sweepStaleQueueClaims()
    expect(swept.requeued).not.toContain(row.id)
    const after = await prisma.agentMessage.findUnique({ where: { id: row.id } })
    expect(after?.status).toBe('claimed')
    expect(after?.claimed_by).toBe(claimedBy)
  })

  it('incarnatie-scenario: B met dezelfde stabiele instance-config beschermt A\'s claim niet', async () => {
    // A claimde en stierf; B start direct met dezelfde instance-id in de
    // config. B's register is per definitie leeg (lease is per incarnatie),
    // dus B ververst niets van A en de sweep requeue't binnen de drempel.
    const row = await insertClaimed({ claimedBy: 'mcp:stabiele-instance:tok-a', ageMinutes: 6 })
    clearLeases()
    await refreshQueueLeases()
    const swept = await sweepStaleQueueClaims()
    expect(swept.requeued).toContain(row.id)
  })

  it('CLI-claims: binnen 4 h met rust gelaten, daarbuiten gerequeued', async () => {
    const jong = await insertClaimed({ claimedBy: 'mac:12345', ageMinutes: 3 * 60 })
    const oud = await insertClaimed({ claimedBy: 'mac:12345', ageMinutes: 5 * 60 })
    const swept = await sweepStaleQueueClaims()
    expect(swept.requeued).not.toContain(jong.id)
    expect(swept.requeued).toContain(oud.id)
  })

  it('emit een byte-compatibele NotifyEnvelope op agent_queue bij requeue', async () => {
    const row = await insertClaimed({ claimedBy: 'mcp:inst-a:tok-notify', ageMinutes: 10 })
    const listener = new Client({ connectionString: testDatabaseUrl })
    await listener.connect()
    const payloads: string[] = []
    listener.on('notification', (n) => {
      if (n.channel === 'agent_queue' && n.payload) payloads.push(n.payload)
    })
    await listener.query('LISTEN agent_queue')
    try {
      await sweepStaleQueueClaims()
      await vi.waitFor(() => {
        expect(payloads.some((p) => p.includes(row.id))).toBe(true)
      })
      const payload = payloads.find((p) => p.includes(row.id))
      expect(payload).toBe(
        JSON.stringify({
          id: row.id,
          type: 'task',
          from_server: 'mac',
          from_model: 'claude',
          to_server: 'mac',
          to_model: 'claude',
          in_reply_to: null,
          status: 'pending',
          previous_status: 'claimed',
        }),
      )
    } finally {
      await listener.end()
    }
  })

  it('verlopen-claim-protocol: done mét token na sweep-requeue → QUEUE_CLAIM_EXPIRED (pending)', async () => {
    const row = await insertClaimed({ claimedBy: 'mcp:inst-a:tok-verlopen', ageMinutes: 10 })
    clearLeases() // MCP-herstart: register leeg
    await sweepStaleQueueClaims() // sweep requeue't de verweesde claim
    const server = makeServer()
    const result = await server.call({ message_id: row.id, claim_token: 'tok-verlopen' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^QUEUE_CLAIM_EXPIRED/)
  })

  it('herclaimd door een ander: done met eigen (nog geregistreerd) token → QUEUE_NOT_CLAIMER', async () => {
    // Register bevat nog A's entry (levend proces), maar de rij is inmiddels
    // door een ander proces geclaimd (sweep-requeue + herclaim race): stap (c)
    // van de precedentiematrix — atomische DB-check op exacte claimed_by.
    const row = await insertClaimed({ claimedBy: 'mcp:inst-b:tok-van-b', ageMinutes: 0 })
    registerLease(row.id, { claimToken: 'tok-van-a', claimedBy: 'mcp:inst-a:tok-van-a' })
    const server = makeServer()
    const result = await server.call({ message_id: row.id, claim_token: 'tok-van-a' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^QUEUE_NOT_CLAIMER/)
  })

  it('tokenloze FIFO-bypass-reply op een gerequeued (pending) request blijft werken', async () => {
    const row = await insertClaimed({ claimedBy: 'mcp:inst-a:tok-bypass', ageMinutes: 10 })
    clearLeases()
    await sweepStaleQueueClaims()
    const server = makeServer()
    const result = await server.call({ message_id: row.id, reply: 'alsnog beantwoord' })
    expect(result.isError).toBeFalsy()
    const replies = await prisma.agentMessage.findMany({ where: { in_reply_to: row.id } })
    expect(replies).toHaveLength(1)
    expect(replies[0].body).toBe('alsnog beantwoord')
    createdIds.push(replies[0].id)
  })
})
```

- [ ] Draai zonder DB: `npx vitest run __tests__/queue-sweep-lease.integration.test.ts` → verwacht: suite geskipt (`describe.skip`), exit 0.
- [ ] Draai mét DB: `TEST_DATABASE_URL=<scrum4me-test-db-url> npx vitest run __tests__/queue-sweep-lease.integration.test.ts` → verwacht: 9 tests groen. Faalt `agentMessage` met "table does not exist" → fase-1-migratie eerst op de test-DB draaien (STOP en meld).
- [ ] Volledige suite + typecheck als regressiecheck: `npm run typecheck && npm test` → verwacht: groen.
- [ ] Commit: `git add __tests__/queue-sweep-lease.integration.test.ts && git commit -m "test(queue): integratietests sweep/lease, incarnatie en verlopen-claim-protocol (spec §8)"`

---

### Task 6: CLI-pariteit — `inbox --in-reply-to <id,...>` (repo `~/Development/s4m-queue`)

Minimale CLI-wijziging (spec §6.3): het correlatiefilter in de claim-query, uitsluitend voor `inbox`. Verder blijft de CLI ongemoeid. Testframework daar: **vitest** tegen een echte Postgres (`S4M_TEST_DATABASE_URL` via `.env`, schema-per-run in `test/helpers/db.ts`). Werk op een nieuwe branch vanaf `main` in `~/Development/s4m-queue`.

**Files:**
- Modify: `~/Development/s4m-queue/src/db.ts` (`ClaimOpts` r66–75, `claim()` r77–117, `listenAndClaim` onNotify r266–276)
- Modify: `~/Development/s4m-queue/src/cli.ts` (`OPTS` r119–130, case `next`/`inbox` r153–166, `HELP_TEXT` Reclaim-blok r92–94)
- Test: `~/Development/s4m-queue/test/inbox-in-reply-to.test.ts`

**Stappen:**

- [ ] Branch: `cd ~/Development/s4m-queue && git checkout main && git pull && git checkout -b feat/inbox-in-reply-to`
- [ ] Schrijf de failing test `test/inbox-in-reply-to.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import { setupTestDb, type TestDb } from './helpers/db.js';
import { push, claim, doneWithReply } from '../src/db.js';
import { RESPONSE_TYPES } from '../src/types.js';
import { runCli, HELP_TEXT } from '../src/cli.js';

let tdb: TestDb; let db: Client;
beforeAll(async () => { tdb = await setupTestDb(); db = await tdb.connect(); });
afterAll(async () => { await tdb.end(); });

const RES = [...RESPONSE_TYPES];
const cfg = (self: 'mac' | 'scrum4me-server', reclaimDefault = '4 hours') =>
  ({ queueUrl: 'x', self, channel: tdb.channel, reclaimDefault });

async function pushInfo(body: string) {
  return push(db, {
    type: 'info',
    from: { server: 'mac', model: 'claude' },
    to: { server: 'scrum4me-server', model: 'claude' },
    body,
  }, tdb.channel);
}

describe('claim met inReplyTo-filter (correlatie in de WHERE-clause)', () => {
  it('claimt alleen replies op de opgegeven request-ids, ook als een oudere reply klaarstaat', async () => {
    const reqA = await pushInfo('vraag A');
    const reqB = await pushInfo('vraag B');
    // Replies in omgekeerde volgorde: reply op B is de oudste pending reply.
    await doneWithReply(db, { id: reqB, body: 'antwoord B' }, tdb.channel);
    await doneWithReply(db, { id: reqA, body: 'antwoord A' }, tdb.channel);

    const m = await claim(db, {
      toServer: 'mac', toModel: 'claude', types: RES, claimedBy: 't',
      inReplyTo: [reqA],
    });
    expect(m?.in_reply_to).toBe(reqA);
    expect(m?.body).toBe('antwoord A');

    // De reply op B is niet aangeraakt en blijft claimbaar voor B's eigenaar.
    const mB = await claim(db, {
      toServer: 'mac', toModel: 'claude', types: RES, claimedBy: 't',
      inReplyTo: [reqB],
    });
    expect(mB?.in_reply_to).toBe(reqB);
    expect(mB?.body).toBe('antwoord B');
  });

  it('geeft null wanneer er geen reply op de set bestaat', async () => {
    const req = await pushInfo('nog onbeantwoord');
    const m = await claim(db, {
      toServer: 'mac', toModel: 'claude', types: RES, claimedBy: 't',
      inReplyTo: [req],
    });
    expect(m).toBeNull();
  });
});

describe('runCli — inbox --in-reply-to', () => {
  it('claimt alleen het antwoord op het opgegeven verzoek', async () => {
    const id1 = (await runCli(['push', '--to', 'scrum4me-server:claude', '--as', 'claude',
      '--type', 'info', '--body', 'q1'], { client: db, config: cfg('mac') })).trim();
    const id2 = (await runCli(['push', '--to', 'scrum4me-server:claude', '--as', 'claude',
      '--type', 'info', '--body', 'q2'], { client: db, config: cfg('mac') })).trim();
    await runCli(['done', id2, '--reply', 'r2'], { client: db, config: cfg('scrum4me-server') });
    await runCli(['done', id1, '--reply', 'r1'], { client: db, config: cfg('scrum4me-server') });

    const out = await runCli(['inbox', '--as', 'claude', '--json', '--in-reply-to', id1],
      { client: db, config: cfg('mac') });
    const { message } = JSON.parse(out);
    expect(message).toMatchObject({ in_reply_to: id1, body: 'r1' });
  });

  it('weigert --in-reply-to bij next', async () => {
    await expect(runCli(['next', '--as', 'claude', '--in-reply-to', 'x'],
      { client: db, config: cfg('mac') })).rejects.toThrow(/--in-reply-to/);
  });

  it('weigert een lege --in-reply-to', async () => {
    await expect(runCli(['inbox', '--as', 'claude', '--in-reply-to', ' , '],
      { client: db, config: cfg('mac') })).rejects.toThrow(/--in-reply-to/);
  });

  it('staat in de helptekst', () => {
    expect(HELP_TEXT).toContain('--in-reply-to');
  });
});
```

- [ ] Draai de test: `npx vitest run test/inbox-in-reply-to.test.ts` → verwacht: FAIL — de db-tests claimen de verkeerde (oudste) reply omdat `inReplyTo` genegeerd wordt, en de CLI-tests gooien `Unknown option '--in-reply-to'` (parseArgs strict).
- [ ] Pas `src/db.ts` aan. Breid `ClaimOpts` (r66–75) uit met één veld:

```ts
export interface ClaimOpts {
  toServer: Server;
  toModel: Model;
  types: MessageType[];
  claimedBy: string;
  /** Expliciete override in minuten (van CLI `--reclaim-after <min>`). */
  reclaimAfterMin?: number;
  /** Default reclaim-window als `reclaimAfterMin` niet gezet is (Postgres-interval). */
  reclaimDefault?: string;
  /** Correlatiefilter: claim alleen replies op déze request-ids (CLI `--in-reply-to`). */
  inReplyTo?: string[];
}
```

En vervang `claim()` (r77–117) integraal door (dynamische paramnummering; gedrag zonder `inReplyTo` identiek aan vandaag):

```ts
export async function claim(
  client: Client, opts: ClaimOpts, channel?: string,
): Promise<Message | null> {
  // Expliciete --reclaim-after wint; anders config-default.
  const reclaimInterval =
    opts.reclaimAfterMin && opts.reclaimAfterMin > 0
      ? `${opts.reclaimAfterMin} minutes`
      : opts.reclaimDefault ?? null;
  const params: unknown[] = [opts.claimedBy, opts.toServer, opts.toModel, opts.types];
  let reclaimClause = '';
  if (reclaimInterval) {
    params.push(reclaimInterval);
    reclaimClause = `OR (status = 'claimed' AND claimed_at < now() - $${params.length}::interval)`;
  }
  let replyFilter = '';
  if (opts.inReplyTo && opts.inReplyTo.length > 0) {
    params.push(opts.inReplyTo);
    replyFilter = `AND in_reply_to = ANY($${params.length}::uuid[])`;
  }

  // CTE: target houdt de pre-update status vast, updated geeft de nieuwe rij terug.
  const { rows } = await client.query<Message & { previous_status: Status }>(
    `WITH target AS (
       SELECT id, status FROM agent_message
        WHERE to_server=$2 AND to_model=$3 AND type = ANY($4::text[])
          AND (status='pending' ${reclaimClause})
          ${replyFilter}
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED LIMIT 1
     ),
     updated AS (
       UPDATE agent_message
          SET status='claimed', claimed_by=$1, claimed_at=now(), started_at=now()
        WHERE id IN (SELECT id FROM target)
        RETURNING *
     )
     SELECT updated.*, target.status AS previous_status
       FROM updated JOIN target ON updated.id = target.id`,
    params,
  );
  const row = rows[0];
  if (!row) return null;
  const { previous_status, ...message } = row;
  if (channel) {
    await notify(client, channel, envelopeOf(message as Message, previous_status));
  }
  return message as Message;
}
```

En voeg in `listenAndClaim` in `onNotify` (r266–276) ná de `types`-check (`if (!opts.types.includes(p.type)) return;`) deze regel toe:

```ts
      if (opts.inReplyTo && opts.inReplyTo.length > 0 &&
          (!p.in_reply_to || !opts.inReplyTo.includes(p.in_reply_to))) return;
```

- [ ] Pas `src/cli.ts` aan. Voeg aan `OPTS` (r119–130) toe: `'in-reply-to': { type: 'string' },`. Vervang de kop van de gedeelde `next`/`inbox`-case (r153–166) door:

```ts
    case 'next':
    case 'inbox': {
      if (cmd === 'next' && values['in-reply-to'] !== undefined) {
        throw new Error('--in-reply-to is alleen geldig bij inbox');
      }
      const inReplyTo = typeof values['in-reply-to'] === 'string'
        ? String(values['in-reply-to']).split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      if (values['in-reply-to'] !== undefined && (!inReplyTo || inReplyTo.length === 0)) {
        throw new Error('--in-reply-to vereist minstens één id');
      }
      const types = cmd === 'next' ? [...REQUEST_TYPES] : [...RESPONSE_TYPES];
      const opts = {
        toServer: config.self, toModel: model(values), types, claimedBy,
        reclaimAfterMin: values['reclaim-after'] ? Number(values['reclaim-after']) : undefined,
        reclaimDefault: config.reclaimDefault,
        inReplyTo,
      };
      const msg = values.wait
        ? await listenAndClaim(client, opts, config.channel)
        : await claim(client, opts, config.channel);
      if (values.json) return JSON.stringify({ message: msg });
      return msg ? `${msg.type} ${msg.id}\nfrom ${msg.from_server}:${msg.from_model}\n\n${msg.body}` : '(leeg)';
    }
```

En voeg in `HELP_TEXT` direct ná het Reclaim-blok (r92–94) toe:

```
Correlatie (meerdere sessies op één adres):
  --in-reply-to <id,...>     bij inbox: claim alleen antwoorden op déze verzoeken
```

- [ ] Draai de test opnieuw: `npx vitest run test/inbox-in-reply-to.test.ts` → verwacht: PASS (6 tests groen).
- [ ] Volledige suite + typecheck + build: `npm test && npm run typecheck && npm run build` → verwacht: alles groen (de bestaande suite bewijst dat gedrag zonder `--in-reply-to` ongewijzigd is).
- [ ] Commit: `git add src/db.ts src/cli.ts test/inbox-in-reply-to.test.ts && git commit -m "feat(inbox): --in-reply-to correlatiefilter in de claim-query (CLI-pariteit fase 3)"`
- [ ] Notitie voor JP (niet uitvoeren in dit plan): na merge hoort `npm run build` + herinstallatie van de globale bin op mac, scrum4me-server en max2 bij het cutover-draaiboek van fase 1 (§4.4 stap 5).

---

### Task 7: Rules-file herschrijven (`~/.claude/rules/s4m-queue.md`) — JP-akkoord vereist

**Dit is een user-globaal bestand: JP ziet de volledige nieuwe inhoud vóór hij ingaat.** Niet direct overschrijven — eerst als voorstel tonen (diff met de huidige inhoud), pas na expliciet akkoord van JP wegschrijven. Timing: activeren is pas zinvol nadat fase 2+3 gedeployed zijn op de host in kwestie (anders verwijzen de triggers naar niet-bestaande tools); distributie naar scrum4me-server/max2 gaat via de bestaande rules-sync-flow (`s4m-rules-apply`) — JP kiest het moment.

**Files:**
- Modify (pas na JP-akkoord): `~/.claude/rules/s4m-queue.md` — volledige vervanging door onderstaande inhoud.

**Stappen:**

- [ ] Lees de huidige `~/.claude/rules/s4m-queue.md` en toon JP de diff met de nieuwe inhoud hieronder.
- [ ] Vraag JP expliciet akkoord in de chat. Geen akkoord → taak stopt hier (de rest van fase 3 is er niet van afhankelijk).
- [ ] Na akkoord: schrijf exact deze inhoud naar `~/.claude/rules/s4m-queue.md`:

~~~markdown
# Cross-agent communicatie (s4m-queue)

Berichten-queue tussen hosts `mac`, `scrum4me-server`, `max2` en participants `claude`, `codex`, `jp` (mens), op de scrum4me-DB. Agents (claude, codex) gebruiken de **MCP-tools** van de `scrum4me` MCP; de `s4m-queue` CLI blijft voor jp (mens) en als fallback. MCP-identiteit = `S4M_SERVER` + `S4M_MODEL` uit de server-config (override per call via `as`); ontbreekt die → `QUEUE_IDENTITY_REQUIRED`.

**MCP-tools:** `queue_push · queue_wait_reply · queue_next · queue_done · queue_fail · queue_status · queue_list`. Admin (`requeue`, `cancel`, volledige `list`-varianten, cleanup) blijft CLI.

**Triggers** (gebruiker zegt → jij doet):
- "stuur dit naar <server / model / mac / max2 / jp>" → `queue_push {to, type, body, …}` — bewaar het teruggegeven `message_id`; dat is je handle voor het antwoord.
- "heb ik antwoord?" / wachten op een reply → `queue_wait_reply {message_ids: [...]}` met je eigen request-ids. Blokkerend (`wait_seconds: 300`) of niet-blokkerend (`wait_seconds: 0`, doorwerken en later checken). Timeout is géén fout: gewoon opnieuw aanroepen. De respons bevat álle beschikbare replies (elk met `in_reply_to`); verwijder beantwoorde ids uit volgende aanroepen. Gelezen replies zijn meteen ge-ackt (auto-ack) — nogmaals lezen kan altijd, zelfde inhoud.
- "werk de queue af" / "is er werk voor mij?" → `queue_next` (claim → uitvoeren binnen `meta.task.cwd` → `queue_done {message_id, reply, claim_token}`). Ontbreekt vereiste context → `queue_fail {message_id, error, claim_token}`, niet raden; daarna stoppen (stop-bij-eerste-fout).
- "is er al antwoord?" zonder te claimen → `queue_status {message_id}` (read-only, toont bericht + alle replies).
- "wat staat er open?" / **herstel na sessie-crash** → `queue_list` — vindt je uitstaande requests terug (`direction: 'sent'`); doe daarna gewoon `queue_wait_reply` op die ids. Niets raakt wees.

**Sturen:** `task` en `review_request` vereisen `meta.task`; via de MCP volstaan `cwd` + `objective`/`verification`/`response_format` — de tool leidt `repo` zelf af uit de cwd (lukt dat niet, geef `meta.repo` expliciet mee). `info` = data-vraag of ja/nee aan JP (geen meta). Antwoord-types: task→result, info→data, review_request→reviewed.

**Claims & leases:**
- `queue_next` geeft een `claim_token`; geef dat mee aan `queue_done`/`queue_fail`. De lease wordt automatisch ververst zolang dít MCP-proces leeft — geen agent-actie nodig, geen handmatige verlenging.
- **Verlopen-claim-protocol:** bij `QUEUE_CLAIM_EXPIRED` of `QUEUE_NOT_CLAIMER` is je claim verlopen (MCP-herstart, sweep-requeue) of door een ander overgenomen. **Gooi lokaal werk weg** — dien nooit resultaten van een verlopen claim alsnog in — en begin desgewenst opnieuw met `queue_next`.
- **Idempotentie-eis voor task-handlers:** schrijf taken zo dat dubbele uitvoering onschadelijk is (zelfde branch/PR hergebruiken, upserts, geen dubbele side-effects). Een requeue kan altijd tot een tweede uitvoering leiden; statusvalidatie voorkomt alleen dubbele *afronding*.
- Vastzittende claims herstellen automatisch: MCP-claims ~5 min na procesdood, CLI-claims na 4 h (`S4M_RECLAIM_DEFAULT`). Levend proces maar gestrande sessie → handmatig `s4m-queue requeue <id>` (jp).

**Echt "seintje" nodig terwijl je doorwerkt?** Start de CLI als background-Bash-taak:

    source ~/.zshenv && s4m-queue inbox --as <model> --wait --in-reply-to <id,...> --json

Die blokkeert tot er een reply op jóuw requests binnenkomt (correlatie-veilig). Let op: deze CLI-claim moet je ook via de CLI ack-en (`s4m-queue done <id>`) — de MCP rondt CLI-claims bewust niet af.

**CLI-fallback** (jp, of als de MCP onbereikbaar is): `push · next · inbox · done · fail · peek · list · status · requeue · cancel`; `--as` verplicht bij push/next/inbox/peek; `inbox --in-reply-to <id,...>` filtert op je eigen requests. Env vereist (`S4M_QUEUE_URL` + `S4M_SERVER`): mac = `~/.zshenv`, scrum4me-server = `~/.config/s4m-queue.env` — source in hetzelfde commando. `s4m-queue --help` werkt zonder env.

**Bestemmingen:** agents `scrum4me-server:claude`, `max2:claude`, `mac:claude`, `mac:codex`; mens `mac:jp` — JP claimt via terminal (`s4m-queue next --as jp`) of het Messages-dashboard in **scrum4me-workers** (`/queue/messages`). Stuur aan JP wat review/akkoord vereist dat je niet zelf kunt beslissen.

**Realtime:** elke statuswisseling emit een NotifyEnvelope (`{id, type, from_*, to_*, in_reply_to, status, previous_status}`) op kanaal `agent_queue`. Wait-tools, CLI `--wait` en het dashboard gebruiken dit — niet pollen.
~~~

- [ ] Verifieer: `head -5 ~/.claude/rules/s4m-queue.md` → verwacht: de nieuwe kop. Geen git-commit (bestand staat buiten alle repo's); meld JP dat de rules-sync naar de andere hosts een aparte actie is.

---

### Task 8: Eindverificatie

**Files:**
- Geen wijzigingen — alleen verificatie.

**Stappen:**

- [ ] scrum4me-mcp: `npm run typecheck && npm test` → verwacht: groen.
- [ ] scrum4me-mcp integratie (indien test-DB beschikbaar): `TEST_DATABASE_URL=<scrum4me-test-db-url> npx vitest run __tests__/queue-sweep-lease.integration.test.ts` → verwacht: 9 tests groen.
- [ ] s4m-queue: `cd ~/Development/s4m-queue && npm test && npm run typecheck` → verwacht: groen (CLI-compatibiliteitsbewijs uit §8: de bestaande suite draait ongewijzigd).
- [ ] Rooktest bootstrap: start de stdio-server lokaal (`npm run dev` in scrum4me-mcp, met geldige `DATABASE_URL`), wacht 15 s, stop met Ctrl-C → verwacht: geen errors op stderr bij start of shutdown (refresh/sweep starten en stoppen schoon).
- [ ] Meld in de afronding expliciet welke onderdelen wachten op deploy-acties buiten dit plan: fase-1-migratie op productie (alleen na expliciet JP-akkoord), s4m-queue-bin-herinstallatie op de drie hosts, rules-sync naar scrum4me-server/max2.
