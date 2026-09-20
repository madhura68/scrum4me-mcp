import type {DispatchActor} from './ports.js'
import type {DispatchAuth} from './auth.js'
import type {DispatchView,DispatchResult} from '@shared/queue-dispatch.js'
import {withDispatchRetryTransaction,type DispatchStore} from './db.js'
import {lockArtifactAttempt,artifactHash} from './artifacts.js'
import {lifecycleEvent,canonicalResult,lifecycleView,insertResult,transition} from './lifecycle.js'
import {finishResult} from './completion.js'
import {lockManagedTaskHierarchy} from './task-status.js'
import {DispatchError} from './errors.js'
import {assertRetryAuthorization} from './retry-authorization.js'
export function createDispatchCancellation(deps:{store:DispatchStore;auth:DispatchAuth}){
 async function cancelDispatch(actor:DispatchActor,id:string,actionId:string,expectedVersion:string):Promise<DispatchView>{
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(actionId))throw new DispatchError('DISPATCH_INVALID_INPUT')
  return withDispatchRetryTransaction(deps.store,async db=>{
   const r=(await db.query('SELECT * FROM queue_dispatch_requests WHERE id=$1 FOR UPDATE',[id])).rows[0]
   if(!r)throw new DispatchError('DISPATCH_NOT_FOUND')
   await deps.auth.authorizeDispatch(actor,r.input,'cancel',db)
   if(actor.userId!==r.user_id){
    if(actor.source==='web')throw new DispatchError('DISPATCH_FORBIDDEN')
    // Same current product-administrator authority as explicit recovery; membership alone is insufficient.
    await deps.auth.authorizeDispatch(actor,r.input,'recover',db)
   }
   const hash=artifactHash(canonicalResult({id,expectedVersion})),key=`${actor.principalKey}:cancel:${actionId}`
   const previous=(await db.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='cancel_action' AND payload->>'key'=$2",[id,key])).rows[0]
   if(previous){if(previous.payload.hash!==hash)throw new DispatchError('DISPATCH_IDEMPOTENCY_CONFLICT');return lifecycleView(db,id)}
   if(String(r.version)!==expectedVersion)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   if(r.input.action==='task_implementation')await lockManagedTaskHierarchy(db,r.input.task_id)
   if(!['SUCCEEDED','FAILED','CANCELLED'].includes(r.state)){
    const c=(await db.query("SELECT * FROM queue_dispatch_candidates WHERE request_id=$1 AND generation=$2 AND state NOT IN ('FINISHED','RETIRED') FOR UPDATE",[id,r.generation])).rows[0]
    const a=c?(await db.query('SELECT id FROM queue_dispatch_attempts WHERE candidate_id=$1',[c.id])).rows[0]:null
    const payload:DispatchResult={version:1,outcome:'cancelled',summary:'Cancelled by requester',report_markdown:'The requester cancelled this execution.',checks:[]}
    if(a){
     const x=await lockArtifactAttempt(db,a.id)
     // Requesting the stop is idempotent per request, not per action id: a second cancel carrying a
     // fresh action id must not repeat the transition, bump the version and write another outbox row.
     // The candidate travels with the attempt, exactly as cancelForStop moves it.
     if(r.state!=='CANCEL_REQUESTED'){
      await db.query("UPDATE queue_dispatch_attempts SET state='CANCEL_REQUESTED',revoked_at=COALESCE(revoked_at,now()) WHERE id=$1",[a.id])
      await db.query("UPDATE queue_dispatch_candidates SET state='CANCEL_REQUESTED' WHERE id=$1",[c.id])
      await transition(db,id,'CANCEL_REQUESTED')
      await lifecycleEvent(db,id,'cancel_requested',{stop_required:true},a.id)
     }
     // A genuine accepted stop can finish cancellation only after publication reconciliation.
     const pending=await db.query("SELECT 1 FROM queue_dispatch_publications WHERE request_id=$1 AND state IN ('PREPARED','SENT','UNKNOWN')",[id])
     if(x.a.stopped_at&&!pending.rowCount)await finishResult(db,x,payload,artifactHash(canonicalResult(payload)))
    }else{
     if(r.first_claimed_at)await assertRetryAuthorization(db,r)
     if(c){if(c.first_claimed_at)throw new DispatchError('DISPATCH_STATE_CONFLICT');await db.query('SELECT id FROM queue_dispatch_slots WHERE id=$1 FOR UPDATE',[c.reserved_slot_id]);if(c.job_id){await db.query('SELECT id FROM claude_jobs WHERE id=$1 FOR UPDATE',[c.job_id]);await db.query("UPDATE claude_jobs SET status='CANCELLED',finished_at=now(),updated_at=now() WHERE id=$1",[c.job_id])}await db.query("UPDATE queue_dispatch_candidates SET state='RETIRED' WHERE id=$1",[c.id])}
     const resultId=await insertResult(db,id,null,payload,r.input.review_documents);await transition(db,id,'CANCELLED',resultId)
     if(c)await db.query('UPDATE queue_dispatch_reservations SET released_at=now() WHERE candidate_id=$1 AND released_at IS NULL',[c.id])
     if(r.input.action==='task_implementation')await db.query('UPDATE tasks SET dispatch_request_id=NULL WHERE id=$1 AND dispatch_request_id=$2',[r.input.task_id,id])
     await lifecycleEvent(db,id,r.first_claimed_at?'cancel_recovered_unstarted':'cancel_unclaimed',{result_id:resultId})
    }
   }
   await lifecycleEvent(db,id,'cancel_action',{key,hash},null,{user_id:actor.userId})
   return lifecycleView(db,id)
  })
 }
 return {cancelDispatch}
}
