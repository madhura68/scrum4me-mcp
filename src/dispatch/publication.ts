import type {PoolClient} from 'pg'
import {validateHistoricalBinding} from './historical-binding.js'
import type {DispatchStartBinding} from '@shared/queue-dispatch-start-permit.js'
import {randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import type {AttemptProof,DispatchResult} from '@shared/queue-dispatch.js'
import type {DispatchActor} from './ports.js'
import type {DispatchAuth} from './auth.js'
import {z} from 'zod'
import {lockArtifactAttempt,verifyArtifactProof,requestActor,artifactHash,insertArtifact,PUBLICATION_RESOLUTION_KEY} from './artifacts.js'
import {canonicalResult,lifecycleEvent} from './lifecycle.js'
import {authenticateHistoricalSupervisor} from './stop-evidence.js'
import {withDispatchRetryClientTransaction,type DispatchStore} from './db.js'
import {isolatedGit,importBaseBundle,verifyCodeArtifact} from './workspace.js'
import {DispatchError} from './errors.js'
/** What an operator saw on the remote. It can only ever close an operation as failed: a remote that
 * carries our head is a confirmation, and finding that is reconciliation's job, never an attestation's. */
const resolutionSchema=z.object({version:z.literal(1),operationId:z.string().uuid(),observer:z.string().min(1).max(256),source:z.string().min(1).max(4000),statement:z.string().min(20).max(16000),observedAt:z.string().datetime(),remoteHead:z.string().regex(/^[a-f0-9]{40}$/).nullable(),pullRequest:z.enum(['not_applicable','none_found'])}).strict()
export type PublicationResolution=z.infer<typeof resolutionSchema>
export type PublicationReceipt={operationId:string;status:'confirmed'|'failed'|'unknown';branch:string;headSha:string;prUrl:string|null}
export type PublicationIntent={operationId:string;requestId:string;attemptId:string;repoUrl:string;baseBranch:string;baseSha:string;headSha:string;branch:string;mode:'branch'|'pull_request';expectedRemoteHead:string|null;codeBytes:Uint8Array;baseBytes:Uint8Array;checks:DispatchResult['checks']}
export interface GuardedPublicationPort{publish(input:PublicationIntent):Promise<PublicationReceipt>;reconcile(input:PublicationIntent):Promise<PublicationReceipt>}
const receipt=(x:PublicationIntent,status:PublicationReceipt['status'],prUrl:string|null=null):PublicationReceipt=>({operationId:x.operationId,status,branch:x.branch,headSha:x.headSha,prUrl})
/** All credentials remain in this central adapter; children only stage bounded artifacts. */
export function createGitPublicationPort(config:{root:string;allowedProtocols:readonly string[];allowedHosts:readonly string[];gitAuthHeader?:(url:string)=>Promise<string|null>;forgejo?:{apiOrigin:string;token:string;fetch?:typeof fetch}}):GuardedPublicationPort{
 async function run(x:PublicationIntent,send:boolean):Promise<PublicationReceipt>{
  if(x.branch!==`codex/queue-${x.requestId}`||x.baseBranch===x.branch||!/^[-A-Za-z0-9_./]+$/.test(x.baseBranch)||x.baseBranch.startsWith('-'))throw new DispatchError('DISPATCH_INVALID_INPUT')
  const url=x.repoUrl.startsWith('/')?new URL('file://'+x.repoUrl):new URL(x.repoUrl),protocol=url.protocol.slice(0,-1)
  if(!config.allowedProtocols.includes(protocol)||(protocol!=='file'&&!config.allowedHosts.includes(url.hostname)))throw new DispatchError('DISPATCH_FORBIDDEN')
  // Verification uses git, tmp space and a timeout; a failure here is a receipt, never an escape from the publisher.
  try{await verifyCodeArtifact(x.codeBytes,x.baseBytes,{repoUrl:x.repoUrl,baseSha:x.baseSha,headSha:x.headSha,branch:x.branch,checks:x.checks})}
  catch{return receipt(x,send?'failed':'unknown')}
  // Verified empty Task is a real no-op; no network or PR side effect.
  if(x.baseSha===x.headSha)return receipt(x,'confirmed')
  await mkdir(config.root,{recursive:true,mode:0o700});const root=await mkdtemp(join(config.root,'publication-')),repo=join(root,'repo'),base=join(root,'base.bundle'),code=join(root,'code.bundle')
  let sent=false
  try{
   await mkdir(repo);await writeFile(base,x.baseBytes);await writeFile(code,Buffer.from(JSON.parse(Buffer.from(x.codeBytes).toString('utf8')).bundle,'base64'))
   await importBaseBundle(repo,base,x.baseSha,x.repoUrl,x.branch)
   await isolatedGit(repo,['fetch','--no-tags','--no-recurse-submodules',code,'HEAD'],'file');await isolatedGit(repo,['checkout','--detach',x.headSha])
   const header=await config.gitAuthHeader?.(x.repoUrl),auth=header?{repoUrl:x.repoUrl,header}:undefined
   const remote=await isolatedGit(repo,['ls-remote','--refs','origin',`refs/heads/${x.branch}`],protocol,auth),remoteHead=remote?remote.split(/\s/)[0]:null
   if(remoteHead!==x.headSha){
    if(!send)return receipt(x,'unknown')
    if(remoteHead!==x.expectedRemoteHead)return receipt(x,'failed')
    if(remoteHead){await isolatedGit(repo,['fetch','--no-tags','--no-recurse-submodules','origin',`refs/heads/${x.branch}`],protocol,auth);await isolatedGit(repo,['merge-base','--is-ancestor',remoteHead,x.headSha])}
    sent=true
    await isolatedGit(repo,['push',`--force-with-lease=refs/heads/${x.branch}:${x.expectedRemoteHead??''}`,'origin',`${x.headSha}:refs/heads/${x.branch}`],protocol,auth)
   }
   if(x.mode==='branch')return receipt(x,'confirmed')
   if(!config.forgejo)return receipt(x,'unknown')
   const f=config.forgejo,fetcher=f.fetch??fetch,repoPath=url.pathname.replace(/^\//,'').replace(/\.git$/,''),parts=repoPath.split('/')
   if(parts.length!==2)return receipt(x,'unknown')
   const endpoint=`${f.apiOrigin}/repos/${parts.map(encodeURIComponent).join('/')}/pulls`,marker=`<!-- queue-dispatch:${x.requestId} -->`,headers={Authorization:`token ${f.token}`,'Content-Type':'application/json'}
   // Pagination is bounded and failure to exhaust never authorizes another create.
   let exhausted=false
   for(let page=1;page<=20;page++){
    const response=await fetcher(`${endpoint}?state=all&limit=50&page=${page}`,{headers});if(!response.ok)return receipt(x,'unknown')
    const rows=await response.json() as Array<{head?:{ref:string;sha:string};base?:{ref:string};body?:string;html_url?:string}>
    const matches=rows.filter(p=>p.head?.ref===x.branch&&p.base?.ref===x.baseBranch&&p.body?.includes(marker))
    if(matches.length===1&&matches[0].head?.sha===x.headSha&&matches[0].html_url)return receipt(x,'confirmed',matches[0].html_url)
    if(matches.length)return receipt(x,'unknown')
    if(rows.length<50){exhausted=true;break}
   }
   if(!send||!exhausted)return receipt(x,'unknown')
   sent=true
   const created=await fetcher(endpoint,{method:'POST',headers,body:JSON.stringify({head:x.branch,base:x.baseBranch,title:`WIP: Dispatch ${x.requestId}`,body:marker})})
   if(!created.ok)return receipt(x,'unknown')
   const pr=await created.json() as {html_url?:string;head?:{sha:string}}
   return pr.html_url&&pr.head?.sha===x.headSha?receipt(x,'confirmed',pr.html_url):receipt(x,'unknown')
  }catch{return receipt(x,sent?'unknown':send?'failed':'unknown')}
  finally{await rm(root,{recursive:true,force:true})}
 }
 return {publish:x=>run(x,true),reconcile:x=>run(x,false)}
}
export function createDispatchPublication(deps:{store:DispatchStore;auth:DispatchAuth;port:GuardedPublicationPort;loadBaseBranch:(productId:string,db:PoolClient)=>Promise<string>}){
 async function authorizeSend(db:import('pg').PoolClient,actor:DispatchActor,x:Awaited<ReturnType<typeof lockArtifactAttempt>>){
  await authenticateHistoricalSupervisor(db,deps.auth,actor,x)
  await deps.auth.authorizeDispatch(actor,x.r.input,'publish',db)
  await deps.auth.authorizeDispatch(requestActor(x.r),x.r.input,'publish',db)
  if(x.p.revoked_at||!x.s.enabled||x.p.sha256!==x.scope.profile_sha256||x.p.config.image_digest!==x.scope.image_digest
   ||!(await db.query('SELECT 1 FROM queue_dispatch_slot_profiles WHERE slot_id=$1 AND profile_revision_id=$2',[x.s.id,x.c.profile_revision_id])).rowCount)throw new DispatchError('DISPATCH_FORBIDDEN')
 }
 async function intent(db:PoolClient,operationId:string):Promise<PublicationIntent>{
  const row=(await db.query('SELECT p.*,r.input,e.payload FROM queue_dispatch_publications p JOIN queue_dispatch_requests r ON r.id=p.request_id JOIN queue_dispatch_events e ON e.request_id=p.request_id AND e.type=$2 AND e.payload->>\'operation_id\'=p.id::text WHERE p.id=$1',[operationId,'publication_prepared'])).rows[0]
  if(!row)throw new DispatchError('DISPATCH_STATE_CONFLICT')
  const artifacts=(await db.query('SELECT * FROM queue_dispatch_artifacts WHERE id=ANY($1::uuid[])',[[row.payload.artifact_id,row.payload.base_artifact_id]])).rows
  const code=artifacts.find(a=>a.id===row.payload.artifact_id),base=artifacts.find(a=>a.id===row.payload.base_artifact_id)
  if(!code||!base||artifactHash(code.bytes)!==code.sha256||artifactHash(base.bytes)!==base.sha256)throw new DispatchError('DISPATCH_STATE_CONFLICT')
  return {operationId:row.id,requestId:row.request_id,attemptId:row.attempt_id,repoUrl:row.payload.repo_url,baseBranch:row.payload.base_branch,baseSha:row.base_sha,headSha:row.head_sha,branch:row.branch,mode:row.mode,expectedRemoteHead:row.expected_remote_head,codeBytes:code.bytes,baseBytes:base.bytes,checks:row.payload.checks}
 }
 async function storeReceipt(db:PoolClient,value:PublicationReceipt){await withDispatchRetryClientTransaction(db,async db=>{
  const hint=(await db.query('SELECT request_id FROM queue_dispatch_publications WHERE id=$1',[value.operationId])).rows[0];await db.query('SELECT id FROM queue_dispatch_requests WHERE id=$1 FOR UPDATE',[hint.request_id])
  const p=(await db.query('SELECT * FROM queue_dispatch_publications WHERE id=$1 FOR UPDATE',[value.operationId])).rows[0]
  if(p.state==='CONFIRMED'||p.state==='FAILED')return
  await db.query('UPDATE queue_dispatch_publications SET state=$2,remote_receipt=$3,updated_at=now() WHERE id=$1',[value.operationId,value.status.toUpperCase(),value])
 })}
 async function reconcileUnlocked(db:PoolClient,operationId:string):Promise<PublicationReceipt>{
  const x=await intent(db,operationId),row=(await db.query('SELECT state FROM queue_dispatch_publications WHERE id=$1',[operationId])).rows[0]
  // PREPARED has never crossed the durable send gate. A restart aborts it safely.
  const result=row.state==='PREPARED'?receipt(x,'failed'):await deps.port.reconcile(x);await storeReceipt(db,result);return result
 }
 /** One operation that cannot be reconciled must not starve the rest: each stored receipt bumps
  * updated_at, so ordering by it rotates the batch instead of retrying the same head forever. */
 async function reconcileIncompletePublications():Promise<{processed:number;failed:number}>{
  const rows=(await deps.store.query("SELECT id FROM queue_dispatch_publications WHERE state IN ('PREPARED','SENT','UNKNOWN') ORDER BY updated_at,id LIMIT 25")).rows
  let processed=0,failed=0
  for(const row of rows)try{await reconcilePublication(row.id);processed++}catch{failed++}
  return {processed,failed}
 }
 async function publishUnlocked(db:PoolClient,actor:DispatchActor,authority:{proof:AttemptProof}|{binding:DispatchStartBinding},artifactId:string):Promise<PublicationReceipt>{
  const requestId='proof' in authority?authority.proof.request_id:authority.binding.requestId,attemptId='proof' in authority?authority.proof.attempt_id:authority.binding.attemptId
  const verify=async(db:import('pg').PoolClient,x:Awaited<ReturnType<typeof lockArtifactAttempt>>)=>{if('proof' in authority)verifyArtifactProof(actor,authority.proof,x);else await validateHistoricalBinding(db,x,authority.binding)}
  const initial=(await db.query('SELECT input FROM queue_dispatch_requests WHERE id=$1',[requestId])).rows[0];if(!initial)throw new DispatchError('DISPATCH_NOT_FOUND')
  const baseBranch=await deps.loadBaseBranch(initial.input.requirements.repository.product_id,db)
  const p=await withDispatchRetryClientTransaction(db,async db=>{
   const x=await lockArtifactAttempt(db,attemptId);await verify(db,x);await authenticateHistoricalSupervisor(db,deps.auth,actor,x)
   const old=(await db.query('SELECT * FROM queue_dispatch_publications WHERE request_id=$1 ORDER BY created_at DESC LIMIT 1',[x.r.id])).rows[0]
   if(old){const event=(await db.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='publication_prepared' AND payload->>'operation_id'=$2",[x.r.id,old.id])).rows[0];if(old.attempt_id===x.a.id&&event?.payload.artifact_id===artifactId)return {...old,existing:true};if(!['CONFIRMED','FAILED'].includes(old.state))return {...old,existing:true}}
   if(x.r.state!=='RUNNING'||x.r.generation!==x.c.generation||!x.a.stopped_at||x.r.input.publish==='artifact')throw new DispatchError('DISPATCH_STATE_CONFLICT')
   await authorizeSend(db,actor,x)
   if(x.r.input.action==='task_implementation'&&!(await db.query("SELECT 1 FROM queue_dispatch_events WHERE request_id=$1 AND attempt_id=$2 AND type='task_verified' AND payload->>'artifact_id'=$3 AND payload->'gate'->>'allowed'='true'",[x.r.id,x.a.id,artifactId])).rowCount)throw new DispatchError('DISPATCH_STATE_CONFLICT')
   const a=(await db.query('SELECT * FROM queue_dispatch_artifacts WHERE id=$1 AND request_id=$2 AND attempt_id=$3',[artifactId,x.r.id,x.a.id])).rows[0],base=(await db.query("SELECT * FROM queue_dispatch_artifacts WHERE request_id=$1 AND attempt_id IS NULL AND key='__repository_base'",[x.r.id])).rows[0]
   if(!a||!base)throw new DispatchError('DISPATCH_INVALID_INPUT');const code=JSON.parse(Buffer.from(a.bytes).toString('utf8')),repo=x.r.input.requirements.repository,registered=(await db.query('SELECT repo_url FROM products WHERE id=$1',[repo!.product_id])).rows[0]
   if(code.branch!==`codex/queue-${x.r.id}`||code.baseSha!==repo!.base_sha||code.repoUrl!==registered.repo_url)throw new DispatchError('DISPATCH_INVALID_INPUT')
   const id=randomUUID(),key=`${x.r.id}:${x.a.id}:${artifactId}`,expected=old?.state==='CONFIRMED'?old.head_sha:null
   await db.query("INSERT INTO queue_dispatch_publications(id,request_id,attempt_id,action_key,input_hash,base_sha,head_sha,branch,mode,expected_remote_head,state,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PREPARED',now())",[id,x.r.id,x.a.id,key,x.r.input_hash,code.baseSha,code.headSha,code.branch,x.r.input.publish,expected])
   await db.query("INSERT INTO queue_dispatch_events(id,request_id,attempt_id,type,actor,payload) VALUES($1,$2,$3,'publication_prepared',$4,$5)",[randomUUID(),x.r.id,x.a.id,{service:'dispatch'},{operation_id:id,artifact_id:artifactId,base_artifact_id:base.id,repo_url:registered.repo_url,base_branch:baseBranch,checks:code.checks}])
   return {id,state:'PREPARED',existing:false}
  })
  if(p.existing){if(['CONFIRMED','FAILED'].includes(p.state))return p.remote_receipt;return reconcileUnlocked(db,p.id)}
  const x=await intent(db,p.id)
  try{await withDispatchRetryClientTransaction(db,async db=>{
   const bound=await lockArtifactAttempt(db,attemptId);await verify(db,bound);await authorizeSend(db,actor,bound)
   if(bound.r.state!=='RUNNING')throw new DispatchError('DISPATCH_STATE_CONFLICT')
   await db.query("UPDATE queue_dispatch_publications SET state='SENT',updated_at=now() WHERE id=$1 AND state='PREPARED'",[p.id])
  })}catch(error){if(!(error instanceof DispatchError))throw error;const failed=receipt(x,'failed');await storeReceipt(db,failed);return failed}
  let result:PublicationReceipt
  try{result=await deps.port.publish(x)}catch{result=receipt(x,'unknown')}
  await storeReceipt(db,result);return result
 }
 /** The reconciler may never send again, so a SENT operation whose push never happened stays UNKNOWN and holds
  * its request's reservation forever. This is the audited way out; it sends nothing. */
 async function resolveUnlocked(db:PoolClient,actor:DispatchActor,operationId:string,actionId:string,value:PublicationResolution):Promise<PublicationReceipt>{
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(actionId))throw new DispatchError('DISPATCH_INVALID_INPUT')
  const attestation=resolutionSchema.parse(value),bytes=Buffer.from(canonicalResult(attestation)),sha256=artifactHash(bytes)
  return withDispatchRetryClientTransaction(db,async db=>{
   const hint=(await db.query('SELECT attempt_id FROM queue_dispatch_publications WHERE id=$1',[operationId])).rows[0];if(!hint)throw new DispatchError('DISPATCH_NOT_FOUND')
   const x=await lockArtifactAttempt(db,hint.attempt_id);await deps.auth.authorizeDispatch(actor,x.r.input,'recover',db)
   const p=(await db.query('SELECT *,created_at<=$2::timestamptz AND $2::timestamptz<=clock_timestamp() AS observed_in_window FROM queue_dispatch_publications WHERE id=$1 FOR UPDATE',[operationId,attestation.observedAt])).rows[0]
   const key=`${actor.principalKey}:publication-resolution:${actionId}`,old=(await db.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='publication_resolved' AND payload->>'key'=$2",[x.r.id,key])).rows[0]
   if(old){if(old.payload.sha256!==sha256||old.payload.operation_id!==operationId)throw new DispatchError('DISPATCH_IDEMPOTENCY_CONFLICT');return p.remote_receipt}
   if(p.state!=='UNKNOWN'||attestation.operationId!==p.id||attestation.remoteHead===p.head_sha||!p.observed_in_window
    ||attestation.pullRequest!==(p.mode==='pull_request'?'none_found':'not_applicable'))throw new DispatchError('DISPATCH_STATE_CONFLICT')
   const artifactId=await insertArtifact(db,{requestId:x.r.id,attemptId:x.a.id,key:PUBLICATION_RESOLUTION_KEY,bytes,sha256,actor:{source:'recovery_operator',user_id:actor.userId,principal_key:actor.principalKey}})
   const result:PublicationReceipt={operationId:p.id,status:'failed',branch:p.branch,headSha:p.head_sha,prUrl:null}
   await db.query("UPDATE queue_dispatch_publications SET state='FAILED',remote_receipt=$2,updated_at=now() WHERE id=$1",[p.id,result])
   await lifecycleEvent(db,x.r.id,'publication_resolved',{key,operation_id:p.id,resolution:'failed',artifact_id:artifactId,sha256,observed_at:attestation.observedAt,remote_head:attestation.remoteHead},x.a.id,{service:'dispatch',authorized_by:actor.userId})
   return result
  })
 }
 async function exclusive<T>(requestId:string,fn:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await deps.store.connect()
  try{await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`dispatch-publisher:${requestId}`]);return await fn(db)}
  finally{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`dispatch-publisher:${requestId}`]).catch(()=>undefined);db.release()}
 }
 async function publishDispatchArtifact(actor:DispatchActor,proof:AttemptProof,artifactId:string){return exclusive(proof.request_id,db=>publishUnlocked(db,actor,{proof},artifactId))}
 async function reconcilePublication(operationId:string){const p=(await deps.store.query('SELECT request_id FROM queue_dispatch_publications WHERE id=$1',[operationId])).rows[0];if(!p)throw new DispatchError('DISPATCH_NOT_FOUND');return exclusive(p.request_id,db=>reconcileUnlocked(db,operationId))}
 async function resolveUnknownPublication(actor:DispatchActor,operationId:string,actionId:string,value:PublicationResolution){
  const p=(await deps.store.query('SELECT request_id FROM queue_dispatch_publications WHERE id=$1',[operationId])).rows[0];if(!p)throw new DispatchError('DISPATCH_NOT_FOUND')
  // Same advisory lock as publish and reconcile, so a resolution can never interleave with a send.
  return exclusive(p.request_id,db=>resolveUnlocked(db,actor,operationId,actionId,value))
 }
 return {resolveUnknownPublication,publishDispatchArtifact,publishHistoricalArtifact:(actor:DispatchActor,binding:DispatchStartBinding,artifactId:string)=>exclusive(binding.requestId,db=>publishUnlocked(db,actor,{binding},artifactId)),reconcilePublication,reconcileIncompletePublications}
}
