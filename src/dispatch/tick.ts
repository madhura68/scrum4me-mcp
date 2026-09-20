import type { DispatchStore } from './db.js'
import type { DispatchAttempts } from './attempts.js'
import type { DispatchSelection } from './selection.js'
import type { createDispatchDelivery } from './delivery.js'

/** Per §2.1 one tick touches at most 25 requests and at most 100 outbox items. */
export const DISPATCH_TICK_REQUEST_LIMIT = 25
export const DISPATCH_TICK_OUTBOX_LIMIT = 100
/** Queue maintenance is hourly-scale work on a five-second tick: both stages are bounded so one
 * pass can never become a long transaction on the queue, and both are idempotent, so the next
 * pass finishes what this one left. */
export const DISPATCH_TICK_MAINTENANCE_LIMIT = 100
export const DISPATCH_TICK_RETENTION_LIMIT = 25

export type DispatchTickResult = {
  prepared: number; reserved: number; retired: number; uncertain: number
  publications: number; publicationsFailed: number
  delivered: number; deliveryFailed: number
  replyReadsRecovered: number; threadsArchived: number; threadsRefused: number
  errors: number
}
/** Projector-side repair and retention. Neither carries an actor or grants authority: they only
 * hand a forgotten reply back to its reader and move a finished thread into the archive, so they
 * belong to the service's own tick rather than to an operator command. Retention deletes hot
 * rows, so the deployment opts into it by supplying `retainThreads`; repair is always safe. */
export type DispatchMaintenance = {
  intervalMs: number
  now?: () => number
  recoverReplyReads: (limit: number) => Promise<string[]>
  retainThreads?: (limit: number) => Promise<{ archived: number; refused: number }>
}
export type DispatchTickDependencies = {
  store: DispatchStore
  selection: DispatchSelection
  attempts?: DispatchAttempts
  delivery?: ReturnType<typeof createDispatchDelivery>
  sources?: { prepareRequestSources(requestId: string): Promise<void> }
  publications?: { reconcileIncompletePublications(): Promise<{ processed: number; failed: number }> }
  maintenance?: DispatchMaintenance
  onError?: (stage: string, error: unknown) => void
}

/** Importing this module starts nothing; server.ts owns listener and timer wiring.
 *
 * Every stage is bounded and every durable unit is attempted on its own: one poisoned
 * request, attempt or outbox row can slow a tick down but never stop the ones behind it.
 * Delivery runs last precisely because projection must never hold up selection or leases. */
export function createDispatchTick(deps: DispatchTickDependencies) {
  let errors = 0
  let nextMaintenanceAt = 0
  async function unit<T>(stage: string, fallback: T, run: () => Promise<T>): Promise<T> {
    try { return await run() } catch (error) {
      errors++
      try { deps.onError?.(stage, error) } catch { /* Reporting cannot fail a tick. */ }
      return fallback
    }
  }
  return async function dispatchTick(): Promise<DispatchTickResult> {
    errors = 0
    let prepared = 0, reserved = 0, retired = 0
    const expired = await unit('expire:select', [] as { request_id: string }[], async () => (await deps.store.query<{ request_id: string }>(
      `SELECT request_id FROM queue_dispatch_candidates WHERE state='RESERVED' AND deadline<=now() ORDER BY deadline,id LIMIT ${DISPATCH_TICK_REQUEST_LIMIT}`)).rows)
    for (const c of expired) if (await unit('expire', false, () => deps.selection.retireExpiredCandidate(c.request_id))) retired++
    const waiting = await unit('waiting', [] as string[], () => deps.selection.waitingRequestIds(DISPATCH_TICK_REQUEST_LIMIT - expired.length))
    // Pinned sources must exist before a request can be reserved; preparation is retried
    // per request and its failure only keeps that one request waiting.
    for (const id of waiting) {
      if (!deps.sources) break
      if (await unit('sources', false, async () => { await deps.sources!.prepareRequestSources(id); return true })) prepared++
    }
    for (const id of waiting) if (await unit('reserve', null, () => deps.selection.reserveRequest(id))) reserved++
    const uncertain = deps.attempts ? await unit('lease', 0, () => deps.attempts!.markExpiredAttempts(DISPATCH_TICK_REQUEST_LIMIT)) : 0
    const publication = deps.publications
      ? await unit('publication', { processed: 0, failed: 0 }, () => deps.publications!.reconcileIncompletePublications())
      : { processed: 0, failed: 0 }
    const projected = deps.delivery
      ? await unit('delivery', { delivered: 0, failed: 1 }, () => deps.delivery!.deliverDispatchOutbox(DISPATCH_TICK_OUTBOX_LIMIT))
      : { delivered: 0, failed: 0 }
    // Maintenance runs last and only when its own interval is due: selection, leases and
    // delivery never wait behind a repair or an archive pass.
    let replyReadsRecovered = 0, threadsArchived = 0, threadsRefused = 0
    const maintenance = deps.maintenance
    if (maintenance) {
      const at = (maintenance.now ?? Date.now)()
      if (at >= nextMaintenanceAt) {
        nextMaintenanceAt = at + maintenance.intervalMs
        replyReadsRecovered = (await unit('maintenance:reply_reads', [] as string[],
          () => maintenance.recoverReplyReads(DISPATCH_TICK_MAINTENANCE_LIMIT))).length
        const retain = maintenance.retainThreads
        if (retain) {
          const retained = await unit('maintenance:retention', { archived: 0, refused: 0 },
            () => retain(DISPATCH_TICK_RETENTION_LIMIT))
          threadsArchived = retained.archived; threadsRefused = retained.refused
        }
      }
    }
    return { prepared, reserved, retired, uncertain, publications: publication.processed,
      publicationsFailed: publication.failed, delivered: projected.delivered, deliveryFailed: projected.failed,
      replyReadsRecovered, threadsArchived, threadsRefused, errors }
  }
}
