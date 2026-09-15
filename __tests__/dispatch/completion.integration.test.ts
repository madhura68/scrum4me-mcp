import {afterEach,beforeEach,it,expect} from 'vitest'
import {randomUUID,generateKeyPairSync} from 'node:crypto'
import {makeDispatchHarness,type DispatchHarness} from './harness.js'
import {createDispatchAuth} from '../../src/dispatch/auth.js'
import {createDispatchRequests} from '../../src/dispatch/requests.js'
import {createDispatchSources} from '../../src/dispatch/sources.js'
import {createDispatchSelection} from '../../src/dispatch/selection.js'
import {createDispatchRegistration} from '../../src/dispatch/registration.js'
import {createDispatchAttempts} from '../../src/dispatch/attempts.js'
import {createDispatchArtifacts,artifactHash} from '../../src/dispatch/artifacts.js'
import {createDispatchCompletion} from '../../src/dispatch/completion.js'
import {createDispatchCancellation} from '../../src/dispatch/cancel.js'
import {canonicalRuntimeStopObservation,type RuntimeStopObservationBody} from '@shared/queue-dispatch-runtime-observation.js'
import type {DispatchResult} from '@shared/queue-dispatch.js'
import {running as makeRunning} from './lifecycle-fixtures.js'
const running=()=>makeRunning(h)
let h:DispatchHarness
beforeEach(async()=>{h=await makeDispatchHarness()})
afterEach(async()=>{await h.close()})
export const result:DispatchResult={version:1,outcome:'succeeded',summary:'Bounded investigation completed',report_markdown:'Observed the requested source.',checks:[]}
it('accepts genuine stopped result atomically and replays the exact receipt after response loss',async()=>{
 const x=await running();await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
 const a=await x.completion.acceptDispatchResult(x.f.actor,x.proof,result),b=await x.completion.acceptDispatchResult(x.f.actor,x.proof,result)
 expect(a.accepted).toBe(true);expect(b.resultId).toBe(a.resultId)
 expect((await x.requests.getDispatch(x.f.actor,x.proof.request_id)).state).toBe('SUCCEEDED')
 await expect(x.artifacts.assertCleanupReceipt(x.f.actor,x.proof.attempt_id,a.resultId!)).resolves.toBeUndefined()
 expect((await h.dispatch.query('SELECT status FROM claude_jobs WHERE dispatch_request_id=$1',[x.proof.request_id])).rows[0].status).toBe('DONE')
})
it.each(['cancel','result'])('preserves canonical outcome when %s commits first on separate real transactions',async winner=>{
 const x=await running();await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
 const cancel=async()=>{const v=await x.requests.getDispatch(x.f.actor,x.proof.request_id);return x.cancel.cancelDispatch(x.f.actor,v.id,randomUUID(),v.version)}
 if(winner==='cancel'){await cancel();await x.completion.acceptDispatchResult(x.f.actor,x.proof,result)}else{await x.completion.acceptDispatchResult(x.f.actor,x.proof,result);await cancel()}
 expect((await x.requests.getDispatch(x.f.actor,x.proof.request_id)).state).toBe(winner==='cancel'?'CANCELLED':'SUCCEEDED')
 expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_results WHERE request_id=$1',[x.proof.request_id])).rows[0].n).toBe(1)
})
it('cannot free occupancy from stored bytes alone or mismatched stop binding',async()=>{
 const x=await running();await expect(x.completion.acceptDispatchResult(x.f.actor,x.proof,result)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
 await expect(x.completion.verifyStopEvidence(x.f.actor,x.proof,{...x.stop,scope_id:'other'})).rejects.toThrow()
 expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE candidate_id=$1',[x.proof.candidate_id])).rows[0].released_at).toBeNull()
})
it.each([false,true])('uses actual immutable review read receipts=%s and preserves NO-GO as a successful job',async readSource=>{
 const x=await makeRunning(h,{review:true,readSource});await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
 const response=await x.completion.acceptDispatchResult(x.f.actor,x.proof,{...result,review:{verdict:'NO-GO',documents:x.f.input.review_documents}})
 const stored=(await h.dispatch.query('SELECT payload FROM queue_dispatch_results WHERE id=$1',[response.resultId])).rows[0].payload
 expect(stored.outcome).toBe(readSource?'succeeded':'failed')
 expect(stored.review?.verdict).toBe(readSource?'NO-GO':undefined)
 expect((await h.dispatch.query('SELECT status FROM claude_jobs WHERE dispatch_request_id=$1',[x.proof.request_id])).rows[0].status).toBe(readSource?'DONE':'FAILED')
 expect((await h.web.query('SELECT count(*)::int n FROM tasks WHERE product_id=$1',[x.f.input.product_id])).rows[0].n).toBe(0)
})
it('serializes concurrent cancel and success over two connections',async()=>{
 const x=await running();await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop);const v=await x.requests.getDispatch(x.f.actor,x.proof.request_id),barrier=h.barrier(2)
 const responses=await Promise.allSettled([barrier().then(()=>x.cancel.cancelDispatch(x.f.actor,v.id,randomUUID(),v.version)),barrier().then(()=>x.completion.acceptDispatchResult(x.f.actor,x.proof,result))])
 expect(responses.some(x=>x.status==='fulfilled')).toBe(true)
 const canonical=(await h.dispatch.query('SELECT * FROM queue_dispatch_results WHERE request_id=$1',[v.id])).rows;expect(canonical).toHaveLength(1)
 expect(['SUCCEEDED','CANCELLED']).toContain(canonical[0].outcome)
})
it('rejects late artifact upload after accepted stop and refuses another attempt stop receipt',async()=>{
 const x=await running();await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
 await expect(x.artifacts.storeAttemptArtifact(x.f.actor,x.proof,'late',Buffer.from('late'),artifactHash('late'))).rejects.toThrow('DISPATCH_FORBIDDEN')
 await expect(x.completion.verifyStopEvidence(x.f.actor,x.proof,{...x.stop,attempt_id:randomUUID()})).rejects.toThrow()
})
it.each(['stop','start'])('R28 allows only %s to win prepared closure versus central start',async winner=>{
 const x=await makeRunning(h,{prepared:true})
 if(winner==='stop'){
  await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
  await expect(x.attempts.startDispatchAttempt(x.f.actor,x.proof,x.scope)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  const accepted=await x.completion.acceptDispatchResult(x.f.actor,x.proof,{...result,outcome:'failed',summary:'Start was denied; created scope was stopped.'})
  await expect(x.artifacts.assertCleanupReceipt(x.f.actor,x.proof.attempt_id,accepted.resultId!)).resolves.toBeUndefined()
  expect((await h.dispatch.query('SELECT scope_id FROM queue_dispatch_attempts WHERE id=$1',[x.proof.attempt_id])).rows[0].scope_id).toBeNull()
 }else{
  await x.attempts.startDispatchAttempt(x.f.actor,x.proof,x.scope)
  await expect(x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE candidate_id=$1',[x.proof.candidate_id])).rows[0].released_at).toBeNull()
 }
})
it('permits only the authenticated stopped collector to preserve outputs without reviving agent upload rights',async()=>{
 const x=await running();await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
 const bytes=Buffer.from('collected after stop'),hash=artifactHash(bytes)
 const id=await x.artifacts.stageCollectedArtifact(x.f.actor,x.body.binding,'report',bytes,hash)
 expect(Buffer.from(await x.artifacts.loadAuthorizedArtifact(x.f.actor,id)).toString()).toBe('collected after stop')
 await expect(x.artifacts.stageCollectedArtifact(x.f.actor,{...x.body.binding,scope:{...x.scope,scopeId:'foreign'}},'report',bytes,hash)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
 await expect(x.artifacts.stageCollectedArtifact(x.f.actor,x.body.binding,'code',bytes,hash)).rejects.toThrow('DISPATCH_FORBIDDEN')
})
it('ordinary cancellation is completed by exact supervisor stop even without a model report',async()=>{
 const x=await running(),v=await x.requests.getDispatch(x.f.actor,x.proof.request_id)
 await x.cancel.cancelDispatch(x.f.actor,v.id,randomUUID(),v.version)
 await x.completion.submitStop(x.f.actor,x.proof,x.stop)
 expect((await x.requests.getDispatch(x.f.actor,v.id)).state).toBe('CANCELLED')
 const bytes=Buffer.from('late collected evidence');await expect(x.artifacts.stageCollectedArtifact(x.f.actor,x.body.binding,'report',bytes,artifactHash(bytes))).resolves.toMatch(/^[a-f0-9-]+$/)
 expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_results WHERE request_id=$1',[v.id])).rows[0].n).toBe(1)
})
it('rejects collector credentials, reserved keys, wrong hashes, overwrites and aggregate quota overflow',async()=>{
 const x=await running(),bytes=Buffer.from('evidence'),hash=artifactHash(bytes)
 await expect(x.artifacts.stageCollectedArtifact(x.f.actor,x.body.binding,'report',bytes,hash)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
 await x.completion.submitStop(x.f.actor,x.proof,x.stop)
 await expect(x.artifacts.stageCollectedArtifact({...x.f.actor,userId:x.f.otherUser},x.body.binding,'report',bytes,hash)).rejects.toThrow('DISPATCH_UNAUTHENTICATED')
 for(const key of ['__supervisor_stop','__operator_recovery']){
  await expect(x.artifacts.stageCollectedArtifact(x.f.actor,x.body.binding,key as 'report',bytes,hash)).rejects.toThrow('DISPATCH_FORBIDDEN')
  await expect(x.artifacts.storeAttemptArtifact(x.f.actor,x.proof,key,bytes,hash)).rejects.toThrow('DISPATCH_FORBIDDEN')
 }
 await expect(x.artifacts.stageCollectedArtifact(x.f.actor,x.body.binding,'report',bytes,'0'.repeat(64))).rejects.toThrow('DISPATCH_INVALID_INPUT')
 const large=Buffer.alloc(32*1024*1024),largeHash=artifactHash(large)
 await x.artifacts.stageCollectedArtifact(x.f.actor,x.body.binding,'report',large,largeHash)
 await expect(x.artifacts.stageCollectedArtifact(x.f.actor,x.body.binding,'report',bytes,hash)).rejects.toThrow('DISPATCH_IDEMPOTENCY_CONFLICT')
 await expect(x.artifacts.stageCollectedArtifact(x.f.actor,x.body.binding,'checks',large,largeHash)).rejects.toThrow('DISPATCH_TOO_LARGE')
 expect((await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_artifacts WHERE attempt_id=$1 AND key='checks'",[x.proof.attempt_id])).rows[0].n).toBe(0)
})
it('replays concurrent identical completion with the one immutable result receipt',async()=>{
 const x=await running();await x.completion.submitStop(x.f.actor,x.proof,x.stop)
 const barrier=h.barrier(2),values=await Promise.all([barrier().then(()=>x.completion.acceptDispatchResult(x.f.actor,x.proof,result)),barrier().then(()=>x.completion.acceptDispatchResult(x.f.actor,x.proof,result))])
 expect(values.every(x=>x.accepted)).toBe(true);expect(values[0].resultId).toBe(values[1].resultId)
})
it.each(['heartbeat','maximum_duration'])('does not expire accepted stopped execution during later collection: %s',async expiry=>{
 const x=await running()
 if(expiry==='maximum_duration')await h.dispatch.query("UPDATE queue_dispatch_attempts SET started_at=now()-interval '5 hours' WHERE id=$1",[x.proof.attempt_id])
 if(expiry==='heartbeat')await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[x.proof.attempt_id])
 await x.completion.submitStop(x.f.actor,x.proof,x.stop)
 const {createDispatchTick}=await import('../../src/dispatch/tick.js'),tick=createDispatchTick({...x.opts,selection:createDispatchSelection(x.opts),attempts:x.attempts})
 expect((await tick()).uncertain).toBe(0)
 expect((await x.requests.getDispatch(x.f.actor,x.proof.request_id)).state).toBe('RUNNING')
 expect((await x.completion.acceptDispatchResult(x.f.actor,x.proof,result)).accepted).toBe(true)
})
it('rechecks accepted stop under the request lock after expiry discovery',async()=>{
 const x=await running(),held=await h.dispatch.connect();let pending:Promise<number>|undefined
 try{
  await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[x.proof.attempt_id])
  await held.query('BEGIN');await held.query('SELECT id FROM queue_dispatch_requests WHERE id=$1 FOR UPDATE',[x.proof.request_id]);const pid=(await held.query('SELECT pg_backend_pid() pid')).rows[0].pid
  pending=x.attempts.markExpiredAttempts()
  let blocked=false
  for(let n=0;n<200&&!blocked;n++){blocked=(await h.admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked',[pid])).rows[0].blocked;if(!blocked)await new Promise(r=>setTimeout(r,5))}
  expect(blocked).toBe(true)
  const {lockArtifactAttempt}=await import('../../src/dispatch/artifacts.js'),{authenticateHistoricalSupervisor,acceptStopInTransaction}=await import('../../src/dispatch/stop-evidence.js'),bound=await lockArtifactAttempt(held,x.proof.attempt_id)
  await authenticateHistoricalSupervisor(held,x.opts.auth,x.f.actor,bound);await acceptStopInTransaction(held,bound,x.stop,x.f.actor);await held.query('COMMIT')
  expect(await pending).toBe(0);expect((await x.completion.acceptDispatchResult(x.f.actor,x.proof,result)).accepted).toBe(true)
 }finally{await held.query('ROLLBACK');held.release();await pending?.catch(()=>undefined)}
})
it.each(['owner','product_owner','admin','member','admin_without_access','web_owner'])('authorizes cancellation only for requester or current product administrator: %s',async role=>{
 const x=await running(),token=randomUUID();h.trackToken(token)
 await h.admin.query("INSERT INTO api_tokens(id,user_id,token_hash,kind,scoped_products) VALUES($1,$2,$3,'IMPLEMENTATION',$4)",[token,x.f.otherUser,randomUUID(),[x.f.input.product_id]])
 let actor:import('../../src/dispatch/ports.js').DispatchActor={...x.f.actor,userId:x.f.otherUser,tokenId:token,principalKey:`bearer:${x.f.otherUser}:${token}`}
 if(role==='owner'||role==='web_owner')await h.admin.query('UPDATE products SET user_id=$2 WHERE id=$1',[x.f.input.product_id,x.f.otherUser])
 else if(role!=='admin_without_access')await h.admin.query("INSERT INTO product_members(id,product_id,user_id,role,access) VALUES($1,$2,$3,$4,'READ_WRITE')",[randomUUID(),x.f.input.product_id,x.f.otherUser,role==='product_owner'?'PRODUCT_OWNER':'DEVELOPER'])
 if(role==='admin'||role==='admin_without_access')await h.admin.query("INSERT INTO user_roles(id,user_id,role) VALUES($1,$2,'ADMIN')",[randomUUID(),x.f.otherUser])
 if(role==='web_owner')actor={...actor,source:'web',tokenId:null,principalKey:`web:${x.f.otherUser}`}
 const v=(await h.dispatch.query('SELECT version FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0],action=randomUUID()
 if(['owner','product_owner','admin'].includes(role)){
  expect((await x.cancel.cancelDispatch(actor,x.proof.request_id,action,String(v.version))).state).toBe('CANCEL_REQUESTED')
  expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE candidate_id=$1',[x.proof.candidate_id])).rows[0].released_at).toBeNull()
  await x.completion.submitStop(x.f.actor,x.proof,x.stop)
  expect((await x.cancel.cancelDispatch(actor,x.proof.request_id,action,String(v.version))).state).toBe('CANCELLED')
 }else{
  await expect(x.cancel.cancelDispatch(actor,x.proof.request_id,action,String(v.version))).rejects.toThrow('DISPATCH_FORBIDDEN')
  expect((await h.dispatch.query('SELECT state,version FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0]).toEqual({state:'RUNNING',version:v.version})
 }
})
it('keeps webissuer cancellation of its own request available',async()=>{
 const x=await running(),actor={...x.f.actor,source:'web' as const,tokenId:null,principalKey:`web:${x.f.actor.userId}`},v=await x.requests.getDispatch(x.f.actor,x.proof.request_id)
 expect((await x.cancel.cancelDispatch(actor,v.id,randomUUID(),v.version)).state).toBe('CANCEL_REQUESTED')
})
