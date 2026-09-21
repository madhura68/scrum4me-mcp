import { afterEach,beforeEach,describe,expect,it } from 'vitest'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { makeDispatchHarness,type DispatchHarness,type DispatchHarnessSeed } from './harness.js'
import { createDispatchAuth } from '../../src/dispatch/auth.js'
import { createDispatchRequests } from '../../src/dispatch/requests.js'
import { createReadyFixtureSelection as createDispatchSelection } from './source-fixtures.js'
import { createDispatchRegistration } from '../../src/dispatch/registration.js'
import { createDispatchAttempts } from '../../src/dispatch/attempts.js'
import { createDispatchTick } from '../../src/dispatch/tick.js'
import { verifyStartPermit } from '../../src/dispatch/credentials.js'
import type { ExecutorSession } from '../../src/dispatch/client.js'
let h:DispatchHarness,f:DispatchHarnessSeed,session:ExecutorSession
let attempts:ReturnType<typeof createDispatchAttempts>, selection:ReturnType<typeof createDispatchSelection>, requests:ReturnType<typeof createDispatchRequests>,registration:ReturnType<typeof createDispatchRegistration>
const permitKeys=generateKeyPairSync('ed25519')
const scope={scopeId:'container-1',bootId:'boot-test',imageDigest:`sha256:${'a'.repeat(64)}`,profileSha256:'a'.repeat(64)}
beforeEach(async()=>{
 h=await makeDispatchHarness();f=await h.seed()
 const auth=createDispatchAuth({store:h.dispatch})
 registration=createDispatchRegistration({store:h.dispatch,auth,credentialKeys:{1:Buffer.alloc(32,7)},keyVersion:1})
 session=await registration.registerDispatchExecutor(f.actor,{slot_id:f.jobSlot.id,registration_key:'test',boot_id:scope.bootId,runtime:'CODEX',image_digest:scope.imageDigest,profile_sha256:scope.profileSha256})
 selection=createDispatchSelection({store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]})
 requests=createDispatchRequests({store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]})
 attempts=createDispatchAttempts({store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id],credentialKeys:{1:Buffer.alloc(32,8)},keyVersion:1,startPermitPrivateKey:permitKeys.privateKey,startPermitKeyId:'permit-test'})
})
afterEach(async()=>{await h?.close()})
async function reserve(){const r=await requests.submitDispatch(f.actor,f.input,randomUUID());await selection.reserveRequest(r.id);return r}
const claim=()=>attempts.claimDispatchAttempt(f.actor,session.incarnation_id,'claim-1',session.session_credential)
async function claimed(){const r=await reserve();const receipt=await claim();expect(receipt?.authority).toBe('prepare');if(!receipt?.context)throw Error('missing claim');return {r,context:receipt.context}}
describe('durable claim and start authority',()=>{
 it('recovers the same response after loss and stores exactly one claim with durable history',async()=>{
  const {r,context}=await claimed();expect((await claim())?.context).toEqual(context)
  expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_attempts')).rows[0].n).toBe(1)
  expect((await h.dispatch.query('SELECT first_claimed_at FROM queue_dispatch_requests WHERE id=$1',[r.id])).rows[0].first_claimed_at).not.toBeNull()
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe('CLAIMED')
  expect(JSON.stringify((await h.dispatch.query('SELECT * FROM queue_dispatch_attempts')).rows)).not.toContain(context.proof.credential)
 })
 it('requires current session credential before any claim',async()=>{
  await reserve();await expect(attempts.claimDispatchAttempt(f.actor,session.incarnation_id,'wrong','wrong')).rejects.toThrow('DISPATCH_FORBIDDEN')
  expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_attempts')).rows[0].n).toBe(0)
 })
 it.each(['generation','credential','incarnation','scope','digest','boot'])('refuses wrong %s proof before start',async what=>{
  const {context}=await claimed(),proof={...context.proof},badScope={...scope}
  if(what==='generation')proof.generation++
  if(what==='credential')proof.credential=session.session_credential
  if(what==='incarnation')proof.incarnation_id=randomUUID()
  if(what==='scope')badScope.scopeId=''
  if(what==='digest')badScope.imageDigest=`sha256:${'b'.repeat(64)}`
  if(what==='boot')badScope.bootId='wrong'
  await expect(attempts.startDispatchAttempt(f.actor,proof,badScope)).rejects.toThrow()
  expect((await h.dispatch.query('SELECT state FROM queue_dispatch_attempts WHERE id=$1',[context.proof.attempt_id])).rows[0].state).toBe('CLAIMED')
 })
 it('issues a five-second scope-bound permit and retries only the same started scope',async()=>{
  const {context}=await claimed();const before=Date.now(),permit=await attempts.startDispatchAttempt(f.actor,context.proof,scope)
  expect(Date.parse(permit.expiresAt)).toBeGreaterThan(before+4000);expect(Date.parse(permit.expiresAt)).toBeLessThan(Date.now()+5100)
  expect(verifyStartPermit(permit,[{kid:'permit-test',publicKey:permitKeys.publicKey}],{requestId:context.proof.request_id,candidateId:context.proof.candidate_id,generation:context.proof.generation,attemptId:context.proof.attempt_id,incarnationId:context.proof.incarnation_id,scope},Date.now()).scope).toEqual(scope)
  await expect(attempts.startDispatchAttempt(f.actor,context.proof,{...scope,scopeId:'container-2'})).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  expect((await claim())?.authority).toBe('existing_scope')
  await expect(attempts.startDispatchAttempt(f.actor,context.proof,scope)).resolves.toHaveProperty('permitId')
  expect((await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_events WHERE type='started_scope'")).rows[0].n).toBe(1)
  expect(await attempts.renewDispatchAttempt(f.actor,context.proof,scope.scopeId)).toEqual({stopRequired:false})
 })
 it('retains uncertain capacity and permits only explicit same-scope reconciliation',async()=>{
  const {r,context}=await claimed();await attempts.startDispatchAttempt(f.actor,context.proof,scope)
  await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[context.proof.attempt_id])
  const tick=createDispatchTick({store:h.dispatch,selection,attempts});expect((await tick()).uncertain).toBe(1)
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe('UNCERTAIN')
  expect(await claim()).toMatchObject({authority:'existing_scope',attemptState:'UNCERTAIN',requestState:'UNCERTAIN',scopeId:scope.scopeId})
  expect(await attempts.renewDispatchAttempt(f.actor,context.proof,scope.scopeId)).toEqual({stopRequired:true})
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe('UNCERTAIN')
  await expect(attempts.startDispatchAttempt(f.actor,context.proof,scope)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  await attempts.reconcileDispatchAttempt(f.actor,context.proof,scope)
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe('RUNNING')
  expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations')).rows).toEqual([{released_at:null}])
 })
 // The shared state table (lib/queue-dispatch-state.ts) permits CLAIMED -> lease_lost -> UNCERTAIN ->
 // resume_same_attempt -> RUNNING, a path that never passes 'start' and therefore never issues a start
 // permit. Refusing that resume is the consumer's job; this pins that the refusal is here.
 it('refuses to resume an attempt that never started',async()=>{
  const {r,context}=await claimed()
  await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[context.proof.attempt_id])
  expect(await attempts.markExpiredAttempts()).toBe(1)
  expect((await h.dispatch.query('SELECT state,started_at,scope_id FROM queue_dispatch_attempts WHERE id=$1',[context.proof.attempt_id])).rows[0]).toMatchObject({state:'UNCERTAIN',started_at:null,scope_id:null})
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe('UNCERTAIN')
  await expect(attempts.reconcileDispatchAttempt(f.actor,context.proof,scope)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe('UNCERTAIN')
  expect((await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_events WHERE type='resume_same_attempt'")).rows[0].n).toBe(0)
 })
 it('never lets a second incarnation inherit an uncertain attempt',async()=>{
  const {r,context}=await claimed()
  await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[context.proof.attempt_id])
  await attempts.markExpiredAttempts()
  const next=await h.registerNextIncarnation(f.jobSlot.id)
  expect(await attempts.claimDispatchAttempt(f.actor,next.incarnationId,'claim-2',next.sessionCredential)).toBeNull()
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe('UNCERTAIN')
 })
 it('returns current cancellation state without a context or regenerated credential',async()=>{
  const {r,context}=await claimed()
  await h.dispatch.query("UPDATE queue_dispatch_requests SET state='CANCEL_REQUESTED' WHERE id=$1",[r.id])
  await h.dispatch.query("UPDATE queue_dispatch_attempts SET state='CANCEL_REQUESTED',revoked_at=now() WHERE id=$1",[context.proof.attempt_id])
  expect(await claim()).toMatchObject({authority:'none',requestState:'CANCEL_REQUESTED',attemptState:'CANCEL_REQUESTED',context:null})
  await expect(attempts.startDispatchAttempt(f.actor,context.proof,scope)).rejects.toThrow()
  expect(await attempts.renewDispatchAttempt(f.actor,context.proof,scope.scopeId)).toEqual({stopRequired:true})
 })
 it('serializes actual retirement versus claim handlers on independent connections',async()=>{
  const r=await reserve()
  const admin=await h.admin.connect()
  try { await admin.query('BEGIN');await admin.query("SET LOCAL session_replication_role='replica'");await admin.query("UPDATE queue_dispatch_candidates SET deadline=now()-interval '1 second' WHERE request_id=$1",[r.id]);await admin.query('COMMIT') } finally { admin.release() }
  const barrier=h.barrier(2)
  const [retired,receipt]=await Promise.all([barrier().then(()=>selection.retireExpiredCandidate(r.id)),barrier().then(()=>claim())])
  expect(Number(retired)+Number(receipt!==null)).toBe(1)
  expect(retired&&receipt!==null).toBe(false)
  if(receipt)expect((await requests.getDispatch(f.actor,r.id)).state).toBe('CLAIMED')
 })
})

it('claims on a different actual equivalent worker with one atomic reservation transfer',async()=>{
 const r=await reserve(),instance=`managed:${randomUUID()}`
 await h.admin.query("INSERT INTO claude_workers(id,user_id,token_id,instance_id,runtime,capabilities,last_seen_at) VALUES($1,$2,$3,$4,'CODEX','{}',now())",[randomUUID(),f.actor.userId,f.actor.tokenId,instance])
 const slot=await registration.createSlot(f.actor,{action_id:'second',token_id:f.actor.tokenId!,product_id:f.input.product_id,kind:'job',capacity_key:`job:${instance}`,address:null,profile_revision_ids:[f.profileId]});h.trackSlot(slot.id)
 const other=await registration.registerDispatchExecutor(f.actor,{slot_id:slot.id,registration_key:'second',boot_id:'second',runtime:'CODEX',image_digest:scope.imageDigest,profile_sha256:scope.profileSha256})
 const receipt=await attempts.claimDispatchAttempt(f.actor,other.incarnation_id,'second-claim',other.session_credential)
 expect(receipt?.authority).toBe('prepare')
 expect((await h.dispatch.query('SELECT slot_id FROM queue_dispatch_reservations')).rows).toEqual([{slot_id:slot.id}])
 expect((await h.dispatch.query('SELECT worker_instance_id FROM claude_jobs WHERE dispatch_request_id=$1',[r.id])).rows[0].worker_instance_id).toBe(instance)
})
it('rejects actual job metadata that no longer matches the managed request',async()=>{
 const r=await reserve()
 await h.dispatch.query("UPDATE claude_jobs SET kind='TASK_IMPLEMENTATION',source='MANUAL' WHERE dispatch_request_id=$1",[r.id])
 expect(await claim()).toBeNull()
})
it('requests cancellation at maximum duration while preserving occupied capacity',async()=>{
 const {r,context}=await claimed();await attempts.startDispatchAttempt(f.actor,context.proof,scope)
 await h.dispatch.query("UPDATE queue_dispatch_attempts SET started_at=now()-interval '301 seconds' WHERE id=$1",[context.proof.attempt_id])
 expect(await attempts.renewDispatchAttempt(f.actor,context.proof,scope.scopeId)).toEqual({stopRequired:true})
 expect((await requests.getDispatch(f.actor,r.id)).state).toBe('CANCEL_REQUESTED')
 expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations')).rows).toEqual([{released_at:null}])
})
it('fresh authorization narrowing cannot re-enable start or uncertain reconciliation',async()=>{
 const {context}=await claimed()
 await h.dispatch.query('UPDATE queue_dispatch_profiles SET revoked_at=now() WHERE id=$1',[f.profileId])
 await expect(attempts.startDispatchAttempt(f.actor,context.proof,scope)).rejects.toThrow('DISPATCH_FORBIDDEN')
 expect((await claim())?.context).toBeNull()
})

it('cannot create another authority from request history without the IP09 recovery producer',async()=>{
 const r=await reserve();await h.dispatch.query('UPDATE queue_dispatch_requests SET first_claimed_at=now() WHERE id=$1',[r.id])
 expect(await claim()).toBeNull()
})

it('serializes concurrent duplicate claim keys to one durable receipt',async()=>{
 await reserve();const barrier=h.barrier(2)
 const pair=await Promise.all([1,2].map(async()=>{await barrier();return claim()}))
 expect(pair[0]).toEqual(pair[1]);expect(pair[0]?.authority).toBe('prepare')
 expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_attempts')).rows[0].n).toBe(1)
})
it('does not reconcile a same-scope attempt beyond its maximum duration',async()=>{
 const {context}=await claimed();await attempts.startDispatchAttempt(f.actor,context.proof,scope)
 await h.dispatch.query("UPDATE queue_dispatch_attempts SET started_at=now()-interval '5 hours',heartbeat_at=now()-interval '121 seconds',state='UNCERTAIN' WHERE id=$1",[context.proof.attempt_id])
 await h.dispatch.query("UPDATE queue_dispatch_candidates SET state='UNCERTAIN' WHERE id=$1",[context.proof.candidate_id])
 await h.dispatch.query("UPDATE queue_dispatch_requests SET state='UNCERTAIN' WHERE id=$1",[context.proof.request_id])
 await expect(attempts.reconcileDispatchAttempt(f.actor,context.proof,scope)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
})
it('binds a host claim to exactly its registered incarnation and starts that scope',async()=>{
 await h.dispatch.query('UPDATE queue_dispatch_slots SET enabled=false WHERE id=$1',[f.jobSlot.id])
 const host=await registration.registerDispatchExecutor(f.actor,{slot_id:f.hostSlot.id,registration_key:'host',boot_id:scope.bootId,runtime:'CODEX',image_digest:scope.imageDigest,profile_sha256:scope.profileSha256})
 await reserve()
 const receipt=await attempts.claimDispatchAttempt(f.actor,host.incarnation_id,'host-claim',host.session_credential)
 expect(receipt?.authority).toBe('prepare');if(!receipt?.context)throw Error('host not claimed')
 expect(receipt.context.proof.incarnation_id).toBe(host.incarnation_id)
 await expect(attempts.startDispatchAttempt(f.actor,receipt.context.proof,scope)).resolves.toHaveProperty('permitId')
 expect((await h.dispatch.query('SELECT count(*)::int n FROM claude_jobs')).rows[0].n).toBe(0)
 // Registration may sign off an old session; its claim and occupied scope stay bound.
 const replacement=await registration.registerDispatchExecutor(f.actor,{slot_id:f.hostSlot.id,registration_key:'replacement',boot_id:'other',runtime:'CODEX',image_digest:scope.imageDigest,profile_sha256:scope.profileSha256})
 expect(await attempts.claimDispatchAttempt(f.actor,replacement.incarnation_id,'replacement-claim',replacement.session_credential)).toBeNull()
 await expect(attempts.startDispatchAttempt(f.actor,receipt.context.proof,scope)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
})
it('fresh token revocation prevents start and requests stop without releasing its slot',async()=>{
 const {context}=await claimed();await attempts.startDispatchAttempt(f.actor,context.proof,scope)
 await h.admin.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1',[f.actor.tokenId])
 await expect(attempts.startDispatchAttempt(f.actor,context.proof,scope)).rejects.toThrow('DISPATCH_UNAUTHENTICATED')
 expect(await attempts.renewDispatchAttempt(f.actor,context.proof,scope.scopeId)).toEqual({stopRequired:true})
 expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations')).rows).toEqual([{released_at:null}])
})
it('cancels an unattended uncertain scope at maximum duration exactly once without freeing capacity',async()=>{
 const {r,context}=await claimed();await attempts.startDispatchAttempt(f.actor,context.proof,scope)
 await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[context.proof.attempt_id])
 expect(await attempts.markExpiredAttempts()).toBe(1)
 expect((await requests.getDispatch(f.actor,r.id)).state).toBe('UNCERTAIN')
 await h.dispatch.query("UPDATE queue_dispatch_attempts SET started_at=now()-interval '301 seconds' WHERE id=$1",[context.proof.attempt_id])
 const tick=createDispatchTick({store:h.dispatch,selection,attempts});await tick();await tick()
 expect((await requests.getDispatch(f.actor,r.id)).state).toBe('CANCEL_REQUESTED')
 expect((await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_events WHERE type='stop_required' AND payload->>'reason'='maximum_duration'")).rows[0].n).toBe(1)
 expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations')).rows).toEqual([{released_at:null}])
 expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_candidates')).rows[0].n).toBe(1)
})
