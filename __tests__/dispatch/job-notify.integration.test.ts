// IDEA-243: elke claude_jobs-write van de dispatch-route stuurt een scrum4me_changes-notify in dezelfde tx.
// LISTEN loopt op een eigen client van h.admin (harness.ts: max 2 per pool), start vóór de actie en
// verzamelt na afloop 300 ms (settle-window) alle notificaties voor de job.
import {afterEach,beforeEach,it,expect} from 'vitest'
import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {makeDispatchHarness,type DispatchHarness} from './harness.js'
import {running} from './lifecycle-fixtures.js'
import {createDispatchAuth} from '../../src/dispatch/auth.js'
import {createDispatchRequests} from '../../src/dispatch/requests.js'
import {createDispatchSources} from '../../src/dispatch/sources.js'
import {createReadyFixtureSelection} from './source-fixtures.js'
import type {DispatchResult} from '@shared/queue-dispatch.js'
const result:DispatchResult={version:1,outcome:'succeeded',summary:'Bounded investigation completed',report_markdown:'Observed the requested source.',checks:[]}
let h:DispatchHarness
beforeEach(async()=>{h=await makeDispatchHarness()})
afterEach(async()=>{await h.close()})
const T='claude_job_status_changed'
const usage={version:1,runtime:'CODEX',status:'captured',model:'gpt-6.1-sol',input_tokens:200,output_tokens:300,cache_read_tokens:1000,cache_write_tokens:0,reasoning_output_tokens:40}
const settle=()=>new Promise(r=>setTimeout(r,300))
async function listen(){
 const client:PoolClient=await h.admin.connect(),seen:Array<Record<string,unknown>>=[]
 await client.query('LISTEN scrum4me_changes');client.on('notification',n=>{if(n.payload)seen.push(JSON.parse(n.payload))})
 return {seen,stop:async()=>{await client.query('UNLISTEN *');client.release()}}
}
const jobId=async(requestId:string)=>(await h.dispatch.query('SELECT id FROM claude_jobs WHERE dispatch_request_id=$1',[requestId])).rows[0].id as string
const pairs=(seen:Array<Record<string,unknown>>,id:string)=>seen.filter(e=>e.job_id===id).map(e=>[e.type,e.status])
it('notifies enqueue, claim, running and done once each, in order',async()=>{
 const l=await listen()
 try{
  const x=await running(h);await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
  // Mét usage: terminal- en usage-write gebeuren in dezelfde tx; hun notifies zijn byte-identiek en komen één keer aan.
  await x.completion.acceptDispatchResult(x.f.actor,x.proof,result,usage);await settle()
  const id=await jobId(x.proof.request_id)
  expect((await h.dispatch.query('SELECT usage_capture_status FROM claude_jobs WHERE id=$1',[id])).rows[0].usage_capture_status).toBe('captured')
  expect(pairs(l.seen,id)).toEqual([[T,'QUEUED'],[T,'CLAIMED'],[T,'RUNNING'],[T,'DONE']])
 }finally{await l.stop()}
})
it('notifies a cancellation, the usage of a late result once, and nothing on replay',async()=>{
 const l=await listen()
 try{
  const x=await running(h);await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
  const v=await x.requests.getDispatch(x.f.actor,x.proof.request_id);await x.cancel.cancelDispatch(x.f.actor,v.id,randomUUID(),v.version)
  await settle();const id=await jobId(x.proof.request_id)
  const afterCancel=pairs(l.seen,id)
  expect(afterCancel).toEqual([[T,'QUEUED'],[T,'CLAIMED'],[T,'RUNNING'],[T,'CANCELLED']])
  // Late usage op een al terminale job: precies één extra notify (guard van writeDispatchUsage).
  await x.completion.acceptDispatchResult(x.f.actor,x.proof,result,usage);await settle()
  expect(pairs(l.seen,id)).toEqual([...afterCancel,[T,'CANCELLED']])
  // Replay (`once`): de job draagt al usage, dus geen write en geen notify.
  const before=pairs(l.seen,id)
  await x.completion.acceptDispatchResult(x.f.actor,x.proof,{...result,summary:'again'},{...usage,input_tokens:1});await settle()
  expect(pairs(l.seen,id)).toEqual(before)
 }finally{await l.stop()}
})

// Selection-cancel en sources-reject: een gereserveerde, nog ongeclaimde managed job (QUEUED) wordt CANCELLED.
// Setup gespiegeld aan candidate-timeout.integration.test.ts (reserveNextRequest maakt de QUEUED job).
async function reservedQueuedJob(){
 const f=await h.seed(),auth=createDispatchAuth({store:h.dispatch}),opts={store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]}
 const selection=createReadyFixtureSelection(opts),requestId=(await createDispatchRequests(opts).submitDispatch(f.actor,f.input,'job-notify')).id
 await selection.reserveNextRequest()
 return {f,opts,selection,requestId,id:await jobId(requestId)}
}
it('notifies a selection-cancel (retireExpiredCandidate) exactly once after the enqueue',async()=>{
 const l=await listen()
 try{
  const x=await reservedQueuedJob()
  const admin=await h.admin.connect()
  try{await admin.query('BEGIN');await admin.query("SET LOCAL session_replication_role='replica'");await admin.query("UPDATE queue_dispatch_candidates SET deadline=now()-interval '1 second' WHERE request_id=$1",[x.requestId]);await admin.query('COMMIT')}finally{admin.release()}
  expect(await x.selection.retireExpiredCandidate(x.requestId)).toBe(true);await settle()
  expect(pairs(l.seen,x.id)).toEqual([[T,'QUEUED'],[T,'CANCELLED']])
  // Tweede retire raakt niets meer: geen extra notify.
  expect(await x.selection.retireExpiredCandidate(x.requestId)).toBe(false);await settle()
  expect(pairs(l.seen,x.id)).toEqual([[T,'QUEUED'],[T,'CANCELLED']])
 }finally{await l.stop()}
})
it('notifies a sources-reject (rejectUnstartedInTransaction) exactly once after the enqueue',async()=>{
 const l=await listen()
 try{
  const x=await reservedQueuedJob()
  await createDispatchSources({...x.opts,fetchGit:async()=>({ok:false,reason:'network'})}).rejectUnstarted(x.requestId,'job_notify_test');await settle()
  expect((await h.dispatch.query('SELECT status FROM claude_jobs WHERE id=$1',[x.id])).rows[0].status).toBe('CANCELLED')
  expect(pairs(l.seen,x.id)).toEqual([[T,'QUEUED'],[T,'CANCELLED']])
 }finally{await l.stop()}
})
