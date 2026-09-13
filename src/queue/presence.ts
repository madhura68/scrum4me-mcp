import { PRESENCE_FRESH_SECONDS, QUEUE_JOB_SERVER } from '@shared/queue-identity.js'
import { prisma } from '../prisma.js'

export type PresenceStatus = 'weg' | 'bezig' | 'beschikbaar' | 'onbemand'

export interface PresenceView {
  address: string
  status: PresenceStatus
  watcher: {
    heartbeat_at: string
    age_s: number
    started_at: string | null
    pid: number | null
    types: string[]
  } | null
  session: {
    announced_at: string | null
    last_drain_at: string | null
    signed_off_at: string | null
    expected_by: string | null
  }
  claims: { open: number; oldest_claimed_at: string | null; message_ids: string[] }
}

interface PresenceRow {
  server: string
  model: string
  watcher_heartbeat_at: Date | null
  watcher_started_at: Date | null
  watcher_pid: number | null
  watcher_types: string[] | null
  session_announced_at: Date | null
  session_last_drain_at: Date | null
  session_signed_off_at: Date | null
  session_expected_by: Date | null
  open_claims: number
  oldest_claimed_at: Date | null
  claim_ids: string[] | null
}

/**
 * Leesregels spec §6.1 — volgorde bindend. Bewuste tweelingimplementatie van
 * s4m-queue/src/presence-db.ts: de CLI en de MCP lezen dezelfde tabel en moeten
 * hetzelfde antwoord geven. De drempel komt uit @shared, niet uit een eigen
 * constante — de vocab-drift-gate in s4m-queue bewaakt dat de twin daar gelijk
 * aan blijft.
 *
 * Vers = hartslag ≤ PRESENCE_FRESH_SECONDS geleden óf session_expected_by in de
 * toekomst (de poll-route, die geen watch-proces heeft).
 */
export function derivePresenceStatus(i: {
  watcherHeartbeatAt: Date | null
  sessionExpectedBy: Date | null
  sessionAnnouncedAt: Date | null
  sessionSignedOffAt: Date | null
  openClaims: number
  now?: Date
}): PresenceStatus {
  const now = i.now ?? new Date()
  const heartbeatFresh =
    i.watcherHeartbeatAt !== null &&
    (now.getTime() - i.watcherHeartbeatAt.getTime()) / 1000 <= PRESENCE_FRESH_SECONDS
  const expectedFresh =
    i.sessionExpectedBy !== null && i.sessionExpectedBy.getTime() > now.getTime()
  if (!heartbeatFresh && !expectedFresh) return 'weg'
  if (i.openClaims > 0) return 'bezig'
  const aangemeld =
    i.sessionAnnouncedAt !== null &&
    (i.sessionSignedOffAt === null || i.sessionAnnouncedAt > i.sessionSignedOffAt)
  return aangemeld ? 'beschikbaar' : 'onbemand'
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null)

function toView(r: PresenceRow, now: Date): PresenceView {
  return {
    address: `${r.server}:${r.model}`,
    status: derivePresenceStatus({
      watcherHeartbeatAt: r.watcher_heartbeat_at,
      sessionExpectedBy: r.session_expected_by,
      sessionAnnouncedAt: r.session_announced_at,
      sessionSignedOffAt: r.session_signed_off_at,
      openClaims: Number(r.open_claims ?? 0),
      now,
    }),
    watcher: r.watcher_heartbeat_at
      ? {
          heartbeat_at: iso(r.watcher_heartbeat_at)!,
          age_s: Math.round(
            (now.getTime() - new Date(r.watcher_heartbeat_at).getTime()) / 1000,
          ),
          started_at: iso(r.watcher_started_at),
          pid: r.watcher_pid,
          types: r.watcher_types ?? [],
        }
      : null,
    session: {
      announced_at: iso(r.session_announced_at),
      last_drain_at: iso(r.session_last_drain_at),
      signed_off_at: iso(r.session_signed_off_at),
      expected_by: iso(r.session_expected_by),
    },
    claims: {
      open: Number(r.open_claims ?? 0),
      oldest_claimed_at: iso(r.oldest_claimed_at),
      message_ids: r.claim_ids ?? [],
    },
  }
}

/**
 * Leeskant (spec §6.2). Raw SQL, niet de Prisma-querytaal: de LATERAL-join met
 * het claimdetail is daarin niet uit te drukken, en zo blijft de query
 * letterlijk gelijk aan die van de CLI.
 */
export async function readPresenceViews(filter?: {
  server?: string
  model?: string
}): Promise<PresenceView[]> {
  const now = new Date()
  const server = filter?.server ?? null
  const model = filter?.model ?? null
  const rows = await prisma.$queryRaw<PresenceRow[]>`
    SELECT p.*, COALESCE(c.open_claims, 0) AS open_claims, c.oldest_claimed_at, c.claim_ids
      FROM agent_presence p
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS open_claims, min(COALESCE(m.started_at, m.claimed_at)) AS oldest_claimed_at,
               (SELECT array_agg(id) FROM (
                  SELECT id FROM agent_message
                   WHERE to_server = p.server AND to_model = p.model AND status = 'claimed'
                   ORDER BY COALESCE(started_at, claimed_at) LIMIT 5) ids) AS claim_ids
          FROM agent_message m
         WHERE m.to_server = p.server AND m.to_model = p.model AND m.status = 'claimed'
      ) c ON true
     WHERE (${server}::text IS NULL OR p.server = ${server})
       AND (${model}::text IS NULL OR p.model = ${model})
     ORDER BY p.server, p.model`

  if (rows.length === 0 && server !== null && model !== null) {
    // Volledig adres zonder rij: één synthetische 'weg'-entry mét claimdetail,
    // zodat een nooit-gezien adres scriptbaar blijft (spec §6.2).
    const claims = await prisma.$queryRaw<
      { open_claims: number; oldest_claimed_at: Date | null; claim_ids: string[] | null }[]
    >`
      SELECT count(*)::int AS open_claims, min(COALESCE(started_at, claimed_at)) AS oldest_claimed_at,
             (SELECT array_agg(id) FROM (
                SELECT id FROM agent_message
                 WHERE to_server = ${server} AND to_model = ${model} AND status = 'claimed'
                 ORDER BY COALESCE(started_at, claimed_at) LIMIT 5) ids) AS claim_ids
        FROM agent_message WHERE to_server = ${server} AND to_model = ${model} AND status = 'claimed'`
    return [
      toView(
        {
          server,
          model,
          watcher_heartbeat_at: null,
          watcher_started_at: null,
          watcher_pid: null,
          watcher_types: null,
          session_announced_at: null,
          session_last_drain_at: null,
          session_signed_off_at: null,
          session_expected_by: null,
          open_claims: claims[0]?.open_claims ?? 0,
          oldest_claimed_at: claims[0]?.oldest_claimed_at ?? null,
          claim_ids: claims[0]?.claim_ids ?? null,
        },
        now,
      ),
    ]
  }
  return rows.map((r) => toView(r, now))
}

/** Best-effort lezen voor een antwoordveld: bij élke fout null — veld weglaten. */
export async function readPresenceBlockBestEffort(
  server: string,
  model: string,
): Promise<PresenceView | null> {
  try {
    const [view] = await readPresenceViews({ server, model })
    return view ?? null
  } catch (err) {
    console.error('[scrum4me-mcp] presence read failed (best-effort):', err)
    return null
  }
}

/**
 * Drain-stempel op de MCP-claimpaden. Zet NOOIT session_expected_by: een
 * MCP-sessie heeft een watch-proces en hoeft geen termijn te beloven.
 */
export async function stampDrainPresenceBestEffort(
  server: string,
  model: string,
): Promise<void> {
  // Job-namespace heeft geen (server, model)-adres — nooit een presence-rij
  // (zelfde guard als de CLI-twin in s4m-queue/src/presence-db.ts).
  if (server === QUEUE_JOB_SERVER) return
  try {
    await prisma.$executeRaw`
      INSERT INTO agent_presence (server, model, session_last_drain_at, updated_at)
      VALUES (${server}, ${model}, now(), now())
      ON CONFLICT (server, model) DO UPDATE SET
        session_last_drain_at = now(), updated_at = now()`
  } catch (err) {
    console.error('[scrum4me-mcp] presence drain-stamp failed (best-effort):', err)
  }
}
