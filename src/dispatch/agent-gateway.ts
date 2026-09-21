import {randomUUID} from 'node:crypto'
import type {DispatchInput} from '@shared/queue-dispatch.js'
import type {DispatchAuth} from './auth.js'
import {withDispatchRetryTransaction,type DispatchStore} from './db.js'
import {DispatchError} from './errors.js'
import {createAgentOutputCapabilities,type AgentOutputOperation} from './agent-output-capability.js'
import {lockArtifactAttempt,authorizeArtifactAttempt,insertArtifact,readBoundedBytes,artifactHash,type ArtifactBytes,type ArtifactAttempt} from './artifacts.js'
/** Capability verification is followed by fresh DB authority on every call. The
 * child receives no supervisor proof, general bearer, path or arbitrary tool name. */
export function createAgentGateway(deps:{store:DispatchStore;auth:DispatchAuth;capabilities:ReturnType<typeof createAgentOutputCapabilities>}){
 async function authority(token:string,operation:AgentOutputOperation,x:ArtifactAttempt){
  const binding={request_id:x.r.id,candidate_id:x.c.id,generation:x.c.generation,attempt_id:x.a.id,incarnation_id:x.i.id,input_sha256:x.r.input_hash,profile_sha256:x.p.sha256}
  deps.capabilities.verify(token,binding,operation,Date.now())
 }
 async function readSource(token:string,attemptId:string,key:string):Promise<Uint8Array>{
  return withDispatchRetryTransaction(deps.store,async db=>{
   const x=await lockArtifactAttempt(db,attemptId);await authority(token,'read_source',x);await authorizeArtifactAttempt(db,deps.auth,x)
   if(!x.r.input.review_documents?.items.some(ref=>ref.key===key))throw new DispatchError('DISPATCH_FORBIDDEN')
   const row=(await db.query('SELECT id,sha256,bytes,byte_size FROM queue_dispatch_artifacts WHERE request_id=$1 AND attempt_id IS NULL AND key=$2',[x.r.id,key])).rows[0]
   if(!row||artifactHash(row.bytes)!==row.sha256||row.byte_size!==row.bytes.length)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   const ref=x.r.input.review_documents.items.find(ref=>ref.key===key)!
   if(ref.sha256!==row.sha256)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   await db.query("INSERT INTO queue_dispatch_events(id,request_id,attempt_id,type,actor,payload,operation_key) VALUES($1,$2,$3,'source_read',$4,$5,$6) ON CONFLICT(operation_key) DO NOTHING",[randomUUID(),x.r.id,x.a.id,{source:'agent_gateway',incarnation_id:x.i.id},{key,artifact_id:row.id,sha256:row.sha256},`source-read:${x.a.id}:${key}`])
   return new Uint8Array(row.bytes)
  })
 }
 async function stage(token:string,attemptId:string,operation:Exclude<AgentOutputOperation,'read_source'>,input:ArtifactBytes,sha256:string):Promise<string>{
  const key={stage_report:'report',stage_checks:'checks',stage_code:'code'}[operation]
  if(!key)throw new DispatchError('DISPATCH_FORBIDDEN')
  const bytes=await readBoundedBytes(input)
  return withDispatchRetryTransaction(deps.store,async db=>{
   const x=await lockArtifactAttempt(db,attemptId);await authority(token,operation,x);await authorizeArtifactAttempt(db,deps.auth,x)
   if(operation==='stage_code'&&(x.r.input.requirements.access!=='repo_write'||x.r.input.action==='review'))throw new DispatchError('DISPATCH_FORBIDDEN')
   return insertArtifact(db,{requestId:x.r.id,attemptId:x.a.id,key,bytes,sha256,actor:{source:'agent_gateway',incarnation_id:x.i.id}})
  })
 }
 return {readSource,stage}
}
/** IP09 calls inside its already locked completion transaction. Reads prove
 * delivered source provenance only, never the model's internal reasoning. */
export async function assertReviewSourceReceipts(db:import('pg').PoolClient,requestId:string,attemptId:string,documents:DispatchInput['review_documents']):Promise<void>{
 const r=(await db.query<{input:DispatchInput}>('SELECT input FROM queue_dispatch_requests WHERE id=$1',[requestId])).rows[0]
 if(!r||!r.input.review_documents||JSON.stringify(canonical(r.input.review_documents))!==JSON.stringify(canonical(documents)))throw new DispatchError('DISPATCH_INVALID_INPUT')
 for(const ref of r.input.review_documents.items){
  const receipt=await db.query(`SELECT 1 FROM queue_dispatch_events e JOIN queue_dispatch_artifacts a ON a.id::text=e.payload->>'artifact_id'
   WHERE e.request_id=$1 AND e.attempt_id=$2 AND e.type='source_read' AND e.actor->>'source'='agent_gateway'
   AND e.payload->>'key'=$3 AND e.payload->>'sha256'=$4 AND a.request_id=$1 AND a.attempt_id IS NULL AND a.key=$3 AND a.sha256=$4`,[requestId,attemptId,ref.key,ref.sha256])
  if(!receipt.rowCount)throw new DispatchError('DISPATCH_STATE_CONFLICT')
 }
}
function canonical(x:unknown):unknown{if(Array.isArray(x))return x.map(canonical);if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));return x}
