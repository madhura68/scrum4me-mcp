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
import { legacyMarkerWhere } from './marked.js'

export const LEASE_REFRESH_INTERVAL_MS = 10_000

export async function refreshQueueLeases(): Promise<void> {
  for (const { messageId, claimedBy } of leaseEntries()) {
    try {
      const result = await prisma.agentMessage.updateMany({
        where: {
          id: messageId, status: 'claimed', claimed_by: claimedBy,
          ...legacyMarkerWhere(),
        },
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

  // Zelfde reden als de presence-heartbeat (src/presence/heartbeat.ts): een
  // lopende maintenance-tick mag op zichzelf geen reden zijn om te blijven
  // leven, anders houdt hij de event-loop open nadat de MCP-client weg is.
  timer.unref?.()

  return { stop: () => clearInterval(timer) }
}
