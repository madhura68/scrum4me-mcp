import {validateHistoricalBinding} from './historical-binding.js'
import {z} from 'zod'
import type {StopEvidence,DispatchResult,DispatchView} from '@shared/queue-dispatch.js'
import {dispatchStartPermitClaimsSchema,type DispatchStartBinding} from '@shared/queue-dispatch-start-permit.js'
import type {DispatchActor} from './ports.js'
import type {DispatchAuth} from './auth.js'
import {lockArtifactAttempt,requestActor,artifactHash,insertArtifact,type ArtifactAttempt} from './artifacts.js'
import {authenticateHistoricalSupervisor,acceptStopInTransaction} from './stop-evidence.js'
import {canonicalResult,lifecycleEvent,transition,terminalizeAttempt,lifecycleView,unresolvedPublication,finishStoppedCancellation} from './lifecycle.js'
import {finishResult,createDispatchCompletion,type CompletionDeps} from './completion.js'
import {withDispatchRetryTransaction,type DispatchStore} from './db.js'
import {DispatchError} from './errors.js'
const bindingSchema=dispatchStartPermitClaimsSchema.omit({version:true,purpose:true,issuedAt:true,expiresAt:true})
const attestationSchema=z.object({version:z.literal(1),binding:bindingSchema,kind:z.enum(['operator_attested','runtime_rebooted']),observedAt:z.string().datetime(),observer:z.string().min(1).max(256),source:z.string().min(1).max(4000),statement:z.string().min(20).max(16000),processesTerminated:z.literal(true),runtimeBootBefore:z.string().min(1).max(256),runtimeBootAfter:z.string().min(1).max(256),rebootedAt:z.string().datetime().optional()}).strict()
export type RecoveryAttestation=z.infer<typeof attestationSchema>
export type RecoveryScopeKey={requestId:string;attemptId:string;incarnationId:string;scope:DispatchStartBinding['scope']}
export type RecoveryState={status:'pending';binding:DispatchStartBinding}|{status:'accepted';binding:DispatchStartBinding;resultId:string;result:DispatchResult}
const conflict=():never=>{throw new DispatchError('DISPATCH_STATE_CONFLICT')}
export function createDispatchRecovery(deps:CompletionDeps){
 async function stageRecoveryEvidence(actor:DispatchActor,value:RecoveryAttestation):Promise<StopEvidence>{
  const attestation=attestationSchema.parse(value),bytes=Buffer.from(canonicalResult(attestation)),sha256=artifactHash(bytes)
  return withDispatchRetryTransaction(deps.store,async db=>{
   const x=await lockArtifactAttempt(db,attestation.binding.attemptId);await deps.auth.authorizeDispatch(actor,x.r.input,'recover',db);await validateHistoricalBinding(db,x,attestation.binding)
   const id=await insertArtifact(db,{requestId:x.r.id,attemptId:x.a.id,key:'__operator_recovery',bytes,sha256,actor:{source:'recovery_operator',user_id:actor.userId,principal_key:actor.principalKey},binding:attestation.binding})
   return {kind:attestation.kind,artifact_id:id,sha256,attempt_id:x.a.id,incarnation_id:x.i.id,scope_id:attestation.binding.scope.scopeId,profile_sha256:attestation.binding.scope.profileSha256,observed_at:attestation.observedAt}
  })
 }
 async function acceptRecoveryStop(db:import('pg').PoolClient,x:ArtifactAttempt,e:StopEvidence,actor:DispatchActor){
  if(e.kind==='container_stopped')return acceptStopInTransaction(db,x,e,actor)
  const a=(await db.query('SELECT * FROM queue_dispatch_artifacts WHERE id=$1 AND request_id=$2 AND attempt_id=$3 AND key=$4',[e.artifact_id,x.r.id,x.a.id,'__operator_recovery'])).rows[0]
  if(!a||artifactHash(a.bytes)!==e.sha256||a.sha256!==e.sha256)return conflict()
  const body=attestationSchema.parse(JSON.parse(Buffer.from(a.bytes).toString('utf8')));await validateHistoricalBinding(db,x,body.binding)
  // A claimed attempt whose supervisor died before start has no registered scope and no start time.
  // No start permit was ever issued for it, so its claim bounds the observation instead; validateHistoricalBinding
  // above already refuses a null scope that carries any start history.
  const unstarted=x.a.scope_id===null,since=unstarted?x.c.first_claimed_at:x.a.started_at
  if(body.kind!==e.kind||body.observedAt!==e.observed_at||e.attempt_id!==x.a.id||e.incarnation_id!==x.i.id||e.scope_id!==(unstarted?body.binding.scope.scopeId:x.a.scope_id)||e.profile_sha256!==x.scope.profile_sha256||!since||Date.parse(body.observedAt)<new Date(since).getTime()||Date.parse(body.observedAt)>Date.now())return conflict()
  if(body.kind==='runtime_rebooted'&&(!body.rebootedAt||body.runtimeBootBefore===body.runtimeBootAfter||Date.parse(body.rebootedAt)<=new Date(since).getTime()||Date.parse(body.rebootedAt)>Date.parse(body.observedAt)))return conflict()
  const staged=(await db.query("SELECT * FROM queue_dispatch_events WHERE request_id=$1 AND attempt_id=$2 AND type='artifact_staged' AND payload->>'artifact_id'=$3 AND actor->>'source'='recovery_operator'",[x.r.id,x.a.id,a.id])).rows
  if(staged.length!==1||staged[0].payload.sha256!==e.sha256||canonicalResult(staged[0].payload.binding)!==canonicalResult(body.binding))return conflict()
  const old=(await db.query("SELECT * FROM queue_dispatch_events WHERE request_id=$1 AND attempt_id=$2 AND type='stop_accepted'",[x.r.id,x.a.id])).rows
  if(old.length){if(old.length!==1||old[0].payload.artifact_id!==a.id)return conflict();return old[0].id}
  const id=await lifecycleEvent(db,x.r.id,'stop_accepted',{kind:e.kind,artifact_id:a.id,sha256:e.sha256,binding:body.binding,runtime_boot_id:body.runtimeBootAfter,observed_at:e.observed_at,staging_event_id:staged[0].id},x.a.id,{service:'dispatch',authorized_by:actor.userId})
  await db.query('UPDATE queue_dispatch_attempts SET stopped_at=$2,revoked_at=COALESCE(revoked_at,now()) WHERE id=$1',[x.a.id,e.observed_at]);x.a.stopped_at=new Date(e.observed_at);return id
 }
 async function recoverDispatch(actor:DispatchActor,id:string,actionId:string,expectedVersion:string,evidence:StopEvidence,mode:'close_failed'|'close_cancelled'|'retry_same_contract'):Promise<DispatchView>{
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(actionId)||!['close_failed','close_cancelled','retry_same_contract'].includes(mode))throw new DispatchError('DISPATCH_INVALID_INPUT')
  return withDispatchRetryTransaction(deps.store,async db=>{
   const x=await lockArtifactAttempt(db,evidence.attempt_id);if(x.r.id!==id)return conflict();await deps.auth.authorizeDispatch(actor,x.r.input,'recover',db)
   const key=`${actor.principalKey}:recovery:${actionId}`,hash=artifactHash(canonicalResult({id,expectedVersion,evidence,mode})),old=(await db.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='recovery_action' AND payload->>'key'=$2",[id,key])).rows[0]
   if(old){if(old.payload.hash!==hash)throw new DispatchError('DISPATCH_IDEMPOTENCY_CONFLICT');return lifecycleView(db,id)}
   const r=x.r as typeof x.r & {version:string;result_id:string|null}
   if(String(r.version)!==expectedVersion||r.generation!==x.c.generation||r.result_id||!['UNCERTAIN','CANCEL_REQUESTED'].includes(r.state)||await unresolvedPublication(db,id))return conflict()
   const stopId=await acceptRecoveryStop(db,x,evidence,actor)
   if(mode==='retry_same_contract'){
    if(r.state!=='UNCERTAIN')return conflict();await deps.auth.authorizeDispatch(requestActor(r),r.input,'claim',db)
    if(x.p.revoked_at||!x.p.config.actions.includes(r.input.action))throw new DispatchError('DISPATCH_FORBIDDEN')
    await terminalizeAttempt(db,x,'FAILED')
    const publications=(await db.query('SELECT id,state,remote_receipt FROM queue_dispatch_publications WHERE request_id=$1 ORDER BY id',[id])).rows
    const stops=(await db.query("SELECT id,attempt_id,payload FROM queue_dispatch_events WHERE request_id=$1 AND type='stop_accepted' ORDER BY id",[id])).rows
    const authorization=await lifecycleEvent(db,id,'retry_authorized',{old_attempt_id:x.a.id,input_hash:r.input_hash,generation:r.generation,stop_receipt_id:stopId,stop_receipts:stops,publications,authorized_by:actor.userId},x.a.id)
    await db.query('UPDATE queue_dispatch_requests SET retry_authorization_event_id=$2 WHERE id=$1',[id,authorization]);await transition(db,id,'WAITING')
   }else{
    const result:DispatchResult={version:1,outcome:mode==='close_cancelled'?'cancelled':'failed',summary:'Execution closed through explicit recovery',report_markdown:'The authorized recovery decision and stop evidence are preserved in the audit.',checks:[]}
    await finishResult(db,x,result,artifactHash(canonicalResult(result)))
   }
   await lifecycleEvent(db,id,'recovery_action',{key,hash,mode},x.a.id,{user_id:actor.userId});return lifecycleView(db,id)
  })
 }
 const completion=createDispatchCompletion(deps)
 function nonLaunchRecovery(actor:DispatchActor){
  async function lookup(key:RecoveryScopeKey):Promise<RecoveryState>{return withDispatchRetryTransaction(deps.store,async db=>{
   const x=await lockArtifactAttempt(db,key.attemptId);await authenticateHistoricalSupervisor(db,deps.auth,actor,x)
   const binding={...key,candidateId:x.c.id,generation:x.c.generation};await validateHistoricalBinding(db,x,binding)
   const result=(await db.query('SELECT result.* FROM queue_dispatch_results result JOIN queue_dispatch_requests r ON r.result_id=result.id WHERE result.request_id=$1 AND result.attempt_id=$2',[x.r.id,x.a.id])).rows[0]
   return result?{status:'accepted',binding,resultId:result.id,result:result.payload}:{status:'pending',binding}
  })}
  async function submitStop(binding:DispatchStartBinding,evidence:StopEvidence){return withDispatchRetryTransaction(deps.store,async db=>{const x=await lockArtifactAttempt(db,binding.attemptId);await authenticateHistoricalSupervisor(db,deps.auth,actor,x);await validateHistoricalBinding(db,x,binding);const id=await acceptStopInTransaction(db,x,evidence,actor);await finishStoppedCancellation(db,x);return {receipt_id:id}})}
  async function submitResult(binding:DispatchStartBinding,result:DispatchResult):Promise<RecoveryState>{
   await completion.acceptHistoricalResult(actor,binding,result)
   return lookup(binding)
  }
  return {lookup,submitStop,submitResult}
 }
 return {recoverDispatch,stageRecoveryEvidence,nonLaunchRecovery}
}
