import type { DispatchStore } from './db.js'
import type { DispatchSelection } from './selection.js'
/** Importing this module starts nothing. IP-13 owns listener/timer wiring;
 * IP-06 adds uncertainty processing once its handler exists. */
export function createDispatchTick(deps: { store: DispatchStore; selection: DispatchSelection }) {
  return async function dispatchTick(): Promise<{ reserved: number; retired: number; uncertain: number }> {
    let reserved = 0, retired = 0
    const expired = (await deps.store.query<{ request_id: string }>(`SELECT request_id FROM queue_dispatch_candidates WHERE state='RESERVED' AND deadline<=now() ORDER BY deadline,id LIMIT 25`)).rows
    for (const c of expired) if (await deps.selection.retireExpiredCandidate(c.request_id)) retired++
    for (const id of await deps.selection.waitingRequestIds(25 - expired.length)) if (await deps.selection.reserveRequest(id)) reserved++
    return { reserved, retired, uncertain: 0 }
  }
}
