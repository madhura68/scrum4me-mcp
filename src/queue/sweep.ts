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
    // Zelfde reden als de presence-heartbeat (src/presence/heartbeat.ts) en de
    // lease-refresh: een lopende maintenance-tick mag op zichzelf geen reden
    // zijn om te blijven leven, anders houdt hij de event-loop open nadat de
    // MCP-client weg is.
    timer.unref?.()
  }
  schedule()
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
