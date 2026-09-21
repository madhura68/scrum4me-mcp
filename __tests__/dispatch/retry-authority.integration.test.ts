import {beforeEach,afterEach,it,expect} from 'vitest'
import {randomUUID} from 'node:crypto'
import {makeDispatchHarness,type DispatchHarness} from './harness.js'
import {running} from './lifecycle-fixtures.js'
import {createDispatchRecovery} from '../../src/dispatch/recovery.js'
import {createDispatchSelection} from '../../src/dispatch/selection.js'

// T-1864 / IDEA-213 m5 application half. The DB deliberately does NOT enforce retry authority on a
// same-slot re-claim or a RESERVED-return with a generation bump (migration
// 20260921090000_queue_dispatch_guard_scope note (a); the SQL retry check only lives in the pool
// slot-transfer branch of 20260915200000). These tests drive the real application paths and prove
// the app refuses an unauthorized re-run, consumes an authorization exactly once, refuses a replay of
// a spent authorization, and serializes concurrent claims to a single consumption.

let h:DispatchHarness
beforeEach(async()=>{h=await makeDispatchHarness()});afterEach(async()=>{await h.close()})

/** Drive a claimed+started request to an authorized, reserved retry on the same job slot. */
async function authorizedReservedRetry(){
 const x=await running(h),recovery=createDispatchRecovery(x.opts)
 await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[x.proof.attempt_id])
 await x.attempts.markExpiredAttempts()
 const v=await x.requests.getDispatch(x.f.actor,x.proof.request_id)
 await recovery.recoverDispatch(x.f.actor,v.id,randomUUID(),v.version,x.stop,'retry_same_contract')
 await createDispatchSelection(x.opts).reserveRequest(v.id)
 const gen=(await h.dispatch.query('SELECT generation FROM queue_dispatch_requests WHERE id=$1',[v.id])).rows[0].generation
 return {x,recovery,requestId:v.id,generation:gen}
}
const consumedCount=async(id:string)=>(await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_events WHERE request_id=$1 AND type='retry_consumed'",[id])).rows[0].n
const attemptCount=async(id:string)=>(await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_attempts a JOIN queue_dispatch_candidates c ON c.id=a.candidate_id WHERE c.request_id=$1',[id])).rows[0].n

it('selection refuses to re-reserve a first-claimed request whose retry authorization is missing',async()=>{
 const x=await running(h)
 // The m5 DB-level unauthorized state: claim history intact, but returned to WAITING with no
 // retry_authorized event and a cleared authorization id -- exactly what the DB permits.
 await h.dispatch.query("UPDATE queue_dispatch_requests SET state='WAITING',retry_authorization_event_id=NULL WHERE id=$1",[x.proof.request_id])
 const before=(await h.dispatch.query('SELECT generation FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0].generation
 await expect(createDispatchSelection(x.opts).reserveRequest(x.proof.request_id)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
 const after=(await h.dispatch.query('SELECT generation,state FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0]
 expect(after.generation).toBe(before)
 expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_candidates WHERE request_id=$1 AND generation=$2',[x.proof.request_id,before+1])).rows[0].n).toBe(0)
})

it('claim refuses a same-slot re-claim whose retry authorization was cleared without being consumed',async()=>{
 const {x,requestId}=await authorizedReservedRetry()
 // Clear the authorization on the RESERVED retry (the finding's "retry_authorization_event_id cleared
 // with NO retry_authorized/retry_consumed event"). The candidate stays RESERVED and claimable.
 await h.dispatch.query('UPDATE queue_dispatch_requests SET retry_authorization_event_id=NULL WHERE id=$1',[requestId])
 const before=await attemptCount(requestId)
 const claim=await x.attempts.claimDispatchAttempt(x.f.actor,x.session.incarnation_id,'cleared-auth',x.session.session_credential)
 expect(claim).toBeNull()
 expect(await attemptCount(requestId)).toBe(before)
 expect((await h.dispatch.query('SELECT state FROM queue_dispatch_requests WHERE id=$1',[requestId])).rows[0].state).toBe('RESERVED')
})

it('claim refuses to reuse a retry authorization that was already spent (replay)',async()=>{
 const {x,requestId}=await authorizedReservedRetry()
 const authId=(await h.dispatch.query('SELECT retry_authorization_event_id FROM queue_dispatch_requests WHERE id=$1',[requestId])).rows[0].retry_authorization_event_id
 expect(authId).not.toBeNull()
 // Mark that same authorization as already consumed by a prior retry.
 await h.dispatch.query("INSERT INTO queue_dispatch_events(id,request_id,type,actor,payload) VALUES($1,$2,'retry_consumed',$3,$4)",[randomUUID(),requestId,{service:'dispatch'},{authorization_event_id:authId,attempt_id:randomUUID()}])
 const before=await attemptCount(requestId)
 const claim=await x.attempts.claimDispatchAttempt(x.f.actor,x.session.incarnation_id,'replay-auth',x.session.session_credential)
 expect(claim).toBeNull()
 expect(await attemptCount(requestId)).toBe(before)
})

it('an authorized same-slot retry consumes its authorization exactly once and succeeds',async()=>{
 const {x,requestId}=await authorizedReservedRetry()
 const claim=await x.attempts.claimDispatchAttempt(x.f.actor,x.session.incarnation_id,'authorized-retry',x.session.session_credential)
 expect(claim?.authority).toBe('prepare')
 expect((await h.dispatch.query('SELECT retry_authorization_event_id FROM queue_dispatch_requests WHERE id=$1',[requestId])).rows[0].retry_authorization_event_id).toBeNull()
 expect(await consumedCount(requestId)).toBe(1)
})

it('serializes two concurrent claims of one authorized retry to a single consumption',async()=>{
 const {x,requestId,generation}=await authorizedReservedRetry()
 const barrier=h.barrier(2)
 const results=await Promise.allSettled([
  barrier().then(()=>x.attempts.claimDispatchAttempt(x.f.actor,x.session.incarnation_id,'race-a',x.session.session_credential)),
  barrier().then(()=>x.attempts.claimDispatchAttempt(x.f.actor,x.session.incarnation_id,'race-b',x.session.session_credential)),
 ])
 const wins=results.filter(r=>r.status==='fulfilled'&&r.value?.authority==='prepare').length
 expect(wins).toBe(1)
 expect(await consumedCount(requestId)).toBe(1)
 expect((await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_attempts a JOIN queue_dispatch_candidates c ON c.id=a.candidate_id WHERE c.request_id=$1 AND c.generation=$2 AND a.state<>'CANCELLED'",[requestId,generation])).rows[0].n).toBe(1)
})
