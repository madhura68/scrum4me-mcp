import {it,expect} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import {makeDispatchHarness} from './harness.js'
import {codeAttempt} from './code-lifecycle-fixtures.js'
import {createDispatchPublication,type PublicationReceipt,type PublicationIntent} from '../../src/dispatch/publication.js'
import {createDispatchCompletion} from '../../src/dispatch/completion.js'
import {createDispatchCancellation} from '../../src/dispatch/cancel.js'
import {createDispatchRequests} from '../../src/dispatch/requests.js'
it('cancel wins while a sent publication loses its response; restart reconciles before capacity release and never sends twice',async()=>{
 const h=await makeDispatchHarness(),root=await mkdtemp(join(tmpdir(),'ip09-unknown-'))
 try{
  const x=await codeAttempt(h,root,{change:true,free:true});await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
  let sendCount=0,observed:PublicationIntent|undefined,release!:()=>void,entered!:()=>void
  const start=new Promise<void>(resolve=>{entered=resolve}),hold=new Promise<void>(resolve=>{release=resolve})
  const port={publish:async(i:PublicationIntent):Promise<PublicationReceipt>=>{sendCount++;observed=i;entered();await hold;throw Error('response lost')},reconcile:async(i:PublicationIntent):Promise<PublicationReceipt>=>({operationId:i.operationId,status:'confirmed',branch:i.branch,headSha:i.headSha,prUrl:null})}
  const publisher=createDispatchPublication({...x.opts,port,loadBaseBranch:async()=> 'main'}),completion=createDispatchCompletion({...x.opts,publisher})
  const pending=completion.acceptDispatchResult(x.f.actor,x.proof,x.result);await start
  const requests=createDispatchRequests(x.opts),v=await requests.getDispatch(x.f.actor,x.proof.request_id)
  await createDispatchCancellation(x.opts).cancelDispatch(x.f.actor,v.id,randomUUID(),v.version)
  expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE candidate_id=$1',[x.proof.candidate_id])).rows[0].released_at).toBeNull()
  release();expect(await pending).toMatchObject({accepted:false,reason:'publication_unknown'})
  const restarted=createDispatchPublication({...x.opts,port,loadBaseBranch:async()=> 'main'});await restarted.reconcileIncompletePublications()
  const accepted=await createDispatchCompletion({...x.opts,publisher:restarted}).acceptDispatchResult(x.f.actor,x.proof,x.result)
  expect(accepted.accepted).toBe(true);expect(sendCount).toBe(1);expect(observed?.requestId).toBe(v.id)
  expect((await requests.getDispatch(x.f.actor,v.id)).state).toBe('CANCELLED')
  await expect(x.artifacts.assertCleanupReceipt(x.f.actor,x.proof.attempt_id,accepted.resultId!)).resolves.toBeUndefined()
  expect((await h.web.query('SELECT status FROM tasks WHERE id=$1',[x.task])).rows[0].status).toBe('TO_DO')
 }finally{await h.close();await rm(root,{recursive:true,force:true})}
})
it('blocks direct publication after the immutable profile is revoked',async()=>{
 const h=await makeDispatchHarness(),root=await mkdtemp(join(tmpdir(),'ip09-revoked-publish-'))
 try{
  const x=await codeAttempt(h,root,{free:true,change:true})
  await h.dispatch.query('UPDATE queue_dispatch_profiles SET revoked_at=now() WHERE id=(SELECT profile_revision_id FROM queue_dispatch_candidates WHERE id=$1)',[x.proof.candidate_id])
  await expect(x.publisher.publishDispatchArtifact(x.f.actor,x.proof,x.artifactId)).rejects.toThrow('DISPATCH_FORBIDDEN')
  expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_publications WHERE request_id=$1',[x.proof.request_id])).rows[0].n).toBe(0)
 }finally{await h.close();await rm(root,{recursive:true,force:true})}
})
it.each([1,2])('serializes concurrent publisher/reconciler instances with a bounded pool of %s without nested acquisition',async max=>{
 const h=await makeDispatchHarness(),root=await mkdtemp(join(tmpdir(),'ip09-small-pool-')),{Pool}=await import('pg'),pool=new Pool({connectionString:process.env.DISPATCH_TEST_URL,max,connectionTimeoutMillis:300})
 try{
  const x=await codeAttempt(h,root,{free:true,change:true});let sends=0,pid:number|undefined;const externalTransactions:unknown[]=[]
  const port={publish:async(i:PublicationIntent):Promise<PublicationReceipt>=>{sends++;externalTransactions.push((await h.admin.query('SELECT xact_start FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0].xact_start);return {operationId:i.operationId,status:'unknown',branch:i.branch,headSha:i.headSha,prUrl:null}},reconcile:async(i:PublicationIntent):Promise<PublicationReceipt>=>({operationId:i.operationId,status:'confirmed',branch:i.branch,headSha:i.headSha,prUrl:null})}
  const loadBaseBranch=async(_id:string,db?:import('pg').PoolClient)=>{if(db)pid=(await db.query('SELECT pg_backend_pid() pid')).rows[0].pid;return 'main'}
  const a=createDispatchPublication({...x.opts,store:pool,port,loadBaseBranch}),b=createDispatchPublication({...x.opts,store:pool,port,loadBaseBranch})
  const first=await a.publishDispatchArtifact(x.f.actor,x.proof,x.artifactId);expect(first.status).toBe('unknown')
  const values=await Promise.all([a.publishDispatchArtifact(x.f.actor,x.proof,x.artifactId),b.publishDispatchArtifact(x.f.actor,x.proof,x.artifactId),a.reconcilePublication(first.operationId),b.reconcilePublication(first.operationId)])
  expect(values.map(v=>v.status)).toEqual(['confirmed','confirmed','confirmed','confirmed']);expect(sends).toBe(1);expect(externalTransactions).toEqual([null])
  expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_publications WHERE request_id=$1',[x.proof.request_id])).rows[0].n).toBe(1)
 }finally{await pool.end();await h.close();await rm(root,{recursive:true,force:true})}
})
it('accepted stop survives expiry while a lost publication response remains occupied until reconciliation',async()=>{
 const h=await makeDispatchHarness(),root=await mkdtemp(join(tmpdir(),'ip09-stopped-expiry-'))
 try{
  const x=await codeAttempt(h,root,{free:true,change:true,staleHeartbeat:true});let sent=0
  const port={publish:async(i:PublicationIntent):Promise<PublicationReceipt>=>{sent++;return {operationId:i.operationId,status:'unknown',branch:i.branch,headSha:i.headSha,prUrl:null}},reconcile:async(i:PublicationIntent):Promise<PublicationReceipt>=>({operationId:i.operationId,status:'confirmed',branch:i.branch,headSha:i.headSha,prUrl:null})}
  const publisher=createDispatchPublication({...x.opts,port,loadBaseBranch:async()=> 'main'}),completion=createDispatchCompletion({...x.opts,publisher})
  expect(await completion.acceptDispatchResult(x.f.actor,x.proof,x.result)).toMatchObject({accepted:false,reason:'publication_unknown'})
  await x.attempts.markExpiredAttempts()
  expect((await h.dispatch.query('SELECT state FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0].state).toBe('RUNNING')
  expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE candidate_id=$1',[x.proof.candidate_id])).rows[0].released_at).toBeNull()
  const restart=createDispatchPublication({...x.opts,port,loadBaseBranch:async()=> 'main'});await restart.reconcileIncompletePublications()
  const final=await createDispatchCompletion({...x.opts,publisher:restart}).acceptDispatchResult(x.f.actor,x.proof,x.result);expect(final.accepted).toBe(true);expect(sent).toBe(1)
  await x.artifacts.assertCleanupReceipt(x.f.actor,x.proof.attempt_id,final.resultId!)
 }finally{await h.close();await rm(root,{recursive:true,force:true})}
})
it('one publication that cannot be reconciled does not stop the reconciler from settling the next one',async()=>{
 const h=await makeDispatchHarness(),root=await mkdtemp(join(tmpdir(),'ip09-batch-'))
 try{
  const x=await codeAttempt(h,root,{free:true,change:true});await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
  const unknown=(i:PublicationIntent):PublicationReceipt=>({operationId:i.operationId,status:'unknown',branch:i.branch,headSha:i.headSha,prUrl:null})
  const port={publish:async(i:PublicationIntent)=>unknown(i),reconcile:async(i:PublicationIntent):Promise<PublicationReceipt>=>({...unknown(i),status:'confirmed'})}
  expect(await createDispatchCompletion({...x.opts,publisher:createDispatchPublication({...x.opts,port,loadBaseBranch:async()=> 'main'})}).acceptDispatchResult(x.f.actor,x.proof,x.result)).toMatchObject({accepted:false,reason:'publication_unknown'})
  // The scan lists an older operation that can no longer be loaded ahead of the real one.
  const scan=(sql:unknown)=>typeof sql==='string'&&sql.includes("state IN ('PREPARED','SENT','UNKNOWN')")
  const store=new Proxy(h.dispatch,{get:(target,key)=>key==='query'?async(sql:unknown,...rest:unknown[])=>{const result=await (target.query as (...a:unknown[])=>Promise<{rows:Array<{id:string}>}>)(sql,...rest);return scan(sql)?{...result,rows:[{id:randomUUID()},...result.rows]}:result}:Reflect.get(target,key,target)})
  const restarted=createDispatchPublication({...x.opts,store,port,loadBaseBranch:async()=> 'main'})
  await expect(restarted.reconcileIncompletePublications()).resolves.toEqual({processed:1,failed:1})
  expect((await h.dispatch.query('SELECT state FROM queue_dispatch_publications WHERE request_id=$1',[x.proof.request_id])).rows[0].state).toBe('CONFIRMED')
 }finally{await h.close();await rm(root,{recursive:true,force:true})}
})
it('an authorized operator settles a publication that reconciliation can never decide, and nothing is sent again',async()=>{
 const h=await makeDispatchHarness(),root=await mkdtemp(join(tmpdir(),'ip09-resolve-'))
 try{
  const x=await codeAttempt(h,root,{free:true,change:true});let sent=0
  const unknown=(i:PublicationIntent):PublicationReceipt=>({operationId:i.operationId,status:'unknown',branch:i.branch,headSha:i.headSha,prUrl:null})
  const port={publish:async(i:PublicationIntent)=>{sent++;return unknown(i)},reconcile:async(i:PublicationIntent)=>unknown(i)}
  const publisher=createDispatchPublication({...x.opts,port,loadBaseBranch:async()=> 'main'}),completion=createDispatchCompletion({...x.opts,publisher})
  await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
  expect(await completion.acceptDispatchResult(x.f.actor,x.proof,x.result)).toMatchObject({accepted:false,reason:'publication_unknown'})
  await publisher.reconcileIncompletePublications()
  expect(await completion.acceptDispatchResult(x.f.actor,x.proof,x.result)).toMatchObject({accepted:false,reason:'publication_unknown'})
  const p=(await h.dispatch.query('SELECT id,head_sha,state FROM queue_dispatch_publications WHERE request_id=$1',[x.proof.request_id])).rows[0];expect(p.state).toBe('UNKNOWN')
  const attest=(over:Record<string,unknown>={})=>({version:1 as const,operationId:p.id,observer:'Repository operator',source:'git ls-remote output captured from the registered remote',statement:'The request branch does not exist on the remote and no publisher process is running.',observedAt:new Date().toISOString(),remoteHead:null,pullRequest:'not_applicable' as const,...over})
  // A remote that already carries our head is a confirmation for reconciliation to find, never a failure to attest.
  await expect(publisher.resolveUnknownPublication(x.f.actor,p.id,randomUUID(),attest({remoteHead:p.head_sha}))).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  await expect(publisher.resolveUnknownPublication(x.f.actor,p.id,randomUUID(),attest({operationId:randomUUID()}))).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  await expect(publisher.resolveUnknownPublication(x.f.actor,p.id,randomUUID(),attest({observedAt:new Date(Date.now()+60_000).toISOString()}))).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  const token=randomUUID();h.trackToken(token);await h.admin.query("INSERT INTO api_tokens(id,user_id,token_hash,kind,scoped_products) VALUES($1,$2,$3,'IMPLEMENTATION',$4)",[token,x.f.otherUser,randomUUID(),[x.f.input.product_id]])
  await h.admin.query("INSERT INTO product_members(id,product_id,user_id,role,access) VALUES($1,$2,$3,'DEVELOPER','READ_WRITE')",[randomUUID(),x.f.input.product_id,x.f.otherUser])
  await expect(publisher.resolveUnknownPublication({...x.f.actor,userId:x.f.otherUser,tokenId:token,principalKey:`bearer:${x.f.otherUser}:${token}`},p.id,randomUUID(),attest())).rejects.toThrow('DISPATCH_FORBIDDEN')
  expect((await h.dispatch.query('SELECT state FROM queue_dispatch_publications WHERE id=$1',[p.id])).rows[0].state).toBe('UNKNOWN')
  const action=randomUUID(),evidence=attest(),receipt=await publisher.resolveUnknownPublication(x.f.actor,p.id,action,evidence)
  expect(receipt).toMatchObject({operationId:p.id,status:'failed'})
  expect(await publisher.resolveUnknownPublication(x.f.actor,p.id,action,evidence)).toEqual(receipt)
  await expect(publisher.resolveUnknownPublication(x.f.actor,p.id,action,attest({statement:'A different statement under the same action identifier.'}))).rejects.toThrow('DISPATCH_IDEMPOTENCY_CONFLICT')
  await expect(publisher.resolveUnknownPublication(x.f.actor,p.id,randomUUID(),evidence)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  const event=(await h.dispatch.query("SELECT actor,payload FROM queue_dispatch_events WHERE request_id=$1 AND type='publication_resolved'",[x.proof.request_id])).rows
  expect(event).toHaveLength(1);expect(event[0].payload).toMatchObject({operation_id:p.id,resolution:'failed'});expect(event[0].actor).toMatchObject({authorized_by:x.f.actor.userId})
  // The request is no longer wedged: the result is accepted as failed and capacity is released.
  const final=await completion.acceptDispatchResult(x.f.actor,x.proof,x.result);expect(final.accepted).toBe(true)
  expect((await h.dispatch.query('SELECT state FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0].state).toBe('FAILED')
  expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE candidate_id=$1',[x.proof.candidate_id])).rows[0].released_at).not.toBeNull()
  expect(sent).toBe(1)
 }finally{await h.close();await rm(root,{recursive:true,force:true})}
})

// ST-1590.38 (a): a corrupt bundle makes git fail, which surfaced as a DispatchSourceError. That is
// not a DispatchError, so it escaped accept() as a 500 and left the request RUNNING until someone
// cancelled it by hand. It belongs to the attempt and must come back as a failed result.
it('turns a failed code verification into a failed result instead of leaving the request running',async()=>{
 const h=await makeDispatchHarness(),root=await mkdtemp(join(tmpdir(),'m14-verify-'))
 try{
  const x=await codeAttempt(h,root,{free:true,change:true,corruptBundle:true});await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
  const receipt=await x.completion.acceptDispatchResult(x.f.actor,x.proof,x.result)
  expect(receipt).toMatchObject({accepted:true,reason:'failed'})
  expect(receipt.result?.outcome).toBe('failed')
  expect((await h.dispatch.query('SELECT state FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0].state).toBe('FAILED')
  expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE candidate_id=$1',[x.proof.candidate_id])).rows[0].released_at).not.toBeNull()
 }finally{await h.close();await rm(root,{recursive:true,force:true})}
})
