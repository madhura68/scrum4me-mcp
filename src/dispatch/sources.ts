import {assertRetryAuthorization} from './retry-authorization.js'
import {randomUUID,sign,type KeyObject} from 'node:crypto'
import type {DispatchInput,DispatchResult} from '@shared/queue-dispatch.js'
import {canonicalDispatchInput} from '@shared/queue-dispatch-validation.js'
import {decideDispatchTransition} from '@shared/queue-dispatch-state.js'
import {readPinnedDocument,type DocumentSourcePorts,type DocumentFailureReason,type RevisionRecord} from '@shared/queue-document-reader.js'
import {MARKDOWN_PREVIEW_MAX_BYTES} from '@shared/markdown-profile.js'
import {REPOSITORY_SOURCE_KEY,canonicalPreparedSourcesManifest,type SourceArtifact,type SignedPreparedSourcesManifest} from '@shared/queue-dispatch-sources.js'
import type {DispatchActor} from './ports.js'
import type {DispatchAuth} from './auth.js'
import {withDispatchRetryTransaction,type DispatchStore} from './db.js'
import {DispatchError} from './errors.js'
import {artifactHash,insertArtifact,requestActor,lockArtifactAttempt,authorizeArtifactAttempt,verifyArtifactProof,readBoundedBytes,type ArtifactRequest} from './artifacts.js'
import type {AttemptProof} from '@shared/queue-dispatch.js'
export class DispatchSourceError extends Error{constructor(readonly reason:DocumentFailureReason){super('DISPATCH_SOURCE_'+reason.toUpperCase().replaceAll('-','_'))}}
type Prepared={key:string;sha256:string;byteSize:number;bytes:Uint8Array}
type SourceRequest=ArtifactRequest&{first_claimed_at:Date|null;sources_ready_at:Date|null;snapshot:Record<string,unknown>;root_message_id:string;reply_message_id:string}
export function createDocumentSourcePorts(store:DispatchStore,fetchGit:DocumentSourcePorts['fetchGit']):DocumentSourcePorts{
 return {sha256:async bytes=>artifactHash(bytes),loadProduct:async id=>(await store.query('SELECT repo_url FROM products WHERE id=$1',[id])).rows[0]??null,
  loadRevision:async(productId,docId,revisionId)=>(await store.query<RevisionRecord>(`SELECT r.title,r.revision,octet_length(r.content_md) byte_size,CASE WHEN octet_length(r.content_md)<=1048576 THEN r.content_md ELSE NULL END content_md FROM product_doc_revisions r JOIN product_docs d ON d.id=r.doc_id WHERE r.id=$1 AND r.doc_id=$2 AND d.product_id=$3`,[revisionId,docId,productId])).rows[0]??null,fetchGit}
}
/** Registered repo only; caller cannot specify a URL. Redirects never forward the token. */
export function createPinnedGitFetcher(config:{host:string;token?:string;fetch?:typeof fetch}):DocumentSourcePorts['fetchGit']{
 return async(repoUrl,path,commit)=>{
  let repo:URL
  try{repo=new URL(repoUrl);if(repo.protocol!=='https:'||repo.hostname!==config.host||repo.port||repo.username||repo.password||repo.search||repo.hash||!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repo.pathname)||!/^[a-f0-9]{40}$/.test(commit)||path.startsWith('/')||path.split('/').some(x=>!x||x==='.'||x==='..')||/[\\\x00-\x1f\x7f]/.test(path)||!/\.md$/i.test(path))throw Error()}catch{return {ok:false,reason:'invalid-reference'}}
  if(!config.token)return {ok:false,reason:'not-configured'}
  const url=new URL(`/api/v1/repos${repo.pathname.replace(/\.git$/,'')}/raw/${path.split('/').map(encodeURIComponent).join('/')}`,repo.origin);url.searchParams.set('ref',commit)
  try{
   const response=await (config.fetch??fetch)(url,{headers:{Authorization:`token ${config.token}`},redirect:'manual',signal:AbortSignal.timeout(8000)})
   if(response.status===404)return {ok:false,reason:'missing'}
   if([401,403].includes(response.status))return {ok:false,reason:'forbidden'}
   if(response.status!==200||!response.body)return {ok:false,reason:'network'}
   const reader=response.body.getReader()
   async function* chunks(){try{while(true){const x=await reader.read();if(x.done)return;yield x.value}}finally{await reader.cancel().catch(()=>{})}}
   return {ok:true,bytes:await readBoundedBytes(chunks(),MARKDOWN_PREVIEW_MAX_BYTES)}
  }catch(error){return {ok:false,reason:error instanceof DispatchError&&error.code==='DISPATCH_TOO_LARGE'?'too-large':error instanceof Error&&['AbortError','TimeoutError'].includes(error.name)?'timeout':'network'}}
 }
}
export function createDispatchSources(deps:{store:DispatchStore;auth:DispatchAuth;fetchGit:DocumentSourcePorts['fetchGit'];prepareRepository?:(input:DispatchInput,requestId:string,snapshot:Record<string,unknown>)=>Promise<{bytes:Uint8Array;repoUrl:string;baseSha:string}>}){
 const ports=createDocumentSourcePorts(deps.store,deps.fetchGit)
 async function loadPinnedSourceBytes(actor:DispatchActor,input:DispatchInput):Promise<Prepared[]>{
  await deps.auth.authorizeDispatch(actor,input,'claim')
  const sources:Prepared[]=[]
  for(const ref of input.review_documents?.items??[]){
   if(ref.key.startsWith('__'))throw new DispatchSourceError('invalid-reference')
   const result=await readPinnedDocument(ref,ports);if(!result.ok)throw new DispatchSourceError(result.reason)
   const bytes=new TextEncoder().encode(result.content)
   sources.push({key:ref.key,sha256:result.sha256,byteSize:bytes.byteLength,bytes})
  }
  return sources
 }
 /** R24: a server-internal request envelope; only committed IDs leave this API. */
 async function readDispatchSources(actor:DispatchActor,envelope:{requestId:string;input:DispatchInput}):Promise<SourceArtifact[]>{
  const r=(await deps.store.query<SourceRequest>('SELECT * FROM queue_dispatch_requests WHERE id=$1',[envelope.requestId])).rows[0]
  if(!r||r.user_id!==actor.userId||r.principal_key!==actor.principalKey||r.input_hash!==artifactHash(canonicalDispatchInput(envelope.input)))throw new DispatchError('DISPATCH_FORBIDDEN')
  await deps.auth.authorizeDispatch(actor,r.input,'claim')
  await prepareRequestSources(r.id)
  await deps.auth.authorizeDispatch(actor,r.input,'claim')
  const ready=(await deps.store.query('SELECT sources_ready_at FROM queue_dispatch_requests WHERE id=$1',[r.id])).rows[0]
  if(!ready?.sources_ready_at)throw new DispatchError('DISPATCH_STATE_CONFLICT')
  return (await deps.store.query<SourceArtifact>('SELECT key,id AS "artifactId",sha256,byte_size AS "byteSize" FROM queue_dispatch_artifacts WHERE request_id=$1 AND attempt_id IS NULL ORDER BY key',[r.id])).rows
 }
 async function prepareRequestSources(requestId:string):Promise<void>{
  const r=(await deps.store.query<SourceRequest>('SELECT * FROM queue_dispatch_requests WHERE id=$1',[requestId])).rows[0]
  if(!r||!['WAITING','RESERVED'].includes(r.state)||r.first_claimed_at)return
  const actor=requestActor(r)
  // Recheck ready requests too: permanent authorization loss must not resume later.
  try{await deps.auth.authorizeDispatch(actor,r.input,'claim')}catch(error){if(error instanceof DispatchError){await rejectUnstarted(requestId,'authorization_unavailable');return}throw error}
  if(r.sources_ready_at)return
  const retries=(await deps.store.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='source_retry' ORDER BY created_at DESC,id DESC LIMIT 1",[requestId])).rows[0]?.payload
  if(retries&&(retries.attempt>=3||Date.parse(retries.next_attempt_at)>Date.now()))return
  let prepared:Prepared[],repo:{bytes:Uint8Array;repoUrl:string;baseSha:string}|undefined
  try{
   prepared=await loadPinnedSourceBytes(actor,r.input)
   if(r.input.requirements.repository){if(!deps.prepareRepository)throw new DispatchSourceError('not-configured');repo=await deps.prepareRepository(r.input,r.id,r.snapshot);prepared.push({key:REPOSITORY_SOURCE_KEY,sha256:artifactHash(repo.bytes),byteSize:repo.bytes.byteLength,bytes:repo.bytes})}
  }catch(error){
   if(error instanceof DispatchSourceError&&['network','timeout','unavailable'].includes(error.reason)){
    await withDispatchRetryTransaction(deps.store,async db=>{const current=(await db.query<SourceRequest>('SELECT * FROM queue_dispatch_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];if(!current||current.sources_ready_at||current.first_claimed_at||current.state!=='WAITING')return
     const attempt=(retries?.attempt??0)+1,reason=attempt>=3?'source_retry_exhausted':`source_${error.reason}`,payload={attempt,reason,next_attempt_at:new Date(Date.now()+Math.min(60000,5000*2**attempt)).toISOString()}
     for(const type of ['source_retry','waiting_reason'])await db.query('INSERT INTO queue_dispatch_events(id,request_id,type,actor,payload) VALUES($1,$2,$3,$4,$5)',[randomUUID(),requestId,type,{service:'dispatch'},payload])
    });return
   }
   if(error instanceof DispatchSourceError||error instanceof DispatchError){await rejectUnstarted(requestId,error instanceof DispatchSourceError?`source_${error.reason}`:'authorization_unavailable');return}throw error
  }
  await withDispatchRetryTransaction(deps.store,async db=>{
   const current=(await db.query<SourceRequest>('SELECT * FROM queue_dispatch_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0]
   if(!current||current.sources_ready_at||current.first_claimed_at||!['WAITING','RESERVED'].includes(current.state))return
   await deps.auth.authorizeDispatch(actor,current.input,'claim',db)
   if(repo){const registered=(await db.query('SELECT repo_url FROM products WHERE id=$1',[r.input.requirements.repository!.product_id])).rows[0];if(!registered||registered.repo_url!==repo.repoUrl||repo.baseSha!==r.input.requirements.repository!.base_sha)throw new DispatchError('DISPATCH_FORBIDDEN')}
   const refs=[]
   for(const source of prepared){const id=await insertArtifact(db,{requestId,attemptId:null,key:source.key,bytes:source.bytes,sha256:source.sha256,actor:{source:'source_service'}});refs.push({key:source.key,artifactId:id,sha256:source.sha256,byteSize:source.byteSize})}
   await db.query("INSERT INTO queue_dispatch_events(id,request_id,type,actor,payload) VALUES($1,$2,'sources_prepared',$3,$4)",[randomUUID(),requestId,{service:'dispatch'},{documents:current.input.review_documents??null,sources:refs,repository:repo?{productId:r.input.requirements.repository!.product_id,repoUrl:repo.repoUrl,baseSha:repo.baseSha,artifactId:refs.find(x=>x.key===REPOSITORY_SOURCE_KEY)!.artifactId}:null}])
   await db.query('UPDATE queue_dispatch_requests SET sources_ready_at=now(),updated_at=now() WHERE id=$1',[requestId])
  }).catch(async error=>{if(error instanceof DispatchError&&['DISPATCH_FORBIDDEN','DISPATCH_UNAUTHENTICATED'].includes(error.code)){await rejectUnstarted(requestId,'authorization_unavailable');return}throw error})
 }
 const rejectUnstarted=(requestId:string,reason:string)=>withDispatchRetryTransaction(deps.store,db=>rejectUnstartedInTransaction(db,requestId,reason))
 async function preparedManifest(actor:DispatchActor,proof:AttemptProof,key:KeyObject):Promise<SignedPreparedSourcesManifest>{
  if(key.type!=='private'||key.asymmetricKeyType!=='ed25519')throw new DispatchError('DISPATCH_INVALID_INPUT')
  return withDispatchRetryTransaction(deps.store,async db=>{const x=await lockArtifactAttempt(db,proof.attempt_id);verifyArtifactProof(actor,proof,x);await authorizeArtifactAttempt(db,deps.auth,x)
   const prepared=(await db.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='sources_prepared'",[x.r.id])).rows
   if(prepared.length!==1)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   const manifest=canonicalPreparedSourcesManifest({version:1,purpose:'dispatch-prepared-sources',binding:{requestId:x.r.id,candidateId:x.c.id,generation:x.c.generation,attemptId:x.a.id,incarnationId:x.i.id},inputSha256:x.r.input_hash,profileSha256:x.p.sha256,...prepared[0].payload})
   return {manifest,signature:sign(null,Buffer.from(manifest),key).toString('base64url')}
  })
 }
 return {readDispatchSources,prepareRequestSources,rejectUnstarted,preparedManifest}
}

/** Shared pre-claim failure producer, DB-only and safe under the request lock. */
export async function rejectUnstartedInTransaction(db:import('pg').PoolClient,requestId:string,reason:string):Promise<void>{
   const r=(await db.query<SourceRequest>('SELECT * FROM queue_dispatch_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0]
   if(!r||!['WAITING','RESERVED'].includes(r.state))return
   if(r.first_claimed_at)await assertRetryAuthorization(db,r as typeof r & {retry_authorization_event_id:string|null;generation:number})
   if(r.input.task_id)await db.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[r.input.task_id])
   const c=(await db.query("SELECT * FROM queue_dispatch_candidates WHERE request_id=$1 AND generation=$2 AND state NOT IN ('FINISHED','RETIRED') FOR UPDATE",[r.id,r.generation])).rows[0]
   if(c){if(c.first_claimed_at)return;await db.query('SELECT id FROM queue_dispatch_slots WHERE id=$1 FOR UPDATE',[c.reserved_slot_id]);if(c.job_id){const j=(await db.query('SELECT * FROM claude_jobs WHERE id=$1 FOR UPDATE',[c.job_id])).rows[0];if(j?.status!=='QUEUED'||j.claimed_at)return;await db.query("UPDATE claude_jobs SET status='CANCELLED',finished_at=now(),updated_at=now() WHERE id=$1",[c.job_id])}
    await db.query("UPDATE queue_dispatch_candidates SET state='RETIRED' WHERE id=$1",[c.id]);await db.query('UPDATE queue_dispatch_reservations SET released_at=now() WHERE candidate_id=$1 AND released_at IS NULL',[c.id])}
   const next=decideDispatchTransition(r.state as 'WAITING'|'RESERVED','reject_unstarted'),id=randomUUID(),payload:DispatchResult={version:1,outcome:'failed',summary:reason,report_markdown:`Execution could not start: ${reason}.`,checks:[]}
   await db.query("INSERT INTO queue_dispatch_results(id,request_id,outcome,payload,source_refs,sha256) VALUES($1,$2,'FAILED',$3,$4,$5)",[id,r.id,payload,r.input.review_documents??{},artifactHash(JSON.stringify(payload))])
   const version=(await db.query('UPDATE queue_dispatch_requests SET state=$2,result_id=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING version::text',[r.id,next,id])).rows[0].version
   if(r.input.action==='task_implementation'&&r.first_claimed_at)await db.query('UPDATE tasks SET dispatch_request_id=NULL WHERE id=$1 AND dispatch_request_id=$2',[r.input.task_id,r.id])
   await db.query("INSERT INTO queue_dispatch_events(id,request_id,type,actor,payload) VALUES($1,$2,'reject_unstarted',$3,$4)",[randomUUID(),r.id,{service:'dispatch'},{reason,result_id:id}])
   await db.query('INSERT INTO queue_dispatch_outbox(id,request_id,version,payload) VALUES($1,$2,$3,$4)',[randomUUID(),r.id,version,{version,request_id:r.id,root_message_id:r.root_message_id,reply_message_id:r.reply_message_id,state:next,result_id:id}])

}
