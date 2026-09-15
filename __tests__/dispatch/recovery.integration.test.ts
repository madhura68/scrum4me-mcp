import {beforeEach,afterEach,it,expect} from 'vitest'
import {randomUUID} from 'node:crypto'
import {makeDispatchHarness,type DispatchHarness} from './harness.js'
import {running} from './lifecycle-fixtures.js'
import {createDispatchRecovery} from '../../src/dispatch/recovery.js'
import {createDispatchSelection} from '../../src/dispatch/selection.js'
let h:DispatchHarness
beforeEach(async()=>{h=await makeDispatchHarness()});afterEach(async()=>{await h.close()})
it.each(['WAITING','RESERVED'])('authorizes stopped uncertain retry then safely cancels %s without clearing first claim history',async next=>{
 const x=await running(h),recovery=createDispatchRecovery(x.opts)
 await h.dispatch.query("UPDATE queue_dispatch_requests SET state='UNCERTAIN' WHERE id=$1",[x.proof.request_id]);await h.dispatch.query("UPDATE queue_dispatch_attempts SET state='UNCERTAIN' WHERE id=$1",[x.proof.attempt_id])
 const before=(await h.dispatch.query('SELECT first_claimed_at FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0].first_claimed_at
 const v=await x.requests.getDispatch(x.f.actor,x.proof.request_id)
 await recovery.recoverDispatch(x.f.actor,v.id,randomUUID(),v.version,x.stop,'retry_same_contract')
 if(next==='RESERVED')await createDispatchSelection(x.opts).reserveRequest(v.id)
 const retry=await x.requests.getDispatch(x.f.actor,v.id);expect(retry.state).toBe(next)
 await x.cancel.cancelDispatch(x.f.actor,v.id,randomUUID(),retry.version)
 expect((await x.requests.getDispatch(x.f.actor,v.id)).state).toBe('CANCELLED')
 expect((await h.dispatch.query('SELECT first_claimed_at FROM queue_dispatch_requests WHERE id=$1',[v.id])).rows[0].first_claimed_at).toEqual(before)
})
it('two recovery action calls cannot create two retries and changed action bytes conflict',async()=>{
 const x=await running(h),recovery=createDispatchRecovery(x.opts);await h.dispatch.query("UPDATE queue_dispatch_requests SET state='UNCERTAIN' WHERE id=$1",[x.proof.request_id]);await h.dispatch.query("UPDATE queue_dispatch_attempts SET state='UNCERTAIN' WHERE id=$1",[x.proof.attempt_id])
 const v=await x.requests.getDispatch(x.f.actor,x.proof.request_id),action=randomUUID()
 const a=await recovery.recoverDispatch(x.f.actor,v.id,action,v.version,x.stop,'retry_same_contract')
 expect((await recovery.recoverDispatch(x.f.actor,v.id,action,v.version,x.stop,'retry_same_contract')).state).toBe(a.state)
 await expect(recovery.recoverDispatch(x.f.actor,v.id,action,v.version,x.stop,'close_failed')).rejects.toThrow('DISPATCH_IDEMPOTENCY_CONFLICT')
})
it('binds nonlaunch historical receipt lookup after feature off without reissuing credentials',async()=>{
 const x=await running(h),recovery=createDispatchRecovery(x.opts)
 await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop)
 const accepted=await x.completion.acceptDispatchResult(x.f.actor,x.proof,{version:1,outcome:'succeeded',summary:'Read-only work completed',report_markdown:'Final result',checks:[]})
 const binding=(await h.dispatch.query("SELECT payload->'binding' binding FROM queue_dispatch_events WHERE attempt_id=$1 AND type='stop_accepted'",[x.proof.attempt_id])).rows[0].binding
 const port=recovery.nonLaunchRecovery(x.f.actor)
 expect(await port.lookup(binding)).toMatchObject({status:'accepted',resultId:accepted.resultId,binding})
 await expect(port.lookup({...binding,scope:{...binding.scope,scopeId:'other'}})).rejects.toThrow('DISPATCH_STATE_CONFLICT')
 await expect(port.submitStop(binding,x.stop)).resolves.toHaveProperty('receipt_id')
})
it('refuses a read-write product member without recovery role and an admin lacking product access',async()=>{
 const x=await running(h),recovery=createDispatchRecovery(x.opts)
 await h.dispatch.query("UPDATE queue_dispatch_requests SET state='UNCERTAIN' WHERE id=$1",[x.proof.request_id]);await h.dispatch.query("UPDATE queue_dispatch_attempts SET state='UNCERTAIN' WHERE id=$1",[x.proof.attempt_id])
 const token=randomUUID();h.trackToken(token);await h.admin.query("INSERT INTO api_tokens(id,user_id,token_hash,kind,scoped_products) VALUES($1,$2,$3,'IMPLEMENTATION',$4)",[token,x.f.otherUser,randomUUID(),[x.f.input.product_id]])
 const actor={...x.f.actor,userId:x.f.otherUser,tokenId:token,principalKey:`bearer:${x.f.otherUser}:${token}`},v=await x.requests.getDispatch(x.f.actor,x.proof.request_id)
 await h.admin.query("INSERT INTO product_members(id,product_id,user_id,role,access) VALUES($1,$2,$3,'DEVELOPER','READ_WRITE')",[randomUUID(),x.f.input.product_id,x.f.otherUser])
 await expect(recovery.recoverDispatch(actor,v.id,randomUUID(),v.version,x.stop,'close_failed')).rejects.toThrow('DISPATCH_FORBIDDEN')
 await h.admin.query('DELETE FROM product_members WHERE product_id=$1 AND user_id=$2',[x.f.input.product_id,x.f.otherUser]);await h.admin.query("INSERT INTO user_roles(id,user_id,role) VALUES($1,$2,'ADMIN')",[randomUUID(),x.f.otherUser])
 await expect(recovery.recoverDispatch(actor,v.id,randomUUID(),v.version,x.stop,'close_failed')).rejects.toThrow('DISPATCH_FORBIDDEN')
})
it('consumes recovery authority once on an equivalent replacement worker without reusing old credentials',async()=>{
 const x=await running(h),recovery=createDispatchRecovery(x.opts)
 await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[x.proof.attempt_id]);await x.attempts.markExpiredAttempts()
 let v=await x.requests.getDispatch(x.f.actor,x.proof.request_id)
 await recovery.recoverDispatch(x.f.actor,v.id,randomUUID(),v.version,x.stop,'retry_same_contract')
 await createDispatchSelection(x.opts).reserveRequest(v.id)
 const {createDispatchRegistration}=await import('../../src/dispatch/registration.js'),registration=createDispatchRegistration({...x.opts,credentialKeys:{1:Buffer.alloc(32,7)},keyVersion:1}),worker=randomUUID(),instance=`managed:${worker}`
 await h.admin.query("INSERT INTO claude_workers(id,user_id,token_id,instance_id,runtime,capabilities,last_seen_at) VALUES($1,$2,$3,$4,'CODEX','{}',now())",[worker,x.f.actor.userId,x.f.actor.tokenId,instance])
 const slot=await registration.createSlot(x.f.actor,{action_id:randomUUID(),token_id:x.f.actor.tokenId!,product_id:x.f.input.product_id,kind:'job',capacity_key:`job:${instance}`,address:null,profile_revision_ids:[x.f.profileId]});h.trackSlot(slot.id)
 const session=await registration.registerDispatchExecutor(x.f.actor,{slot_id:slot.id,registration_key:'replacement',boot_id:'replacement',runtime:'CODEX',image_digest:x.scope.imageDigest,profile_sha256:x.scope.profileSha256})
 const claim=await x.attempts.claimDispatchAttempt(x.f.actor,session.incarnation_id,'replacement-claim',session.session_credential)
 expect(claim?.authority).toBe('prepare');expect(claim?.context?.proof.credential).not.toBe(x.proof.credential);expect(claim?.attemptId).not.toBe(x.proof.attempt_id)
 expect((await h.dispatch.query('SELECT slot_id FROM queue_dispatch_reservations WHERE candidate_id=$1',[claim!.context!.proof.candidate_id])).rows[0].slot_id).toBe(slot.id)
 expect((await h.dispatch.query('SELECT retry_authorization_event_id FROM queue_dispatch_requests WHERE id=$1',[v.id])).rows[0].retry_authorization_event_id).toBeNull()
 expect((await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_events WHERE request_id=$1 AND type='retry_consumed'",[v.id])).rows[0].n).toBe(1)
 await expect(x.attempts.startDispatchAttempt(x.f.actor,x.proof,x.scope)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
})
it('source authorization loss closes an unclaimed recovered request through the existing source producer',async()=>{
 const x=await running(h),recovery=createDispatchRecovery(x.opts)
 await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[x.proof.attempt_id]);await x.attempts.markExpiredAttempts()
 const v=await x.requests.getDispatch(x.f.actor,x.proof.request_id);await recovery.recoverDispatch(x.f.actor,v.id,randomUUID(),v.version,x.stop,'retry_same_contract')
 await h.admin.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1',[x.f.actor.tokenId]);await createDispatchSelection(x.opts).reserveRequest(v.id)
 expect((await h.dispatch.query('SELECT state FROM queue_dispatch_requests WHERE id=$1',[v.id])).rows[0].state).toBe('FAILED')
})
it('serializes cancel_recovered_unstarted against replacement claim with exactly one winner',async()=>{
 const x=await running(h),recovery=createDispatchRecovery(x.opts)
 await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[x.proof.attempt_id]);await x.attempts.markExpiredAttempts()
 let v=await x.requests.getDispatch(x.f.actor,x.proof.request_id);await recovery.recoverDispatch(x.f.actor,v.id,randomUUID(),v.version,x.stop,'retry_same_contract');await createDispatchSelection(x.opts).reserveRequest(v.id);v=await x.requests.getDispatch(x.f.actor,v.id)
 const barrier=h.barrier(2),[cancel,claim]=await Promise.allSettled([barrier().then(()=>x.cancel.cancelDispatch(x.f.actor,v.id,randomUUID(),v.version)),barrier().then(()=>x.attempts.claimDispatchAttempt(x.f.actor,x.session.incarnation_id,'new-claim',x.session.session_credential))])
 const cancelled=cancel.status==='fulfilled'&&cancel.value.state==='CANCELLED',claimed=claim.status==='fulfilled'&&claim.value?.authority==='prepare';expect(Number(cancelled)+Number(claimed)).toBe(1)
})
it.each(['operator_attested','runtime_rebooted'] as const)('stores immutable scoped %s proof and closes through the restricted recovery producer',async kind=>{
 const x=await running(h),recovery=createDispatchRecovery(x.opts)
 await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[x.proof.attempt_id]);await x.attempts.markExpiredAttempts()
 const now=new Date().toISOString(),body={version:1 as const,binding:x.body.binding,kind,observer:'Authorized runtime operator',source:'Immutable inspection log with exact container labels and stopped PID namespace',statement:'The exact runtime scope has terminated and no execution processes remain.',processesTerminated:true as const,runtimeBootBefore:'vm-before',runtimeBootAfter:kind==='runtime_rebooted'?'vm-after':'vm-before',observedAt:now,...(kind==='runtime_rebooted'?{rebootedAt:now}:{})}
 await expect(recovery.stageRecoveryEvidence(x.f.actor,{...body,binding:{...body.binding,scope:{...x.scope,bootId:'foreign-supervisor-boot'}}})).rejects.toThrow('DISPATCH_STATE_CONFLICT')
 const evidence=await recovery.stageRecoveryEvidence(x.f.actor,body),v=await x.requests.getDispatch(x.f.actor,x.proof.request_id)
 await expect(recovery.recoverDispatch(x.f.actor,v.id,randomUUID(),v.version,{...evidence,sha256:'0'.repeat(64)},'close_failed')).rejects.toThrow('DISPATCH_STATE_CONFLICT')
 const closed=await recovery.recoverDispatch(x.f.actor,v.id,randomUUID(),v.version,evidence,'close_failed');expect(closed.state).toBe('FAILED')
 await expect(x.attempts.startDispatchAttempt(x.f.actor,x.proof,x.scope)).rejects.toThrow('DISPATCH_STATE_CONFLICT')
})
it('refuses a purported runtime reboot with unchanged VM boot identity and retains occupancy',async()=>{
 const x=await running(h),recovery=createDispatchRecovery(x.opts)
 await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[x.proof.attempt_id]);await x.attempts.markExpiredAttempts()
 const now=new Date().toISOString(),evidence=await recovery.stageRecoveryEvidence(x.f.actor,{version:1,binding:x.body.binding,kind:'runtime_rebooted',observer:'Operator',source:'Fixed inspection bytes',statement:'The exact runtime scope was inspected after an alleged reboot.',processesTerminated:true,runtimeBootBefore:'same-vm',runtimeBootAfter:'same-vm',observedAt:now,rebootedAt:now}),v=await x.requests.getDispatch(x.f.actor,x.proof.request_id)
 await expect(recovery.recoverDispatch(x.f.actor,v.id,randomUUID(),v.version,evidence,'retry_same_contract')).rejects.toThrow('DISPATCH_STATE_CONFLICT')
 expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE candidate_id=$1',[x.proof.candidate_id])).rows[0].released_at).toBeNull()
})
