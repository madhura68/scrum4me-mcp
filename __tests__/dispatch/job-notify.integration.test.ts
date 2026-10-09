// IDEA-243: elke claude_jobs-write van de dispatch-route stuurt een scrum4me_changes-notify in dezelfde tx.
// LISTEN loopt op een eigen client van h.admin (harness.ts: max 2 per pool), start vóór de actie en
// verzamelt na afloop 300 ms (settle-window) alle notificaties voor de job.
import {afterEach,beforeEach,it,expect} from 'vitest'
import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {makeDispatchHarness,type DispatchHarness} from './harness.js'
import {running} from './lifecycle-fixtures.js'
import type {DispatchResult} from '@shared/queue-dispatch.js'
const result:DispatchResult={version:1,outcome:'succeeded',summary:'Bounded investigation completed',report_markdown:'Observed the requested source.',checks:[]}
let h:DispatchHarness
beforeEach(async()=>{h=await makeDispatchHarness()})
afterEach(async()=>{await h.close()})
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
  await x.completion.acceptDispatchResult(x.f.actor,x.proof,result);await settle()
  const id=await jobId(x.proof.request_id),t='claude_job_status_changed'
  // De terminal- en de usage-notify op het hoofdpad zijn byte-identiek en komen binnen één tx één keer aan.
  expect(pairs(l.seen,id)).toEqual([[t,'QUEUED'],[t,'CLAIMED'],[t,'RUNNING'],[t,'DONE']])
 }finally{await l.stop()}
})
it('notifies a cancellation, the usage of a late result once, and nothing on replay',async()=>{
 const l=await listen()
 try{
  const x=await running(h);await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
  const v=await x.requests.getDispatch(x.f.actor,x.proof.request_id);await x.cancel.cancelDispatch(x.f.actor,v.id,randomUUID(),v.version)
  await settle();const id=await jobId(x.proof.request_id)
  const afterCancel=pairs(l.seen,id)
  expect(afterCancel.at(-1)).toEqual(['claude_job_status_changed','CANCELLED'])
  expect(afterCancel.some(([,s])=>s==='DONE')).toBe(false)
  const usage={version:1,runtime:'CODEX',status:'captured',model:'gpt-6.1-sol',input_tokens:200,output_tokens:300,cache_read_tokens:1000,cache_write_tokens:0,reasoning_output_tokens:40}
  // Late usage op een al terminale job: precies één extra notify (guard van writeDispatchUsage).
  await x.completion.acceptDispatchResult(x.f.actor,x.proof,result,usage);await settle()
  expect(pairs(l.seen,id)).toEqual([...afterCancel,['claude_job_status_changed','CANCELLED']])
  // Replay (`once`): de job draagt al usage, dus geen write en geen notify.
  const before=pairs(l.seen,id).length
  await x.completion.acceptDispatchResult(x.f.actor,x.proof,{...result,summary:'again'},{...usage,input_tokens:1});await settle()
  expect(pairs(l.seen,id)).toHaveLength(before)
 }finally{await l.stop()}
})
