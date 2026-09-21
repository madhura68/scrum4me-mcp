import type { Pool } from 'pg'
import type { DispatchProjection } from '@shared/queue-dispatch-projection.js'
import { withDispatchTransaction, type DispatchStore } from './db.js'
import { applyDispatchProjection } from './projection.js'
import { deliveryBackoffSeconds } from './outbox.js'

/** `queue` connects as s4m_dispatch_projector to DISPATCH_QUEUE_DATABASE_URL, which may or may not be the
 * dispatch database. Delivery never touches execution state or a canonical result, whatever happens here. */
export function createDispatchDelivery(deps: { store: DispatchStore; queue: Pool; random?: () => number }) {
  async function deliverDispatchOutbox(limit: number): Promise<{ delivered: number; failed: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('DISPATCH_INVALID_INPUT')
    let delivered = 0, failed = 0
    for (let i = 0; i < limit; i++) {
      const outcome = await withDispatchTransaction(deps.store, async db => {
        // The newest due snapshot of one request. SKIP LOCKED keeps two projectors off the same row; the
        // version guard in the queue keeps them correct even when they are not.
        const row = (await db.query<{ id: string; request_id: string; version: string; payload: DispatchProjection }>(`SELECT o.id,o.request_id,o.version::text,o.payload FROM queue_dispatch_outbox o
          WHERE o.published_at IS NULL AND o.next_attempt_at<=now()
            AND NOT EXISTS(SELECT 1 FROM queue_dispatch_outbox newer WHERE newer.request_id=o.request_id AND newer.version>o.version)
          ORDER BY o.next_attempt_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`)).rows[0]
        if (!row) return 'idle' as const
        try {
          const client = await deps.queue.connect()
          try { await applyDispatchProjection(client, row.payload) } finally { client.release() }
        } catch {
          const attempts = (await db.query<{ attempts: number }>('UPDATE queue_dispatch_outbox SET attempts=attempts+1 WHERE id=$1 RETURNING attempts', [row.id])).rows[0].attempts
          await db.query("UPDATE queue_dispatch_outbox SET next_attempt_at=now()+($2::text||' seconds')::interval WHERE id=$1", [row.id, deliveryBackoffSeconds(attempts, deps.random).toFixed(3)])
          return 'failed' as const
        }
        // Only after the queue commit is confirmed. A crash before this line replays the same snapshot.
        // Older snapshots of the same request are superseded: the newest one already contains them.
        await db.query('UPDATE queue_dispatch_outbox SET published_at=now() WHERE request_id=$1 AND version<=$2::bigint AND published_at IS NULL', [row.request_id, row.version])
        return 'delivered' as const
      })
      if (outcome === 'idle') break
      if (outcome === 'delivered') delivered++; else failed++
    }
    return { delivered, failed }
  }
  return { deliverDispatchOutbox }
}
