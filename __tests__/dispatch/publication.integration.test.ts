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
