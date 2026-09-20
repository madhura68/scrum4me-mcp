import {projectManagedTaskStatus} from './task-status.js'
import {writeDispatchOutbox} from './outbox.js'
import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import type {DispatchResult,DispatchView} from '@shared/queue-dispatch.js'
import type {ArtifactAttempt} from './artifacts.js'
import {artifactHash} from './artifacts.js'
import {DispatchError} from './errors.js'
export function canonicalResult(value:unknown):string{
 if(Array.isArray(value))return `[${value.map(canonicalResult).join(',')}]`
 if(value!==null&&typeof value==='object')return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonicalResult(v)}`).join(',')}}`
 return JSON.stringify(value)
}
export async function lifecycleEvent(db:PoolClient,requestId:string,type:string,payload:unknown,attemptId:string|null=null,actor:unknown={service:'dispatch'}):Promise<string>{
 const id=randomUUID();await db.query('INSERT INTO queue_dispatch_events(id,request_id,attempt_id,type,actor,payload) VALUES($1,$2,$3,$4,$5,$6)',[id,requestId,attemptId,type,actor,payload]);return id
}
export async function transition(db:PoolClient,id:string,state:string,resultId?:string){
 const r=(await db.query('UPDATE queue_dispatch_requests SET state=$2,result_id=COALESCE($3::uuid,result_id),version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[id,state,resultId??null])).rows[0]
 if(!r)throw new DispatchError('DISPATCH_NOT_FOUND')
 await writeDispatchOutbox(db,id)
}
export async function unresolvedPublication(db:PoolClient,id:string){return !!(await db.query("SELECT 1 FROM queue_dispatch_publications WHERE request_id=$1 AND state IN ('PREPARED','SENT','UNKNOWN')",[id])).rowCount}
export async function terminalizeAttempt(db:PoolClient,x:ArtifactAttempt,outcome:'SUCCEEDED'|'FAILED'|'CANCELLED'){
 if(!x.a.stopped_at||await unresolvedPublication(db,x.r.id))throw new DispatchError('DISPATCH_STATE_CONFLICT')
 await db.query('UPDATE queue_dispatch_attempts SET state=$2,revoked_at=COALESCE(revoked_at,now()) WHERE id=$1',[x.a.id,outcome])
 if(x.c.job_id)await db.query('UPDATE claude_jobs SET status=$2,finished_at=now(),updated_at=now() WHERE id=$1',[x.c.job_id,outcome==='SUCCEEDED'?'DONE':outcome])
 await db.query("UPDATE queue_dispatch_candidates SET state='FINISHED' WHERE id=$1",[x.c.id])
 await db.query('UPDATE queue_dispatch_reservations SET released_at=now() WHERE candidate_id=$1 AND released_at IS NULL',[x.c.id])
}
export async function insertResult(db:PoolClient,id:string,attemptId:string|null,result:DispatchResult,sourceRefs:unknown):Promise<string>{
 const hash=artifactHash(canonicalResult(result)),old=(await db.query('SELECT id,sha256 FROM queue_dispatch_results WHERE request_id=$1',[id])).rows[0]
 if(old){if(old.sha256!==hash)throw new DispatchError('DISPATCH_IDEMPOTENCY_CONFLICT');return old.id}
 const resultId=randomUUID();await db.query('INSERT INTO queue_dispatch_results(id,request_id,attempt_id,outcome,payload,source_refs,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[resultId,id,attemptId,result.outcome.toUpperCase(),result,sourceRefs??{},hash]);return resultId
}
export async function lifecycleView(db:PoolClient,id:string):Promise<DispatchView>{
 const r=(await db.query('SELECT r.*,c.route,c.profile_revision_id,c.job_id FROM queue_dispatch_requests r LEFT JOIN queue_dispatch_candidates c ON c.request_id=r.id AND c.generation=r.generation WHERE r.id=$1',[id])).rows[0]
 return {id:r.id,version:String(r.version),state:r.state,action:r.input.action,reason:r.state.toLowerCase(),route:r.route??null,profile_revision_id:r.profile_revision_id??null,job_id:r.job_id??null,executor_label:null,result_id:r.result_id,delivery:'pending',created_at:r.created_at.toISOString()}
}
export async function finishResult(db:PoolClient,x:ArtifactAttempt,result:DispatchResult,submittedHash:string):Promise<{accepted:boolean;resultId:string|null;reason:string}>{
 const id=await insertResult(db,x.r.id,x.a.id,result,x.r.input.review_documents),outcome=result.outcome.toUpperCase() as 'SUCCEEDED'|'FAILED'|'CANCELLED'
 await transition(db,x.r.id,outcome,id)
 await terminalizeAttempt(db,x,outcome)
 if(x.r.input.action==='task_implementation'){
  if(outcome!=='CANCELLED')await projectManagedTaskStatus(db,x.r.input.task_id!,outcome==='SUCCEEDED'?'DONE':'FAILED')
  await db.query('UPDATE tasks SET dispatch_request_id=NULL WHERE id=$1 AND dispatch_request_id=$2',[x.r.input.task_id,x.r.id])
 }
 await lifecycleEvent(db,x.r.id,'result_accepted',{result_id:id,submitted_hash:submittedHash},x.a.id)
 return {accepted:true,resultId:id,reason:outcome.toLowerCase()}
}

/** An authenticated stop can finish ordinary cancellation without inventing a model report. */
export async function finishStoppedCancellation(db:PoolClient,x:ArtifactAttempt){
 if(x.r.state!=='CANCEL_REQUESTED'||await unresolvedPublication(db,x.r.id))return
 if((await db.query('SELECT 1 FROM queue_dispatch_results WHERE request_id=$1',[x.r.id])).rowCount)return
 const result:DispatchResult={version:1,outcome:'cancelled',summary:'Cancelled execution has stopped',report_markdown:'The bound supervisor confirmed termination after cancellation.',checks:[]}
 await finishResult(db,x,result,artifactHash(canonicalResult(result)))
}
