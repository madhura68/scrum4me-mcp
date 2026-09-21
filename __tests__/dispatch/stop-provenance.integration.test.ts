import {it,expect} from 'vitest'
import {randomUUID,generateKeyPairSync,createHash} from 'node:crypto'
import {makeDispatchHarness} from './harness.js'
import {createDispatchAuth} from '../../src/dispatch/auth.js'
import {createDispatchRequests} from '../../src/dispatch/requests.js'
import {createDispatchSources} from '../../src/dispatch/sources.js'
import {createDispatchSelection} from '../../src/dispatch/selection.js'
import {createDispatchRegistration} from '../../src/dispatch/registration.js'
import {createDispatchAttempts} from '../../src/dispatch/attempts.js'
import {createDispatchArtifacts} from '../../src/dispatch/artifacts.js'
import {canonicalRuntimeStopObservation} from '@shared/queue-dispatch-runtime-observation.js'
it('R23 stages a stopped prepared scope without registering it, accepting it, or freeing its reservation',async()=>{
 const h=await makeDispatchHarness()
 try{
  const f=await h.seed(),auth=createDispatchAuth({store:h.dispatch}),opts={store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]},reg=createDispatchRegistration({...opts,credentialKeys:{1:Buffer.alloc(32,7)},keyVersion:1}),scope={scopeId:'prepared-only',bootId:'boot',imageDigest:`sha256:${'a'.repeat(64)}`,profileSha256:'a'.repeat(64)}
  const session=await reg.registerDispatchExecutor(f.actor,{slot_id:f.jobSlot.id,registration_key:'prepared',boot_id:'boot',runtime:'CODEX',image_digest:scope.imageDigest,profile_sha256:scope.profileSha256})
  const requesterTokenId=randomUUID();h.trackToken(requesterTokenId);await h.admin.query("INSERT INTO api_tokens(id,user_id,token_hash,kind,scoped_products) VALUES($1,$2,$3,'IMPLEMENTATION',$4)",[requesterTokenId,f.actor.userId,randomUUID(),[f.input.product_id]]);const requester={...f.actor,tokenId:requesterTokenId,principalKey:`bearer:${f.actor.userId}:${requesterTokenId}`}
  const r=await createDispatchRequests(opts).submitDispatch(requester,f.input,randomUUID());await createDispatchSources({...opts,fetchGit:async()=>({ok:false,reason:'network'})}).prepareRequestSources(r.id);await createDispatchSelection(opts).reserveRequest(r.id)
  const claimed=await createDispatchAttempts({...opts,credentialKeys:{1:Buffer.alloc(32,8)},keyVersion:1,startPermitPrivateKey:generateKeyPairSync('ed25519').privateKey,startPermitKeyId:'permit-test'}).claimDispatchAttempt(f.actor,session.incarnation_id,'prepared-claim',session.session_credential)
  if(!claimed?.context)throw Error('claim required');const p=claimed.context.proof,artifacts=createDispatchArtifacts(opts)
  const body={version:1,slotId:f.jobSlot.id,binding:{requestId:p.request_id,candidateId:p.candidate_id,generation:p.generation,attemptId:p.attempt_id,incarnationId:p.incarnation_id,scope},runtimeBootId:'vm',observer:`broker:${f.jobSlot.id}`,observedAt:new Date().toISOString(),commands:[{command:'stop',succeeded:true}],containerId:scope.scopeId,pid:0,running:false,status:'created'},observation={...body,sha256:createHash('sha256').update(canonicalRuntimeStopObservation(body)).digest('hex')}
  await expect(artifacts.stageSupervisorStop(requester,observation as never)).rejects.toThrow('DISPATCH_FORBIDDEN')
  await h.admin.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1',[requesterTokenId])
  const evidence=await artifacts.stageSupervisorStop(f.actor,observation as never)
  expect((await h.dispatch.query('SELECT state,scope_id FROM queue_dispatch_attempts WHERE id=$1',[p.attempt_id])).rows[0]).toEqual({state:'CLAIMED',scope_id:null})
  expect((await h.dispatch.query("SELECT payload->'binding'->>'provenance' provenance FROM queue_dispatch_events WHERE attempt_id=$1 AND type='artifact_staged'",[p.attempt_id])).rows[0].provenance).toBe('unregistered_prepared_scope')
  expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE candidate_id=$1',[p.candidate_id])).rows[0].released_at).toBeNull()
  await expect(artifacts.assertCleanupReceipt(f.actor,p.attempt_id,evidence.artifact_id)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  await h.admin.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1',[f.actor.tokenId]);await expect(artifacts.stageSupervisorStop(f.actor,observation as never)).rejects.toThrow('DISPATCH_UNAUTHENTICATED')
 }finally{await h.close()}
})
