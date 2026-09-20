import type {DispatchStartBinding} from '@shared/queue-dispatch-start-permit.js'
import {validateHistoricalBinding} from './historical-binding.js'
import {lockManagedTaskHierarchy} from './task-status.js'
import {createHash,randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import type {AttemptProof,DispatchInput,DispatchProfileConfig,StopEvidence} from '@shared/queue-dispatch.js'
import {ARTIFACT_MAX_BYTES,ATTEMPT_MAX_BYTES,ATTEMPT_OUTPUT_MAX_BYTES,STOP_EVIDENCE_MAX_BYTES,SUPERVISOR_STOP_KEY} from '@shared/queue-dispatch-sources.js'
import {canonicalRuntimeStopObservation,type RuntimeStopObservation} from '@shared/queue-dispatch-runtime-observation.js'
import type {DispatchActor} from './ports.js'
import type {DispatchAuth} from './auth.js'
import {withDispatchRetryTransaction,type DispatchStore} from './db.js'
import {credentialMatches} from './credentials.js'
import {actorForToken,type IncarnationScope} from './registration.js'
import {DispatchError} from './errors.js'
export const artifactHash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex')
export type ArtifactBytes=Uint8Array|AsyncIterable<Uint8Array>
export async function readBoundedBytes(input:ArtifactBytes,max=ARTIFACT_MAX_BYTES):Promise<Uint8Array>{
 if(input instanceof Uint8Array){if(input.byteLength>max)throw new DispatchError('DISPATCH_TOO_LARGE');return new Uint8Array(input)}
 const chunks:Uint8Array[]=[];let size=0
 try{for await(const chunk of input){if(!(chunk instanceof Uint8Array))throw new DispatchError('DISPATCH_INVALID_INPUT');size+=chunk.byteLength;if(size>max)throw new DispatchError('DISPATCH_TOO_LARGE');chunks.push(new Uint8Array(chunk))}}
 catch(error){if(error instanceof DispatchError)throw error;throw new DispatchError('DISPATCH_TRANSPORT_ERROR')}
 return Buffer.concat(chunks,size)
}
export type ArtifactRequest={id:string;input:DispatchInput;input_hash:string;user_id:string;principal_key:string;auth_source:{source:DispatchActor['source'];token_id:string|null};state:string;generation:number}
export const requestActor=(r:ArtifactRequest):DispatchActor=>({userId:r.user_id,principalKey:r.principal_key,tokenId:r.auth_source.token_id,source:r.auth_source.source,isDemo:false,scopedProducts:[],scopedRepos:[],tokenKind:null})
export type SupervisorStopProvenance='unregistered_prepared_scope'|'registered_started_scope'
const denied=():never=>{throw new DispatchError('DISPATCH_FORBIDDEN')}
export async function lockArtifactAttempt(db:PoolClient,attemptId:string){
 const hint=(await db.query('SELECT c.request_id FROM queue_dispatch_attempts a JOIN queue_dispatch_candidates c ON c.id=a.candidate_id WHERE a.id=$1',[attemptId])).rows[0];if(!hint)return denied()
 const r=(await db.query<ArtifactRequest>('SELECT * FROM queue_dispatch_requests WHERE id=$1 FOR UPDATE',[hint.request_id])).rows[0]
 if(r.input.action==='task_implementation')await lockManagedTaskHierarchy(db,r.input.task_id!)
 const c=(await db.query('SELECT c.* FROM queue_dispatch_candidates c JOIN queue_dispatch_attempts a ON a.candidate_id=c.id WHERE a.id=$1 FOR UPDATE OF c',[attemptId])).rows[0]
 const s=(await db.query('SELECT * FROM queue_dispatch_slots WHERE id=$1 FOR UPDATE',[c.reserved_slot_id])).rows[0]
 if(c.job_id)await db.query('SELECT id FROM claude_jobs WHERE id=$1 FOR UPDATE',[c.job_id])
 const a=(await db.query('SELECT * FROM queue_dispatch_attempts WHERE id=$1 FOR UPDATE',[attemptId])).rows[0]
 const i=(await db.query('SELECT * FROM queue_dispatch_incarnations WHERE id=$1',[a.incarnation_id])).rows[0]
 const p=(await db.query<{config:DispatchProfileConfig;sha256:string;revoked_at:Date|null}>('SELECT * FROM queue_dispatch_profiles WHERE id=$1',[c.profile_revision_id])).rows[0]
 if(!r||!s||!i||!p||i.slot_id!==s.id||c.incarnation_id!==a.incarnation_id)return denied()
 return {r,c,s,a,i,p,scope:i.runtime_scope as IncarnationScope}
}
export type ArtifactAttempt=Awaited<ReturnType<typeof lockArtifactAttempt>>
export async function authorizeArtifactAttempt(db:PoolClient,auth:DispatchAuth,x:ArtifactAttempt){
 const {r,c,s,a,i,p,scope}=x,time=(await db.query<{now:Date}>('SELECT clock_timestamp() now')).rows[0].now.getTime()
 if(r.generation!==c.generation||!['CLAIMED','RUNNING'].includes(r.state)||!['CLAIMED','RUNNING'].includes(c.state)||!['CLAIMED','RUNNING'].includes(a.state)
  ||a.revoked_at||i.signed_off_at||!s.enabled||p.revoked_at||!a.heartbeat_at||time-new Date(a.heartbeat_at).getTime()>=120000
  ||(a.started_at&&time-new Date(a.started_at).getTime()>=p.config.max_duration_seconds*1000)
  ||p.sha256!==scope.profile_sha256||p.config.image_digest!==scope.image_digest||scope.supervisor_token_id!==s.token_id
  ||!scope.profile_revision_ids.includes(c.profile_revision_id))return denied()
 const profile=p.config,repo=r.input.requirements.repository
 if(!profile.actions.includes(r.input.action)||!profile.product_ids.includes(r.input.product_id)||profile.access!==r.input.requirements.access
  ||!profile.publish_modes.includes(r.input.publish)||r.input.requirements.environment_keys.some(k=>!profile.environment_keys.includes(k))
  ||(repo&&!profile.repository_product_ids.includes(repo.product_id))
  ||r.input.review_documents?.items.some(ref=>!profile.product_ids.includes(ref.product_id)||(ref.source==='git'&&!profile.repository_product_ids.includes(ref.product_id))))return denied()
 if(!(await db.query('SELECT 1 FROM queue_dispatch_slot_profiles WHERE slot_id=$1 AND profile_revision_id=$2',[s.id,c.profile_revision_id])).rowCount)return denied()
 await auth.authorizeDispatch(requestActor(r),r.input,'claim',db)
 await auth.authorizeDispatch(actorForToken(s.owner_user_id,s.token_id),r.input,'claim',db)
}
export function verifyArtifactProof(actor:DispatchActor,proof:AttemptProof,x:ArtifactAttempt){
 if(proof.request_id!==x.r.id||proof.candidate_id!==x.c.id||proof.generation!==x.c.generation||proof.attempt_id!==x.a.id||proof.incarnation_id!==x.i.id
  ||actor.source!=='bearer'||actor.userId!==x.s.owner_user_id||actor.tokenId!==x.scope.supervisor_token_id||actor.tokenId!==x.s.token_id||!credentialMatches(proof.credential,x.a.credential_hash))return denied()
}
export const PUBLICATION_RESOLUTION_KEY='__publication_resolution'
/** Caller owns request/attempt lock. Immutable bytes and provenance commit together. */
export async function insertArtifact(db:PoolClient,input:{requestId:string;attemptId:string|null;key:string;bytes:Uint8Array;sha256:string;actor:Record<string,unknown>;binding?:unknown}):Promise<string>{
 const {requestId,attemptId,key,bytes,sha256}=input
 if(bytes.byteLength>ARTIFACT_MAX_BYTES)throw new DispatchError('DISPATCH_TOO_LARGE')
 if(!/^[a-f0-9]{64}$/.test(sha256)||artifactHash(bytes)!==sha256)throw new DispatchError('DISPATCH_INVALID_INPUT')
 const old=(await db.query('SELECT * FROM queue_dispatch_artifacts WHERE request_id=$1 AND attempt_id IS NOT DISTINCT FROM $2::uuid AND key=$3',[requestId,attemptId,key])).rows[0]
 if(old){if(old.sha256!==sha256||old.byte_size!==bytes.byteLength||!Buffer.from(old.bytes).equals(Buffer.from(bytes)))throw new DispatchError('DISPATCH_IDEMPOTENCY_CONFLICT');return old.id}
 const total=(await db.query<{n:string}>('SELECT COALESCE(sum(byte_size),0)::text n FROM queue_dispatch_artifacts WHERE request_id=$1 AND attempt_id IS NOT DISTINCT FROM $2::uuid',[requestId,attemptId])).rows[0].n
 if(Number(total)+bytes.byteLength>ATTEMPT_MAX_BYTES)throw new DispatchError('DISPATCH_TOO_LARGE')
 if(attemptId!==null){
  // One shared control reserve, never an additional allowance per evidence kind.
  const controlKeys=[SUPERVISOR_STOP_KEY,'__operator_recovery',PUBLICATION_RESOLUTION_KEY]
  const control=controlKeys.includes(key)
  const used=(await db.query<{n:string}>('SELECT COALESCE(sum(byte_size),0)::text n FROM queue_dispatch_artifacts WHERE attempt_id=$1 AND (key=ANY($2::text[]))=$3',[attemptId,controlKeys,control])).rows[0].n
  if(Number(used)+bytes.byteLength>(control?STOP_EVIDENCE_MAX_BYTES:ATTEMPT_OUTPUT_MAX_BYTES))throw new DispatchError('DISPATCH_TOO_LARGE')
 }
 const id=randomUUID()
 await db.query('INSERT INTO queue_dispatch_artifacts(id,request_id,attempt_id,key,sha256,bytes,byte_size) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,requestId,attemptId,key,sha256,Buffer.from(bytes),bytes.byteLength])
 await db.query("INSERT INTO queue_dispatch_events(id,request_id,attempt_id,type,actor,payload) VALUES($1,$2,$3,'artifact_staged',$4,$5)",[randomUUID(),requestId,attemptId,input.actor,{artifact_id:id,key,sha256,byte_size:bytes.byteLength,binding:input.binding??null}])
 return id
}
export function createDispatchArtifacts(deps:{store:DispatchStore;auth:DispatchAuth}){
 async function storeAttemptArtifact(actor:DispatchActor,proof:AttemptProof,key:string,input:ArtifactBytes,sha256:string){
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(key))throw new DispatchError('DISPATCH_INVALID_INPUT')
  if(key.startsWith('__'))return denied()
  const bytes=await readBoundedBytes(input)
  return withDispatchRetryTransaction(deps.store,async db=>{const x=await lockArtifactAttempt(db,proof.attempt_id);verifyArtifactProof(actor,proof,x);await deps.auth.refreshActor(actor,db);await authorizeArtifactAttempt(db,deps.auth,x)
   return insertArtifact(db,{requestId:x.r.id,attemptId:x.a.id,key,bytes,sha256,actor:{source:'supervisor_output',user_id:actor.userId,token_id:actor.tokenId,incarnation_id:x.i.id}})})
 }
 /** Post-stop collection is original-supervisor authority, never a child capability. */
 async function stageCollectedArtifact(actor:DispatchActor,binding:DispatchStartBinding,key:'report'|'checks'|'code',input:ArtifactBytes,sha256:string){
  if(!['report','checks','code'].includes(key))return denied()
  const bytes=await readBoundedBytes(input)
  return withDispatchRetryTransaction(deps.store,async db=>{
   const x=await lockArtifactAttempt(db,binding.attemptId);await deps.auth.refreshActor(actor,db)
   if(actor.source!=='bearer'||actor.userId!==x.s.owner_user_id||actor.tokenId!==x.scope.supervisor_token_id||actor.tokenId!==x.s.token_id)return denied()
   await validateHistoricalBinding(db,x,binding)
   if(!x.a.stopped_at||!(await db.query("SELECT 1 FROM queue_dispatch_events WHERE request_id=$1 AND attempt_id=$2 AND type='stop_accepted'",[x.r.id,x.a.id])).rowCount)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   if(key==='code'&&(x.r.input.requirements.access!=='repo_write'||x.r.input.action==='review'))return denied()
   return insertArtifact(db,{requestId:x.r.id,attemptId:x.a.id,key,bytes,sha256,actor:{source:'stopped_supervisor_collector',user_id:actor.userId,token_id:actor.tokenId,incarnation_id:x.i.id},binding})
  })
 }
 async function loadAuthorizedArtifact(actor:DispatchActor,id:string):Promise<Uint8Array>{
  const row=(await deps.store.query('SELECT a.*,r.input,r.user_id FROM queue_dispatch_artifacts a JOIN queue_dispatch_requests r ON r.id=a.request_id WHERE a.id=$1',[id])).rows[0]
  if(!row)throw new DispatchError('DISPATCH_NOT_FOUND')
  await deps.auth.authorizeRequestRead(actor,row.input,row.user_id)
  if(row.attempt_id&&!(await deps.store.query('SELECT 1 FROM queue_dispatch_attempts a JOIN queue_dispatch_candidates c ON c.id=a.candidate_id WHERE a.id=$1 AND c.request_id=$2',[row.attempt_id,row.request_id])).rowCount)return denied()
  if(row.byte_size!==row.bytes.length||artifactHash(row.bytes)!==row.sha256)throw new DispatchError('DISPATCH_STATE_CONFLICT')
  return new Uint8Array(row.bytes)
 }
 /** The bound attempt's read of its own prepared sources, which is what the REST matrix gives it
  * beside the requester and the product administrator. A supervisor holds no requester identity,
  * so without this it could not fetch the very bytes the manifest it just signed names. It reaches
  * request-level prepared sources only: never another request's, and never any attempt output. */
 async function loadBoundSourceArtifact(actor:DispatchActor,proof:AttemptProof,id:string):Promise<Uint8Array>{
  return withDispatchRetryTransaction(deps.store,async db=>{
   const x=await lockArtifactAttempt(db,proof.attempt_id);verifyArtifactProof(actor,proof,x)
   await deps.auth.refreshActor(actor,db);await authorizeArtifactAttempt(db,deps.auth,x)
   const row=(await db.query('SELECT * FROM queue_dispatch_artifacts WHERE id=$1 AND request_id=$2 AND attempt_id IS NULL',[id,x.r.id])).rows[0]
   if(!row)throw new DispatchError('DISPATCH_NOT_FOUND')
   if(row.byte_size!==row.bytes.length||artifactHash(row.bytes)!==row.sha256)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   return new Uint8Array(row.bytes)
  })
 }
 async function stageSupervisorStop(actor:DispatchActor,observation:RuntimeStopObservation):Promise<StopEvidence>{
  const {sha256,...body}=observation,canonical=canonicalRuntimeStopObservation(body)
  if(Buffer.byteLength(canonical)>STOP_EVIDENCE_MAX_BYTES)throw new DispatchError('DISPATCH_TOO_LARGE')
  const bytes=Buffer.from(canonical)
  if(artifactHash(bytes)!==sha256)throw new DispatchError('DISPATCH_INVALID_INPUT')
  const b=body.binding
  return withDispatchRetryTransaction(deps.store,async db=>{
   const x=await lockArtifactAttempt(db,b.attemptId);await deps.auth.refreshActor(actor,db)
   if(actor.source!=='bearer'||actor.tokenId!==x.scope.supervisor_token_id||actor.tokenId!==x.s.token_id||actor.userId!==x.s.owner_user_id
    ||b.requestId!==x.r.id||b.candidateId!==x.c.id||b.generation!==x.c.generation||b.incarnationId!==x.i.id||body.slotId!==x.s.id
    ||b.scope.bootId!==x.i.boot_id||b.scope.imageDigest!==x.scope.image_digest||b.scope.profileSha256!==x.scope.profile_sha256||body.observer!==`broker:${x.s.id}`)return denied()
   if(x.a.scope_id){
    const events=(await db.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='started_scope' AND payload->>'attempt_id'=$2",[x.r.id,x.a.id])).rows
    const known=events[0]?.payload.scope
    if(x.a.scope_id!==b.scope.scopeId||events.length!==1||!known||Object.keys(b.scope).some(k=>known[k]!==b.scope[k as keyof typeof b.scope]))return denied()
   }
   const artifactId=await insertArtifact(db,{requestId:x.r.id,attemptId:x.a.id,key:SUPERVISOR_STOP_KEY,bytes,sha256,actor:{source:'supervisor',user_id:actor.userId,token_id:actor.tokenId,incarnation_id:x.i.id},binding:{...b,slotId:x.s.id,provenance:x.a.scope_id===null?'unregistered_prepared_scope':'registered_started_scope'}})
   return {attempt_id:x.a.id,incarnation_id:x.i.id,scope_id:b.scope.scopeId,profile_sha256:b.scope.profileSha256,observed_at:body.observedAt,kind:'container_stopped',artifact_id:artifactId,sha256}
  })
 }
 async function assertCleanupReceipt(actor:DispatchActor,attemptId:string,receiptId:string):Promise<void>{
  await withDispatchRetryTransaction(deps.store,async db=>{const x=await lockArtifactAttempt(db,attemptId);await deps.auth.refreshActor(actor,db)
   if(actor.source!=='bearer'||actor.userId!==x.s.owner_user_id||actor.tokenId!==x.scope.supervisor_token_id)return denied()
   const result=(await db.query('SELECT result.id FROM queue_dispatch_results result JOIN queue_dispatch_requests request ON request.result_id=result.id WHERE result.id=$1 AND result.request_id=$2 AND result.attempt_id=$3',[receiptId,x.r.id,x.a.id])).rows[0]
   if(!result||!['SUCCEEDED','FAILED','CANCELLED'].includes(x.r.state)||(await db.query("SELECT 1 FROM queue_dispatch_publications WHERE attempt_id=$1 AND state IN ('PREPARED','SENT','UNKNOWN')",[x.a.id])).rowCount||!['SUCCEEDED','FAILED','CANCELLED'].includes(x.a.state)||!x.a.stopped_at||(await db.query('SELECT 1 FROM queue_dispatch_reservations WHERE candidate_id=$1 AND released_at IS NULL',[x.c.id])).rowCount)throw new DispatchError('DISPATCH_STATE_CONFLICT')
  })
 }
 const download=(id:string,bytes:Uint8Array)=>({bytes,headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="dispatch-${id}.bin"`,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'X-Content-SHA256':artifactHash(bytes)}})
 async function downloadArtifact(actor:DispatchActor,id:string){return download(id,await loadAuthorizedArtifact(actor,id))}
 async function downloadBoundSource(actor:DispatchActor,proof:AttemptProof,id:string){return download(id,await loadBoundSourceArtifact(actor,proof,id))}
 return {storeAttemptArtifact,stageCollectedArtifact,loadAuthorizedArtifact,loadBoundSourceArtifact,downloadArtifact,downloadBoundSource,stageSupervisorStop,assertCleanupReceipt}
}
