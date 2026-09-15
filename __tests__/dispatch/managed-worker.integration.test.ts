import {beforeEach,afterEach,describe,it,expect} from 'vitest'
import {makeDispatchHarness,type DispatchHarness,type DispatchHarnessSeed} from './harness.js'
import {createDispatchAuth} from '../../src/dispatch/auth.js'
import {createDispatchRegistration} from '../../src/dispatch/registration.js'
import {createDispatchRequests} from '../../src/dispatch/requests.js'
import {createDispatchSelection} from '../../src/dispatch/selection.js'
let h:DispatchHarness,f:DispatchHarnessSeed
let registration:ReturnType<typeof createDispatchRegistration>
beforeEach(async()=>{h=await makeDispatchHarness();f=await h.seed();registration=createDispatchRegistration({store:h.dispatch,auth:createDispatchAuth({store:h.dispatch}),credentialKeys:{1:Buffer.alloc(32,7)},keyVersion:1})})
afterEach(async()=>{await h?.close()})
async function session(){return registration.registerDispatchExecutor(f.actor,{registration_key:'observe-boot',slot_id:f.jobSlot.id,boot_id:'observe-boot',runtime:'CODEX',image_digest:`sha256:${'a'.repeat(64)}`,profile_sha256:'a'.repeat(64)})}
describe('managed-only worker observation',()=>{
 it('restores worker freshness after initial 30s through the authenticated heartbeat',async()=>{
  const s=await session()
  await h.admin.query("UPDATE claude_workers SET last_seen_at=now()-interval '31 seconds' WHERE instance_id=$1",[f.jobSlot.instanceId])
  await h.dispatch.query('UPDATE queue_dispatch_incarnations SET busy=true WHERE id=$1',[f.hostSlot.incarnationId])
  const auth=createDispatchAuth({store:h.dispatch})
  const req=createDispatchRequests({store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]})
  const select=createDispatchSelection({store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]})
  await req.submitDispatch(f.actor,f.input,'observation')
  expect(await select.reserveNextRequest()).toBeNull()
  expect(await registration.heartbeatExecutor(f.actor,{...s,busy:false})).toEqual({live:true})
  expect(await select.reserveNextRequest()).not.toBeNull()
 })
 it('cannot update worker fields with runtime role, or invoke helper from queue/web',async()=>{
  await expect(h.dispatch.query('UPDATE claude_workers SET last_seen_at=now() WHERE instance_id=$1',[f.jobSlot.instanceId])).rejects.toThrow('permission denied')
  for(const db of [h.queue,h.web]) await expect(db.query('SELECT public.s4m_dispatch_observe_managed_worker($1,NULL,NULL,false)',[f.jobSlot.incarnationId])).rejects.toThrow('permission denied')
  for(const role of ['scrum4me_app','ops_readonly','s4m_dispatch_projector']){
   const db=await h.admin.connect()
   try{await db.query('BEGIN');await db.query('SET LOCAL ROLE '+role);await expect(db.query('SELECT public.s4m_dispatch_observe_managed_worker($1,NULL,NULL,false)',[f.jobSlot.incarnationId])).rejects.toThrow('permission denied')}
   finally{await db.query('ROLLBACK');db.release()}
  }
 })
 it('rejects forged session without refreshing worker',async()=>{
  const s=await session();await h.admin.query("UPDATE claude_workers SET last_seen_at=now()-interval '31 seconds' WHERE instance_id=$1",[f.jobSlot.instanceId])
  await expect(registration.heartbeatExecutor(f.actor,{...s,session_credential:'forged',busy:false})).rejects.toThrow()
  expect((await h.admin.query("SELECT last_seen_at<now()-interval '30 seconds' AS stale FROM claude_workers WHERE instance_id=$1",[f.jobSlot.instanceId])).rows[0].stale).toBe(true)
 })
})

describe('observation bounds and restart',()=>{
 it('uses real periodic service heartbeats across 33 seconds after boot',async()=>{
  const s=await session(),start=Date.now()
  for(let i=0;i<3;i++){await new Promise(resolve=>setTimeout(resolve,11000));await registration.heartbeatExecutor(f.actor,{...s,busy:false})}
  expect(Date.now()-start).toBeGreaterThan(30000)
  const row=(await h.admin.query("SELECT last_seen_at>now()-interval '3 seconds' AS fresh FROM claude_workers WHERE instance_id=$1",[f.jobSlot.instanceId])).rows[0]
  expect(row.fresh).toBe(true)
 },45000)
 it('preserves omitted quota, accepts explicit null, refuses stale, future and same-time replacement',async()=>{
  const s=await session()
  const observed_at=(await h.admin.query("SELECT clock_timestamp()-interval '1 second' AS t")).rows[0].t.toISOString()
  await registration.heartbeatExecutor(f.actor,{...s,busy:false,worker_observation:{quota_pct:70,observed_at}})
  await registration.heartbeatExecutor(f.actor,{...s,busy:false})
  expect((await h.admin.query('SELECT last_quota_pct FROM claude_workers WHERE instance_id=$1',[f.jobSlot.instanceId])).rows[0].last_quota_pct).toBe(70)
  for(const observation of [{quota_pct:80,observed_at},{quota_pct:70,observed_at:new Date(Date.parse(observed_at)-1000).toISOString()},{quota_pct:70,observed_at:new Date(Date.now()+60000).toISOString()},{quota_pct:70,observed_at:new Date(Date.now()-40000).toISOString()}]){
   await expect(registration.heartbeatExecutor(f.actor,{...s,busy:false,worker_observation:observation})).rejects.toThrow()
  }
  const fresh=(await h.admin.query('SELECT clock_timestamp() AS t')).rows[0].t.toISOString()
  await registration.heartbeatExecutor(f.actor,{...s,busy:false,worker_observation:{quota_pct:null,observed_at:fresh}})
  expect((await h.admin.query('SELECT last_quota_pct FROM claude_workers WHERE instance_id=$1',[f.jobSlot.instanceId])).rows[0].last_quota_pct).toBeNull()
 })
 it('rejects malformed observation and extra authority without refreshing',async()=>{
  const s=await session()
  for(const worker_observation of [{quota_pct:-1,observed_at:new Date().toISOString()},{quota_pct:101,observed_at:new Date().toISOString()},{quota_pct:0.5,observed_at:new Date().toISOString()},{quota_pct:10,observed_at:'today'},{quota_pct:10,observed_at:new Date().toISOString(),capabilities:['deploy']}]){
   await expect(registration.heartbeatExecutor(f.actor,{...s,busy:false,worker_observation})).rejects.toThrow('DISPATCH_INVALID_INPUT')
  }
 })
 it('restarts a stale exact preseed and refuses missing or incompatible worker',async()=>{
  await h.admin.query("UPDATE claude_workers SET last_seen_at=now()-interval '1 day' WHERE instance_id=$1",[f.jobSlot.instanceId])
  expect((await session()).incarnation_id).toBeTruthy()
  await h.admin.query("UPDATE claude_workers SET runtime='CLAUDE' WHERE instance_id=$1",[f.jobSlot.instanceId])
  await expect(registration.registerDispatchExecutor(f.actor,{registration_key:'mismatch',slot_id:f.jobSlot.id,boot_id:'mismatch',runtime:'CODEX',image_digest:`sha256:${'a'.repeat(64)}`,profile_sha256:'a'.repeat(64)})).rejects.toThrow()
  await h.admin.query('DELETE FROM claude_workers WHERE instance_id=$1',[f.jobSlot.instanceId])
  await expect(session()).rejects.toThrow()
 })
 it('does not revive a signed-off registration or change original scope',async()=>{
  const old=await session()
  const replacement=await registration.registerDispatchExecutor(f.actor,{registration_key:'replacement',slot_id:f.jobSlot.id,boot_id:'replacement',runtime:'CODEX',image_digest:`sha256:${'a'.repeat(64)}`,profile_sha256:'a'.repeat(64)})
  expect(replacement.incarnation_id).not.toBe(old.incarnation_id)
  expect(await session()).toEqual(old)
  await expect(registration.heartbeatExecutor(f.actor,{...old,busy:false})).rejects.toThrow()
 })
})

import {Pool} from 'pg'
import {bootstrapManagedWorker} from '../../src/dispatch/managed-worker-bootstrap.js'
it('operator bootstrap creates only exact managed worker metadata and refuses conflicts/other roles',async()=>{
 const operator=new Pool({connectionString:process.env.DISPATCH_TEST_ADMIN_URL,options:'-c role=scrum4me',max:1})
 try{
  const config={owner_user_id:f.actor.userId,token_id:f.actor.tokenId!,instance_id:f.jobSlot.instanceId,product_id:f.input.product_id,runtime:'CODEX',capabilities:['review','code_edit'],tier:'LOW_P'}
  await expect(bootstrapManagedWorker(h.dispatch,config)).rejects.toThrow('DISPATCH_BOOTSTRAP_OPERATOR_REQUIRED')
  await h.admin.query('DELETE FROM claude_workers WHERE instance_id=$1',[f.jobSlot.instanceId])
  expect(await bootstrapManagedWorker(operator,config)).toEqual({created:true})
  expect(await bootstrapManagedWorker(operator,config)).toEqual({created:false})
  await expect(bootstrapManagedWorker(operator,{...config,runtime:'CLAUDE'})).rejects.toThrow('DISPATCH_BOOTSTRAP_BINDING_CONFLICT')
  await expect(bootstrapManagedWorker(operator,{...config,owner_user_id:f.otherUser})).rejects.toThrow()
 }finally{await operator.end()}
})

import {createAgentOutputCapabilities} from '../../src/dispatch/agent-output-capability.js'
it('actual generic control bearer authentication refuses a child output capability',async()=>{
 const id='11111111-1111-4111-8111-111111111111',now=Date.now()
 const token=createAgentOutputCapabilities(Buffer.alloc(32,65)).mint({binding:{request_id:id,candidate_id:id,generation:1,attempt_id:id,incarnation_id:id,input_sha256:'a'.repeat(64),profile_sha256:'b'.repeat(64)},action:'review',access:'read',attemptDeadlineMs:now+1000},now)
 const auth=createDispatchAuth({store:h.dispatch})
 for(const path of ['/attempts/claim','/attempts/start','/attempts/result','/requests/cancel','/requests/recover'])await expect(auth.resolveDispatchActor({method:'POST',path,rawBody:Buffer.from('{}'),authorization:`Bearer ${token}`})).rejects.toThrow('DISPATCH_UNAUTHENTICATED')
})
