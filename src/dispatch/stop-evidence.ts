import type {PoolClient} from 'pg'
import type {StopEvidence,AttemptProof} from '@shared/queue-dispatch.js'
import {stopEvidenceSchema} from '@shared/queue-dispatch-validation.js'
import {canonicalRuntimeStopObservation,runtimeStopObservationBodySchema} from '@shared/queue-dispatch-runtime-observation.js'
import {SUPERVISOR_STOP_KEY,sourceBindingSchema} from '@shared/queue-dispatch-sources.js'
import {artifactHash,insertArtifact,lockArtifactAttempt,verifyArtifactProof,type ArtifactAttempt} from './artifacts.js'
import type {DispatchActor} from './ports.js'
import type {DispatchAuth} from './auth.js'
import {withDispatchRetryTransaction,type DispatchStore} from './db.js'
import {lifecycleEvent,canonicalResult,unresolvedPublication,finishStoppedCancellation} from './lifecycle.js'
import {DispatchError} from './errors.js'
const refuse=():never=>{throw new DispatchError('DISPATCH_STATE_CONFLICT')}
/** Original supervisor authentication deliberately does not grant execution rights. */
export async function authenticateHistoricalSupervisor(db:PoolClient,auth:DispatchAuth,actor:DispatchActor,x:ArtifactAttempt){
 await auth.refreshActor(actor,db)
 if(actor.source!=='bearer'||actor.userId!==x.s.owner_user_id||actor.tokenId!==x.scope.supervisor_token_id||actor.tokenId!==x.s.token_id)throw new DispatchError('DISPATCH_FORBIDDEN')
}
/** Validate persisted bytes and their immutable authenticated producer event, not caller prose. */
export async function acceptStopInTransaction(db:PoolClient,x:ArtifactAttempt,evidence:StopEvidence,actor:DispatchActor):Promise<string>{
 const e=stopEvidenceSchema.parse(evidence)
 if(e.kind!=='container_stopped')return refuse()
 const a=(await db.query('SELECT * FROM queue_dispatch_artifacts WHERE id=$1 AND request_id=$2 AND attempt_id=$3 AND key=$4',[e.artifact_id,x.r.id,x.a.id,SUPERVISOR_STOP_KEY])).rows[0]
 if(!a||a.sha256!==e.sha256||a.byte_size!==a.bytes.length||artifactHash(a.bytes)!==e.sha256)return refuse()
 const body=runtimeStopObservationBodySchema.parse(JSON.parse(Buffer.from(a.bytes).toString('utf8'))),b=body.binding
 if(canonicalRuntimeStopObservation(body)!==Buffer.from(a.bytes).toString('utf8')||b.requestId!==x.r.id||b.candidateId!==x.c.id||b.generation!==x.c.generation||b.attemptId!==x.a.id||b.incarnationId!==x.i.id
  ||body.slotId!==x.s.id||body.observer!==`broker:${x.s.id}`||b.scope.bootId!==x.i.boot_id||b.scope.profileSha256!==x.scope.profile_sha256||b.scope.imageDigest!==x.scope.image_digest
  ||e.attempt_id!==x.a.id||e.incarnation_id!==x.i.id||e.scope_id!==b.scope.scopeId||e.profile_sha256!==b.scope.profileSha256||e.observed_at!==body.observedAt)return refuse()
 const events=(await db.query("SELECT * FROM queue_dispatch_events WHERE request_id=$1 AND attempt_id=$2 AND type='artifact_staged' AND payload->>'artifact_id'=$3",[x.r.id,x.a.id,a.id])).rows
 const staged=events[0]
 if(events.length!==1||staged.actor.source!=='supervisor'||staged.actor.user_id!==x.s.owner_user_id||staged.actor.token_id!==x.scope.supervisor_token_id||staged.actor.incarnation_id!==x.i.id||staged.payload.sha256!==e.sha256
  ||canonicalResult(staged.payload.binding)!==canonicalResult({...b,slotId:x.s.id,provenance:x.a.scope_id===null?'unregistered_prepared_scope':'registered_started_scope'}))return refuse()
 const started=(await db.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='started_scope' AND payload->>'attempt_id'=$2",[x.r.id,x.a.id])).rows
 const kind=x.a.scope_id===null?'prepared_created_nonlaunch':'registered_started_scope'
 if(x.a.scope_id===null){if(x.a.started_at||started.length||!x.c.first_claimed_at||Date.parse(body.observedAt)<new Date(x.c.first_claimed_at).getTime()||body.status!=='created'||await unresolvedPublication(db,x.r.id))return refuse()}
 else if(!x.a.started_at||x.a.scope_id!==b.scope.scopeId||started.length!==1||canonicalResult(started[0].payload.scope)!==canonicalResult(b.scope)||Date.parse(body.observedAt)<new Date(x.a.started_at).getTime())return refuse()
 const now=(await db.query<{now:Date}>('SELECT clock_timestamp() now')).rows[0].now.getTime();if(Date.parse(body.observedAt)>now)return refuse()
 const old=(await db.query("SELECT * FROM queue_dispatch_events WHERE request_id=$1 AND attempt_id=$2 AND type='stop_accepted'",[x.r.id,x.a.id])).rows
 if(old.length){if(old.length!==1||old[0].payload.artifact_id!==a.id||old[0].payload.sha256!==e.sha256||canonicalResult(old[0].payload.binding)!==canonicalResult(b))return refuse();return old[0].id}
 const id=await lifecycleEvent(db,x.r.id,'stop_accepted',{kind,artifact_id:a.id,sha256:e.sha256,binding:b,runtime_boot_id:body.runtimeBootId,observed_at:e.observed_at,staging_event_id:staged.id},x.a.id,{...staged.actor,accepted_by:actor.userId})
 await db.query('UPDATE queue_dispatch_attempts SET stopped_at=$2,revoked_at=COALESCE(revoked_at,now()) WHERE id=$1',[x.a.id,e.observed_at]);x.a.stopped_at=new Date(e.observed_at)
 return id
}
/** A CLAIMED attempt whose supervisor refused before any runtime scope existed — typically a
 * pre-scope `DISPATCH_PREPARED_SOURCES_REFUSED`, since source preparation runs before the broker
 * `create`. There is no scope id, no start permit and no broker observation, so no scope-bound
 * stop-evidence shape can describe it; its stop binds to the CLAIM instead (attempt id + the first
 * claim), carrying only a bounded `DISPATCH_*` reason, never raw text. It is admissible ONLY for
 * that exact pre-scope signature: an attempt that created or entered a scope must still use the
 * scoped path (`acceptStopInTransaction`). Writing `stop_accepted` + `stopped_at` lets a subsequent
 * `failed` result reach FAILED through the ordinary completion path (`sources_prepared` was already
 * emitted at selection, so that reconstruction is unchanged). */
export const CLAIM_BOUND_STOP_KIND='claim_bound_unscoped'
/** Reserved control key; kept in sync with the control-key reserve in artifacts.ts. */
export const CLAIM_BOUND_STOP_KEY='__claim_bound_stop'
const BOUNDED_STOP_REASON=/^DISPATCH_[A-Z0-9_]{1,80}$/
export async function acceptClaimBoundStopInTransaction(db:PoolClient,x:ArtifactAttempt,reason:string,observedAt:string,actor:DispatchActor):Promise<string>{
 if(!BOUNDED_STOP_REASON.test(reason)||Number.isNaN(Date.parse(observedAt)))return refuse()
 // Exact pre-scope signature. Anything that reached create/start belongs to the scoped path.
 if(x.a.scope_id!==null||x.a.started_at||x.r.state!=='CLAIMED'||x.a.state!=='CLAIMED'||!x.c.first_claimed_at)return refuse()
 if((await db.query("SELECT 1 FROM queue_dispatch_events WHERE request_id=$1 AND type='started_scope' AND payload->>'attempt_id'=$2",[x.r.id,x.a.id])).rowCount)return refuse()
 if((await db.query('SELECT 1 FROM queue_dispatch_artifacts WHERE request_id=$1 AND attempt_id=$2 AND key=$3',[x.r.id,x.a.id,SUPERVISOR_STOP_KEY])).rowCount)return refuse()
 if(await unresolvedPublication(db,x.r.id))return refuse()
 const now=(await db.query<{now:Date}>('SELECT clock_timestamp() now')).rows[0].now.getTime()
 if(Date.parse(observedAt)<new Date(x.c.first_claimed_at).getTime()||Date.parse(observedAt)>now)return refuse()
 const binding=sourceBindingSchema.parse({requestId:x.r.id,candidateId:x.c.id,generation:x.c.generation,attemptId:x.a.id,incarnationId:x.i.id})
 const body={version:1,purpose:'dispatch-claim-bound-stop',binding,slotId:x.s.id,observer:`supervisor:${x.s.id}`,observedAt,reason}
 const bytes=Buffer.from(canonicalResult(body)),sha256=artifactHash(bytes)
 const old=(await db.query("SELECT * FROM queue_dispatch_events WHERE request_id=$1 AND attempt_id=$2 AND type='stop_accepted'",[x.r.id,x.a.id])).rows
 if(old.length){if(old.length!==1||old[0].payload.kind!==CLAIM_BOUND_STOP_KIND||old[0].payload.sha256!==sha256)return refuse();return old[0].id}
 const staged={source:'supervisor',user_id:actor.userId,token_id:actor.tokenId,incarnation_id:x.i.id}
 const artifactId=await insertArtifact(db,{requestId:x.r.id,attemptId:x.a.id,key:CLAIM_BOUND_STOP_KEY,bytes,sha256,actor:staged,binding})
 const id=await lifecycleEvent(db,x.r.id,'stop_accepted',{kind:CLAIM_BOUND_STOP_KIND,artifact_id:artifactId,sha256,binding,reason,observed_at:observedAt},x.a.id,{...staged,accepted_by:actor.userId})
 await db.query('UPDATE queue_dispatch_attempts SET stopped_at=$2,revoked_at=COALESCE(revoked_at,now()) WHERE id=$1',[x.a.id,observedAt]);x.a.stopped_at=new Date(observedAt)
 return id
}
export function createStopEvidence(deps:{store:DispatchStore;auth:DispatchAuth}){
 async function submitStop(actor:DispatchActor,proof:AttemptProof,evidence:StopEvidence){
  return withDispatchRetryTransaction(deps.store,async db=>{const x=await lockArtifactAttempt(db,proof.attempt_id);verifyArtifactProof(actor,proof,x);await authenticateHistoricalSupervisor(db,deps.auth,actor,x);const id=await acceptStopInTransaction(db,x,evidence,actor);await finishStoppedCancellation(db,x);return {receipt_id:id}})
 }
 /** Same authority as the scoped stop path: the exact supervisor bound to this attempt, proved by
  * its AttemptProof credential and revalidated against the live token binding. A non-claimer is
  * refused by `verifyArtifactProof`; a scoped attempt is refused inside the acceptance. */
 async function submitClaimBoundStop(actor:DispatchActor,proof:AttemptProof,reason:string,observedAt:string){
  return withDispatchRetryTransaction(deps.store,async db=>{const x=await lockArtifactAttempt(db,proof.attempt_id);verifyArtifactProof(actor,proof,x);await authenticateHistoricalSupervisor(db,deps.auth,actor,x);const id=await acceptClaimBoundStopInTransaction(db,x,reason,observedAt,actor);return {receipt_id:id}})
 }
 return {submitStop,submitClaimBoundStop,verifyStopEvidence:async(actor:DispatchActor,proof:AttemptProof,evidence:StopEvidence):Promise<void>=>{await submitStop(actor,proof,evidence)}}
}
