import { afterEach,beforeEach,describe,expect,it } from 'vitest'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { makeDispatchHarness,type DispatchHarness,type DispatchHarnessSeed } from './harness.js'
import { createDispatchAuth } from '../../src/dispatch/auth.js'
import { createDispatchRequests } from '../../src/dispatch/requests.js'
import { createReadyFixtureSelection as createDispatchSelection } from './source-fixtures.js'
import { createDispatchRegistration } from '../../src/dispatch/registration.js'
import { createDispatchAttempts } from '../../src/dispatch/attempts.js'
import { createDispatchCancellation } from '../../src/dispatch/cancel.js'
import { createDispatchTick } from '../../src/dispatch/tick.js'
import { createDispatchCompletion } from '../../src/dispatch/completion.js'
import { claimBoundFailedResult } from '../../src/dispatch/stop-evidence.js'
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
 it('names the bound job in the execution context so the supervisor can link its run log (M41 U1)',async()=>{
  const {context}=await claimed()
  const job=(await h.dispatch.query('SELECT job_id FROM queue_dispatch_candidates WHERE id=$1',[context.proof.candidate_id])).rows[0].job_id
  expect(job).toBeTruthy()
  expect(context.jobId).toBe(job)
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
 expect(receipt.context.jobId).toBeNull()
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
// ISS-12: a supervisor restarted (OOM) after its claim and before start registers a new incarnation,
// which signs the old one off. No start permit was issued (started_at/scope_id null, no started_scope)
// and a signed-off incarnation can never get one, so nothing ran and nothing can: the tick closes it.
describe('signed-off incarnation with an unstarted attempt (ISS-12)',()=>{
 const tick=()=>createDispatchTick({store:h.dispatch,selection,attempts})()
 const closed=async(r:{id:string},attemptId:string,outcome:'FAILED'|'CANCELLED')=>{
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe(outcome)
  expect((await h.dispatch.query('SELECT state FROM queue_dispatch_attempts WHERE id=$1',[attemptId])).rows[0].state).toBe(outcome)
  expect((await h.dispatch.query('SELECT j.status FROM claude_jobs j JOIN queue_dispatch_candidates c ON c.job_id=j.id JOIN queue_dispatch_attempts a ON a.candidate_id=c.id WHERE a.id=$1',[attemptId])).rows[0].status).toBe(outcome)
  expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations')).rows[0].released_at).not.toBeNull()
  expect((await h.dispatch.query("SELECT payload->>'kind' kind,payload->>'reason' reason FROM queue_dispatch_events WHERE attempt_id=$1 AND type='stop_accepted'",[attemptId])).rows)
   .toEqual([{kind:'signed_off_unstarted',reason:'DISPATCH_INCARNATION_SIGNED_OFF_BEFORE_START'}])
  expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_results WHERE request_id=$1',[r.id])).rows[0].n).toBe(1)
 }
 it('closes a CLAIMED attempt as FAILED once a restart signed its incarnation off',async()=>{
  const {r,context}=await claimed()
  await h.registerNextIncarnation(f.jobSlot.id)
  expect((await tick()).orphansClosed).toBe(1)
  await closed(r,context.proof.attempt_id,'FAILED')
  expect((await h.dispatch.query("SELECT payload->>'summary' summary FROM queue_dispatch_results WHERE request_id=$1",[r.id])).rows[0].summary).toBe('DISPATCH_INCARNATION_SIGNED_OFF_BEFORE_START')
  expect((await tick()).orphansClosed).toBe(0)
 })
 it('closes an attempt that already went UNCERTAIN on lease expiry (the observed incident order)',async()=>{
  const {r,context}=await claimed()
  await h.registerNextIncarnation(f.jobSlot.id)
  await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[context.proof.attempt_id])
  expect(await attempts.markExpiredAttempts()).toBe(1)
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe('UNCERTAIN')
  await tick()
  await closed(r,context.proof.attempt_id,'FAILED')
 })
 it('finishes a stuck cancellation as CANCELLED',async()=>{
  const {r,context}=await claimed()
  const v=await requests.getDispatch(f.actor,r.id)
  await createDispatchCancellation({store:h.dispatch,auth:createDispatchAuth({store:h.dispatch})}).cancelDispatch(f.actor,r.id,randomUUID(),v.version)
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe('CANCEL_REQUESTED')
  await h.registerNextIncarnation(f.jobSlot.id)
  await tick()
  await closed(r,context.proof.attempt_id,'CANCELLED')
 })
 it('leaves an unstarted attempt of a live incarnation alone',async()=>{
  const {r,context}=await claimed()
  expect((await tick()).orphansClosed).toBe(0)
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe('CLAIMED')
  expect((await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_events WHERE attempt_id=$1 AND type='stop_accepted'",[context.proof.attempt_id])).rows[0].n).toBe(0)
 })
 it('never closes a started attempt, even when its incarnation is signed off',async()=>{
  const {r,context}=await claimed();await attempts.startDispatchAttempt(f.actor,context.proof,scope)
  await h.registerNextIncarnation(f.jobSlot.id)
  expect((await tick()).orphansClosed).toBe(0)
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe('RUNNING')
  expect((await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_events WHERE attempt_id=$1 AND type='stop_accepted'",[context.proof.attempt_id])).rows[0].n).toBe(0)
  expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations')).rows).toEqual([{released_at:null}])
 })
})

// ISS-2: a supervisor that refused before any runtime scope existed closes the attempt with a
// claim-bound stop. It used to be accepted only in CLAIMED, so an attempt whose lease ran out during
// prepare (UNCERTAIN) or that was cancelled meanwhile (CANCEL_REQUESTED) hung forever. The stop is
// now accepted in all three states and closes the request in the same transaction: once stopped_at
// is set, the lease sweep, the orphan sweep and recovery all leave the attempt alone.
describe('claim-bound stop closes a never-scoped attempt atomically (ISS-2)',()=>{
 const REASON='DISPATCH_PREPARED_SOURCES_NO_SPACE'
 const tick=()=>createDispatchTick({store:h.dispatch,selection,attempts})()
 const completion=()=>createDispatchCompletion({store:h.dispatch,auth:createDispatchAuth({store:h.dispatch})})
 const stop=(proof:Parameters<ReturnType<typeof completion>['submitClaimBoundStop']>[1],observedAt=new Date().toISOString())=>completion().submitClaimBoundStop(f.actor,proof,REASON,observedAt)
 const cancel=async(id:string)=>{const v=await requests.getDispatch(f.actor,id);await createDispatchCancellation({store:h.dispatch,auth:createDispatchAuth({store:h.dispatch})}).cancelDispatch(f.actor,id,randomUUID(),v.version)}
 const expire=async(attemptId:string)=>{await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[attemptId]);return attempts.markExpiredAttempts()}
 const released=async()=>(await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations')).rows[0].released_at as Date|null
 const jobStatus=async(attemptId:string)=>(await h.dispatch.query('SELECT j.status FROM claude_jobs j JOIN queue_dispatch_candidates c ON c.job_id=j.id JOIN queue_dispatch_attempts a ON a.candidate_id=c.id WHERE a.id=$1',[attemptId])).rows[0].status as string
 const snapshot=async(id:string)=>({
  version:(await requests.getDispatch(f.actor,id)).version,
  results:(await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_results WHERE request_id=$1',[id])).rows[0].n,
  outbox:(await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_outbox WHERE request_id=$1',[id])).rows[0].n,
  accepted:(await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_events WHERE request_id=$1 AND type='result_accepted'",[id])).rows[0].n,
  stops:(await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_events WHERE request_id=$1 AND type='stop_accepted'",[id])).rows[0].n,
  released:await released(),
 })
 const closedAs=async(r:{id:string},attemptId:string,outcome:'FAILED'|'CANCELLED')=>{
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe(outcome)
  expect((await h.dispatch.query('SELECT state FROM queue_dispatch_attempts WHERE id=$1',[attemptId])).rows[0].state).toBe(outcome)
  expect(await jobStatus(attemptId)).toBe(outcome)
  expect(await released()).not.toBeNull()
  expect((await h.dispatch.query('SELECT outcome,payload FROM queue_dispatch_results WHERE request_id=$1',[r.id])).rows).toEqual([expect.objectContaining({outcome})])
 }

 it('UNCERTAIN after lease expiry: the stop alone closes it as FAILED',async()=>{
  const {r,context}=await claimed()
  expect(await expire(context.proof.attempt_id)).toBe(1)
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe('UNCERTAIN')
  expect(await released()).toBeNull()
  await stop(context.proof)
  await closedAs(r,context.proof.attempt_id,'FAILED')
  expect((await h.dispatch.query("SELECT payload->>'summary' summary FROM queue_dispatch_results WHERE request_id=$1",[r.id])).rows[0].summary).toBe(REASON)
  // A late result that differs from the supervisor form is logged and changes nothing.
  const late=await completion().acceptDispatchResult(f.actor,context.proof,{...claimBoundFailedResult(REASON),summary:'something else'})
  expect(late).toMatchObject({accepted:false,reason:'terminal_result'})
  expect((await snapshot(r.id)).results).toBe(1)
 })

 it('CANCEL_REQUESTED: cancel holds capacity, the stop then closes it as CANCELLED',async()=>{
  const {r,context}=await claimed()
  await cancel(r.id)
  expect((await requests.getDispatch(f.actor,r.id)).state).toBe('CANCEL_REQUESTED')
  expect(await released()).toBeNull()
  await stop(context.proof)
  await closedAs(r,context.proof.attempt_id,'CANCELLED')
 })

 it('CLAIMED: the stop closes it as FAILED and the supervisor result afterwards is a replay',async()=>{
  const {r,context}=await claimed()
  await stop(context.proof)
  await closedAs(r,context.proof.attempt_id,'FAILED')
  const before=await snapshot(r.id)
  // The supervisor's own result, with usage: an accepted replay; the usage is deliberately not stored.
  const usage={version:1,runtime:'CODEX',status:'captured',model:'gpt-6.1-sol',input_tokens:200,output_tokens:300,cache_read_tokens:0,cache_write_tokens:0,reasoning_output_tokens:null}
  expect(await completion().acceptDispatchResult(f.actor,context.proof,claimBoundFailedResult(REASON),usage)).toMatchObject({accepted:true,reason:'replayed'})
  expect(await snapshot(r.id)).toEqual(before)
  expect((await h.dispatch.query('SELECT j.input_tokens FROM claude_jobs j JOIN queue_dispatch_candidates c ON c.job_id=j.id WHERE c.id=$1',[context.proof.candidate_id])).rows[0].input_tokens).toBeNull()
 })

 it.each(['CLAIMED','UNCERTAIN','CANCEL_REQUESTED'] as const)('%s: a supervisor that never sends its result leaves nothing hanging',async(setup)=>{
  const {r,context}=await claimed()
  if(setup==='UNCERTAIN')await expire(context.proof.attempt_id)
  if(setup==='CANCEL_REQUESTED')await cancel(r.id)
  await stop(context.proof)
  const outcome=setup==='CANCEL_REQUESTED'?'CANCELLED':'FAILED'
  await closedAs(r,context.proof.attempt_id,outcome)
  // Stop before the lease sweep: the sweep and the orphan tick leave the closed attempt alone.
  expect(await expire(context.proof.attempt_id)).toBe(0)
  await h.registerNextIncarnation(f.jobSlot.id)
  expect((await tick()).orphansClosed).toBe(0)
  await closedAs(r,context.proof.attempt_id,outcome)
 })

 it('orphan sweep first: a later claim-bound stop is refused and changes nothing',async()=>{
  const {r,context}=await claimed()
  await h.registerNextIncarnation(f.jobSlot.id)
  expect((await tick()).orphansClosed).toBe(1)
  const before=await snapshot(r.id)
  await expect(stop(context.proof)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  expect(await snapshot(r.id)).toEqual(before)
 })

 it('a replay after closing returns the same receipt and mutates nothing; other bytes are refused',async()=>{
  const {r,context}=await claimed()
  const observedAt=new Date().toISOString()
  const receipt=await stop(context.proof,observedAt)
  const before=await snapshot(r.id)
  expect(await stop(context.proof,observedAt)).toEqual(receipt)
  expect(await snapshot(r.id)).toEqual(before)
  await expect(stop(context.proof,new Date(Date.parse(observedAt)+1).toISOString())).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  expect(await snapshot(r.id)).toEqual(before)
 })

 it('refuses a stop when the request generation moved past the candidate',async()=>{
  const {r,context}=await claimed()
  await h.dispatch.query('UPDATE queue_dispatch_requests SET generation=generation+1 WHERE id=$1',[r.id])
  await expect(stop(context.proof)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  expect(await released()).toBeNull()
  expect((await snapshot(r.id)).stops).toBe(0)
 })

 it('refuses a stop for a started attempt, also after cancel',async()=>{
  const {r,context}=await claimed()
  await attempts.startDispatchAttempt(f.actor,context.proof,scope)
  await expect(stop(context.proof)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  await cancel(r.id)
  await expect(stop(context.proof)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  expect(await released()).toBeNull()
 })

 it('refuses a start after the claim-bound stop',async()=>{
  const {context}=await claimed()
  await stop(context.proof)
  await expect(attempts.startDispatchAttempt(f.actor,context.proof,scope)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
 })
})
