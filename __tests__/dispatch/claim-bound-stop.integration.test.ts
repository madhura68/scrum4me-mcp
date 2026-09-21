import {it,expect} from 'vitest'
import {randomUUID,generateKeyPairSync} from 'node:crypto'
import {makeDispatchHarness} from './harness.js'
import {createDispatchAuth} from '../../src/dispatch/auth.js'
import {createDispatchRequests} from '../../src/dispatch/requests.js'
import {createDispatchSources} from '../../src/dispatch/sources.js'
import {createDispatchSelection} from '../../src/dispatch/selection.js'
import {createDispatchRegistration} from '../../src/dispatch/registration.js'
import {createDispatchAttempts} from '../../src/dispatch/attempts.js'
import {createDispatchCompletion} from '../../src/dispatch/completion.js'
import type {DispatchResult} from '@shared/queue-dispatch.js'

/** A CLAIMED attempt whose supervisor refused before any runtime scope existed. There is no scope
 * id, no start permit and no broker observation, so the scoped stop-evidence shapes cannot describe
 * it. The claim-bound stop closes it precisely: `stop_accepted` + `stopped_at` bound to the claim,
 * then a failed result reaches FAILED with the reservation released and exactly one canonical
 * result. */
it('closes a claimed-never-scoped attempt through claim-bound stop evidence and a failed result',async()=>{
 const h=await makeDispatchHarness()
 try{
  const f=await h.seed(),auth=createDispatchAuth({store:h.dispatch}),opts={store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]}
  const reg=createDispatchRegistration({...opts,credentialKeys:{1:Buffer.alloc(32,7)},keyVersion:1})
  const scope={scopeId:'claim-only',bootId:'boot',imageDigest:`sha256:${'a'.repeat(64)}`,profileSha256:'a'.repeat(64)}
  const session=await reg.registerDispatchExecutor(f.actor,{slot_id:f.jobSlot.id,registration_key:'claimbound',boot_id:'boot',runtime:'CODEX',image_digest:scope.imageDigest,profile_sha256:scope.profileSha256})
  const requesterTokenId=randomUUID();h.trackToken(requesterTokenId)
  await h.admin.query("INSERT INTO api_tokens(id,user_id,token_hash,kind,scoped_products) VALUES($1,$2,$3,'IMPLEMENTATION',$4)",[requesterTokenId,f.actor.userId,randomUUID(),[f.input.product_id]])
  const requester={...f.actor,tokenId:requesterTokenId,principalKey:`bearer:${f.actor.userId}:${requesterTokenId}`}
  const r=await createDispatchRequests(opts).submitDispatch(requester,f.input,randomUUID())
  await createDispatchSources({...opts,fetchGit:async()=>({ok:false,reason:'network'})}).prepareRequestSources(r.id)
  await createDispatchSelection(opts).reserveRequest(r.id)
  const claimed=await createDispatchAttempts({...opts,credentialKeys:{1:Buffer.alloc(32,8)},keyVersion:1,startPermitPrivateKey:generateKeyPairSync('ed25519').privateKey}).claimDispatchAttempt(f.actor,session.incarnation_id,'claim-bound',session.session_credential)
  if(!claimed?.context)throw Error('claim required')
  const p=claimed.context.proof
  const completion=createDispatchCompletion(opts)

  // The exact pre-scope state: CLAIMED, no scope, no start, reservation still held.
  expect((await h.dispatch.query('SELECT state,scope_id,started_at FROM queue_dispatch_attempts WHERE id=$1',[p.attempt_id])).rows[0]).toEqual({state:'CLAIMED',scope_id:null,started_at:null})
  expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE candidate_id=$1',[p.candidate_id])).rows[0].released_at).toBeNull()

  const observedAt=new Date().toISOString()
  // Only the bound supervisor may submit it; a different token holding the same proof cannot.
  await expect(completion.submitClaimBoundStop(requester,p,'DISPATCH_PREPARED_SOURCES_REFUSED',observedAt)).rejects.toThrow('DISPATCH_FORBIDDEN')
  // Raw text is never accepted as a reason.
  await expect(completion.submitClaimBoundStop(f.actor,p,'boom' as never,observedAt)).rejects.toThrow('DISPATCH_STATE_CONFLICT')

  const receipt=await completion.submitClaimBoundStop(f.actor,p,'DISPATCH_PREPARED_SOURCES_REFUSED',observedAt)
  expect(receipt.receipt_id).toMatch(/^[a-f0-9-]{36}$/)
  const accepted=(await h.dispatch.query("SELECT payload->>'kind' kind,payload->>'reason' reason FROM queue_dispatch_events WHERE attempt_id=$1 AND type='stop_accepted'",[p.attempt_id])).rows
  expect(accepted).toEqual([{kind:'claim_bound_unscoped',reason:'DISPATCH_PREPARED_SOURCES_REFUSED'}])
  expect((await h.dispatch.query('SELECT stopped_at FROM queue_dispatch_attempts WHERE id=$1',[p.attempt_id])).rows[0].stopped_at).not.toBeNull()
  // Stop evidence alone does not free capacity: the reservation is released only by the result.
  expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE candidate_id=$1',[p.candidate_id])).rows[0].released_at).toBeNull()

  // Idempotent replay returns the same receipt, never a second event.
  expect(await completion.submitClaimBoundStop(f.actor,p,'DISPATCH_PREPARED_SOURCES_REFUSED',observedAt)).toEqual(receipt)
  expect((await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_events WHERE attempt_id=$1 AND type='stop_accepted'",[p.attempt_id])).rows[0].n).toBe(1)

  const failure:DispatchResult={version:1,outcome:'failed',summary:'DISPATCH_PREPARED_SOURCES_REFUSED',
   report_markdown:'The attempt was refused before any runtime scope was created. No container ran, so there is no output to report.',checks:[]}
  const result=await completion.acceptDispatchResult(f.actor,p,failure)
  expect(result.accepted).toBe(true)
  expect((await h.dispatch.query('SELECT state,result_id FROM queue_dispatch_requests WHERE id=$1',[r.id])).rows[0].state).toBe('FAILED')
  expect((await h.dispatch.query('SELECT count(*)::int n,max(outcome) outcome FROM queue_dispatch_results WHERE request_id=$1',[r.id])).rows[0]).toEqual({n:1,outcome:'FAILED'})
  expect((await h.dispatch.query('SELECT state FROM queue_dispatch_attempts WHERE id=$1',[p.attempt_id])).rows[0].state).toBe('FAILED')
  expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE candidate_id=$1',[p.candidate_id])).rows[0].released_at).not.toBeNull()

  // A single canonical result: resubmitting the same failed result replays, never a second row.
  const replay=await completion.acceptDispatchResult(f.actor,p,failure)
  expect(replay.resultId).toBe(result.resultId)
  expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_results WHERE request_id=$1',[r.id])).rows[0].n).toBe(1)
 }finally{await h.close()}
})

/** A scoped attempt must keep going through the scoped stop path: the claim-bound acceptance
 * refuses the moment a scope id exists. */
it('refuses a claim-bound stop for an attempt that entered a scope',async()=>{
 const h=await makeDispatchHarness()
 try{
  const f=await h.seed(),auth=createDispatchAuth({store:h.dispatch}),opts={store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]}
  const reg=createDispatchRegistration({...opts,credentialKeys:{1:Buffer.alloc(32,7)},keyVersion:1})
  const scope={scopeId:'scoped',bootId:'boot',imageDigest:`sha256:${'a'.repeat(64)}`,profileSha256:'a'.repeat(64)}
  const session=await reg.registerDispatchExecutor(f.actor,{slot_id:f.jobSlot.id,registration_key:'scoped',boot_id:'boot',runtime:'CODEX',image_digest:scope.imageDigest,profile_sha256:scope.profileSha256})
  const r=await createDispatchRequests(opts).submitDispatch(f.actor,f.input,randomUUID())
  await createDispatchSources({...opts,fetchGit:async()=>({ok:false,reason:'network'})}).prepareRequestSources(r.id)
  await createDispatchSelection(opts).reserveRequest(r.id)
  const claimed=await createDispatchAttempts({...opts,credentialKeys:{1:Buffer.alloc(32,8)},keyVersion:1,startPermitPrivateKey:generateKeyPairSync('ed25519').privateKey}).claimDispatchAttempt(f.actor,session.incarnation_id,'scoped-claim',session.session_credential)
  if(!claimed?.context)throw Error('claim required')
  const p=claimed.context.proof
  // A scope was entered — the exact case that must NOT use the claim-bound path.
  await h.dispatch.query("UPDATE queue_dispatch_attempts SET scope_id=$2,started_at=now(),state='RUNNING' WHERE id=$1",[p.attempt_id,scope.scopeId])
  await expect(createDispatchCompletion(opts).submitClaimBoundStop(f.actor,p,'DISPATCH_PREPARED_SOURCES_REFUSED',new Date().toISOString())).rejects.toThrow('DISPATCH_STATE_CONFLICT')
 }finally{await h.close()}
})
