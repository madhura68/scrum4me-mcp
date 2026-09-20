import type { DispatchStore } from './db.js'
import type { DispatchAttempts } from './attempts.js'
import type { DispatchSelection } from './selection.js'
import type { createDispatchDelivery } from './delivery.js'
/** Importing this module starts nothing. IP-13 owns listener/timer wiring;
 * Pass attempts to process expired attempts as well as reservations, and delivery to project the outbox.
 * Delivery runs last and its failures never fail the tick: projection must not hold up selection or leases. */
export function createDispatchTick(deps: { store: DispatchStore; selection: DispatchSelection; attempts?: DispatchAttempts; delivery?: ReturnType<typeof createDispatchDelivery> }) {
  return async function dispatchTick(): Promise<{ reserved: number; retired: number; uncertain: number; delivered: number; deliveryFailed: number }> {
    let reserved = 0, retired = 0
    const expired = (await deps.store.query<{ request_id: string }>(`SELECT request_id FROM queue_dispatch_candidates WHERE state='RESERVED' AND deadline<=now() ORDER BY deadline,id LIMIT 25`)).rows
    for (const c of expired) if (await deps.selection.retireExpiredCandidate(c.request_id)) retired++
    for (const id of await deps.selection.waitingRequestIds(25 - expired.length)) if (await deps.selection.reserveRequest(id)) reserved++
    const uncertain = await deps.attempts?.markExpiredAttempts() ?? 0
    const projected = await deps.delivery?.deliverDispatchOutbox(25).catch(() => ({ delivered: 0, failed: 1 })) ?? { delivered: 0, failed: 0 }
    return { reserved, retired, uncertain, delivered: projected.delivered, deliveryFailed: projected.failed }
  }
}
