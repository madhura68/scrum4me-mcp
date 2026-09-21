import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { DispatchInput, DispatchResult, DispatchState } from '@shared/queue-dispatch.js'
import { buildDispatchProjection, type DispatchProjection } from '@shared/queue-dispatch-projection.js'
import { DispatchError } from './errors.js'
import { notifyDispatchTick } from './notify.js'

type Row = {
  id: string; version: string; state: DispatchState; input: DispatchInput
  root_message_id: string; reply_message_id: string
  route: 'job' | 'host' | null; waiting_reason: string | null; result: DispatchResult | null
}
/** Writes the outbox row for the request's CURRENT version, in the caller's transaction and under its request
 * lock. The payload is the complete projection at that version, so delivery never reads later state and a
 * later version never needs an earlier one. It holds the visible request and the canonical result only. */
export async function writeDispatchOutbox(db: PoolClient, requestId: string): Promise<DispatchProjection> {
  const r = (await db.query<Row>(`SELECT r.id,r.version::text,r.state,r.input,r.root_message_id,r.reply_message_id,c.route,
    (SELECT e.payload->>'reason' FROM queue_dispatch_events e WHERE e.request_id=r.id AND e.type='waiting_reason' ORDER BY e.created_at DESC,e.id DESC LIMIT 1) AS waiting_reason,
    (SELECT result.payload FROM queue_dispatch_results result WHERE result.id=r.result_id AND result.request_id=r.id) AS result
    FROM queue_dispatch_requests r LEFT JOIN queue_dispatch_candidates c ON c.request_id=r.id AND c.generation=r.generation WHERE r.id=$1`, [requestId])).rows[0]
  if (!r) throw new DispatchError('DISPATCH_NOT_FOUND')
  const projection = buildDispatchProjection({ id: r.id, version: r.version, state: r.state, input: r.input, rootId: r.root_message_id, replyId: r.reply_message_id,
    route: r.route, reason: r.state === 'WAITING' ? (r.waiting_reason ?? 'waiting_for_capacity') : r.state.toLowerCase() }, r.result)
  await db.query('INSERT INTO queue_dispatch_outbox(id,request_id,version,payload) VALUES($1,$2,$3,$4::jsonb)', [randomUUID(), r.id, r.version, JSON.stringify(projection)])
  // Every durable request transition passes here, and so does every outbox row the delivery stage
  // drains: intake, reservation, retirement, cancel, recovery and completion alike. One emit in
  // the caller's own transaction therefore covers every event-driven stage of the tick, and fires
  // at COMMIT — never for a transition that rolled back.
  await notifyDispatchTick(db, 'request', r.id)
  return projection
}
/** 1, 2, 4 ... 60 seconds with bounded jitter. Delivery keeps retrying after the visible failure threshold. */
export const DELIVERY_FAILED_AFTER = 10
export function deliveryBackoffSeconds(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(60, 2 ** Math.max(0, Math.min(attempts, 16) - 1))
  return base + base * 0.2 * random()
}
