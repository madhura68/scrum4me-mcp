import type {PoolClient} from 'pg'
import {DispatchError} from './errors.js'
/** Caller owns request lock. A historical first claim is never itself retry authority. */
export async function assertRetryAuthorization(db:PoolClient,r:{id:string;input_hash:string;retry_authorization_event_id:string|null;generation:number}){
 const e=(await db.query("SELECT * FROM queue_dispatch_events WHERE id=$1 AND request_id=$2 AND type='retry_authorized'",[r.retry_authorization_event_id,r.id])).rows[0]
 if(!e||e.actor.service!=='dispatch'||e.payload.input_hash!==r.input_hash||![r.generation,r.generation-1].includes(e.payload.generation)
  ||(await db.query("SELECT 1 FROM queue_dispatch_events WHERE request_id=$1 AND type='retry_consumed' AND payload->>'authorization_event_id'=$2",[r.id,e.id])).rowCount
  ||(await db.query("SELECT 1 FROM queue_dispatch_publications WHERE request_id=$1 AND state IN ('PREPARED','SENT','UNKNOWN')",[r.id])).rowCount
  ||(await db.query("SELECT 1 FROM queue_dispatch_attempts a JOIN queue_dispatch_candidates c ON c.id=a.candidate_id WHERE c.request_id=$1 AND (a.state NOT IN ('SUCCEEDED','FAILED','CANCELLED') OR a.stopped_at IS NULL OR a.revoked_at IS NULL OR NOT EXISTS(SELECT 1 FROM queue_dispatch_events e WHERE e.request_id=c.request_id AND e.attempt_id=a.id AND e.type='stop_accepted'))",[r.id])).rowCount)throw new DispatchError('DISPATCH_STATE_CONFLICT')
 return e.id as string
}
