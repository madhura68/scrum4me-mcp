import {validateHistoricalBinding} from './historical-binding.js'
import type {DispatchStartBinding} from '@shared/queue-dispatch-start-permit.js'
import type {PoolClient} from 'pg'
import type {AttemptProof,DispatchResult} from '@shared/queue-dispatch.js'
import {canonicalDispatchInput,parseDispatchResult} from '@shared/queue-dispatch-validation.js'
import {lockArtifactAttempt,verifyArtifactProof,artifactHash,requestActor,type ArtifactAttempt} from './artifacts.js'
import {createStopEvidence,authenticateHistoricalSupervisor} from './stop-evidence.js'
import {assertReviewSourceReceipts} from './agent-gateway.js'
import {verifyCodeArtifact} from './workspace.js'
import {classifyDiffAgainstPlan} from '../verify/classify.js'
import {checkVerifyGate,type VerifyRequired} from '../verify/gate.js'
import {canonicalResult,lifecycleEvent,finishResult,unresolvedPublication} from './lifecycle.js'
import {projectManagedTaskStatus} from './task-status.js'
import {withDispatchRetryTransaction,type DispatchStore} from './db.js'
import type {DispatchAuth} from './auth.js'
import type {DispatchActor} from './ports.js'
import {DispatchError} from './errors.js'
export function verifyManagedTask(input:{diff:string;planSnapshot:string;verifyOnly:boolean;verifyRequired:VerifyRequired;summary:string}){
 const classification=classifyDiffAgainstPlan({diff:input.diff,plan:input.planSnapshot})
 return {classification,gate:checkVerifyGate(classification.result,input.verifyOnly,input.verifyRequired,input.summary)}
}
/** `result` is the canonical result the service actually holds for this request, which is not
 * always the submitted one: the domain may rewrite the outcome. It is absent only where there
 * is no canonical result yet, as on an unresolved publication. */
export type ResultReceipt={accepted:boolean;resultId:string|null;reason:string;result?:DispatchResult}
export type CompletionDeps={store:DispatchStore;auth:DispatchAuth;publisher?:{publishDispatchArtifact(actor:DispatchActor,proof:AttemptProof,id:string):Promise<{status:'confirmed'|'failed'|'unknown'}>;publishHistoricalArtifact?(actor:DispatchActor,binding:DispatchStartBinding,id:string):Promise<{status:'confirmed'|'failed'|'unknown'}>}}
export {finishResult} from './lifecycle.js'
export function createDispatchCompletion(deps:CompletionDeps){
 const stops=createStopEvidence(deps)
 async function accept(actor:DispatchActor,authority:{proof:AttemptProof}|{binding:DispatchStartBinding},value:DispatchResult):Promise<ResultReceipt>{
  const attemptId='proof' in authority?authority.proof.attempt_id:authority.binding.attemptId
  const verify=async(db:PoolClient,x:ArtifactAttempt)=>{if('proof' in authority)verifyArtifactProof(actor,authority.proof,x);else await validateHistoricalBinding(db,x,authority.binding)}
  const original=parseDispatchResult(value),submittedHash=artifactHash(canonicalResult(original))
  const prepared=await withDispatchRetryTransaction(deps.store,async db=>{
   const x=await lockArtifactAttempt(db,attemptId);await verify(db,x);await authenticateHistoricalSupervisor(db,deps.auth,actor,x)
   const old=(await db.query('SELECT * FROM queue_dispatch_results WHERE request_id=$1',[x.r.id])).rows[0]
   if(old){const event=(await db.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND attempt_id=$2 AND type='result_accepted'",[x.r.id,x.a.id])).rows[0];if(event?.payload.submitted_hash===submittedHash)return {receipt:{accepted:true,resultId:old.id,reason:'replayed',result:old.payload as DispatchResult}}
    await lifecycleEvent(db,x.r.id,'late_result',{submitted_hash:submittedHash,result:original},x.a.id);return {receipt:{accepted:false,resultId:old.id,reason:'terminal_result',result:old.payload as DispatchResult}}}
   if(x.c.generation!==x.r.generation||!x.a.stopped_at)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   if(!(await db.query("SELECT 1 FROM queue_dispatch_events WHERE request_id=$1 AND attempt_id=$2 AND type='stop_accepted'",[x.r.id,x.a.id])).rowCount)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   if(artifactHash(canonicalDispatchInput(x.r.input))!==x.r.input_hash)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   if(x.p.sha256!==x.scope.profile_sha256||x.p.config.image_digest!==x.scope.image_digest)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   const preparedSources=(await db.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='sources_prepared'",[x.r.id])).rows
   if(preparedSources.length!==1)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   for(const source of preparedSources[0].payload.sources){
    const a=(await db.query('SELECT * FROM queue_dispatch_artifacts WHERE id=$1 AND request_id=$2 AND attempt_id IS NULL',[source.artifactId,x.r.id])).rows[0]
    if(!a||a.key!==source.key||a.sha256!==source.sha256||a.byte_size!==source.byteSize||artifactHash(a.bytes)!==source.sha256)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   }
   let result={...original},failure:string|null=null
   if(!x.a.scope_id&&result.outcome==='succeeded')throw new DispatchError('DISPATCH_STATE_CONFLICT')
   if(x.r.state==='CANCEL_REQUESTED')result={...result,outcome:'cancelled'}
   else if(x.r.state==='UNCERTAIN')throw new DispatchError('DISPATCH_STATE_CONFLICT')
   if(result.outcome==='succeeded'){
    if(x.p.revoked_at)failure='profile_revoked'
    try{await deps.auth.authorizeDispatch(requestActor(x.r),x.r.input,'publish',db)}catch(error){if(!(error instanceof DispatchError))throw error;failure='authorization_unavailable'}
    if(x.r.input.review_documents&&x.r.input.action!=='review'){try{await assertReviewSourceReceipts(db,x.r.id,x.a.id,x.r.input.review_documents)}catch{failure='sources_unverified'}}
    if(x.r.input.action==='review'){
     try{if(!result.review)throw Error('review_required');await assertReviewSourceReceipts(db,x.r.id,x.a.id,result.review.documents)}catch{failure='review_sources_unverified'}
    }else if(result.review)throw new DispatchError('DISPATCH_INVALID_INPUT')
   }
   let code:undefined|{bytes:Uint8Array;base:Uint8Array;expected:{repoUrl:string;baseSha:string;headSha:string;branch:string;checks:DispatchResult['checks']};snapshot:Record<string,unknown>}
   if(result.code){
    const a=(await db.query('SELECT * FROM queue_dispatch_artifacts WHERE id=$1 AND attempt_id=$2 AND request_id=$3',[result.code.artifact_id,x.a.id,x.r.id])).rows[0]
    const source=(await db.query("SELECT * FROM queue_dispatch_artifacts WHERE request_id=$1 AND attempt_id IS NULL AND key='__repository_base'",[x.r.id])).rows[0]
    const repo=x.r.input.requirements.repository,registered=repo?(await db.query('SELECT repo_url FROM products WHERE id=$1',[repo.product_id])).rows[0]:null
    if(!a||!source||artifactHash(a.bytes)!==a.sha256||artifactHash(source.bytes)!==source.sha256||!registered?.repo_url||result.code.base_sha!==repo?.base_sha||result.code.branch!==`codex/queue-${x.r.id}`)throw new DispatchError('DISPATCH_INVALID_INPUT')
    code={bytes:a.bytes,base:source.bytes,expected:{repoUrl:registered.repo_url,baseSha:result.code.base_sha,headSha:result.code.head_sha,branch:result.code.branch,checks:result.checks},snapshot:(x.r as unknown as {snapshot:Record<string,unknown>}).snapshot}
   }else if(result.outcome==='succeeded'&&(x.r.input.action==='task_implementation'||x.r.input.requirements.access==='repo_write'))failure='code_artifact_required'
   if(failure)result={...result,outcome:'failed',summary:failure,review:undefined}
   return {result,code,action:x.r.input.action,publish:x.r.input.publish}
  })
  if(prepared.receipt)return prepared.receipt
  let result=prepared.result!,verification:ReturnType<typeof verifyManagedTask>|undefined
  if(prepared.code){
   await verifyCodeArtifact(prepared.code.bytes,prepared.code.base,prepared.code.expected)
   if(prepared.action==='task_implementation'){
    const snapshot=prepared.code.snapshot
    verification=verifyManagedTask({diff:JSON.parse(Buffer.from(prepared.code.bytes).toString('utf8')).diff,planSnapshot:String(snapshot.implementation_plan??''),verifyOnly:snapshot.verify_only===true,verifyRequired:snapshot.verify_required as VerifyRequired,summary:result.summary})
    if(!verification.gate.allowed)result={...result,outcome:'failed',summary:verification.gate.error}
   }
  }
  if(verification){await withDispatchRetryTransaction(deps.store,async db=>{
   const x=await lockArtifactAttempt(db,attemptId);await verify(db,x);await authenticateHistoricalSupervisor(db,deps.auth,actor,x)
   await lifecycleEvent(db,x.r.id,'task_verified',{...verification,artifact_id:result.code!.artifact_id,snapshot:prepared.code!.snapshot},x.a.id)
   if(x.c.job_id)await db.query('UPDATE claude_jobs SET verify_result=$2,verify_reasoning=$3 WHERE id=$1',[x.c.job_id,verification!.classification.result,verification!.classification.reasoning])
  })}
  if(result.outcome==='succeeded'&&result.code&&prepared.publish!=='artifact'){
   if(!deps.publisher)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   const publication='proof' in authority?await deps.publisher.publishDispatchArtifact(actor,authority.proof,result.code.artifact_id):deps.publisher.publishHistoricalArtifact?await deps.publisher.publishHistoricalArtifact(actor,authority.binding,result.code.artifact_id):(()=>{throw new DispatchError('DISPATCH_STATE_CONFLICT')})()
   if(publication.status==='unknown')return {accepted:false,resultId:null,reason:'publication_unknown'}
   if(publication.status==='failed')result={...result,outcome:'failed',summary:'publication_failed'}
  }
  return withDispatchRetryTransaction(deps.store,async db=>{
   const x=await lockArtifactAttempt(db,attemptId);await verify(db,x);await authenticateHistoricalSupervisor(db,deps.auth,actor,x)
   const old=(await db.query('SELECT id,payload FROM queue_dispatch_results WHERE request_id=$1',[x.r.id])).rows[0]
   if(old){const event=(await db.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND attempt_id=$2 AND type='result_accepted'",[x.r.id,x.a.id])).rows[0];if(event?.payload.submitted_hash===submittedHash)return {accepted:true,resultId:old.id,reason:'replayed',result:old.payload as DispatchResult};await lifecycleEvent(db,x.r.id,'late_result',{submitted_hash:submittedHash,result:original},x.a.id);return {accepted:false,resultId:old.id,reason:'terminal_result',result:old.payload as DispatchResult}}
   if(x.r.generation!==x.c.generation||await unresolvedPublication(db,x.r.id))throw new DispatchError('DISPATCH_STATE_CONFLICT')
   if(x.r.state==='CANCEL_REQUESTED'){await lifecycleEvent(db,x.r.id,'late_result',{submitted_hash:submittedHash,result:original},x.a.id);result={...result,outcome:'cancelled'}}
   else if(!['CLAIMED','RUNNING'].includes(x.r.state))throw new DispatchError('DISPATCH_STATE_CONFLICT')
   else if(result.outcome==='succeeded')try{if(x.p.revoked_at)throw new DispatchError('DISPATCH_FORBIDDEN');await deps.auth.authorizeDispatch(requestActor(x.r),x.r.input,'publish',db)}catch(error){if(!(error instanceof DispatchError))throw error;result={...result,outcome:'failed',summary:'authorization_unavailable',review:undefined}}
   return finishResult(db,x,result,submittedHash)
  })
 }
 return {...stops,acceptDispatchResult:(actor:DispatchActor,proof:AttemptProof,value:DispatchResult)=>accept(actor,{proof},value),acceptHistoricalResult:(actor:DispatchActor,binding:DispatchStartBinding,value:DispatchResult)=>accept(actor,{binding},value)}
}
