import {beforeEach,afterEach,it,expect} from 'vitest'
import {randomUUID,generateKeyPairSync,createHash} from 'node:crypto'
import {makeDispatchHarness,type DispatchHarness,type DispatchHarnessSeed} from './harness.js'
import {createDispatchAuth} from '../../src/dispatch/auth.js'
import {createDispatchRequests} from '../../src/dispatch/requests.js'
import {createDispatchSelection} from '../../src/dispatch/selection.js'
import {createDispatchRegistration} from '../../src/dispatch/registration.js'
import {createDispatchAttempts} from '../../src/dispatch/attempts.js'
import {createDispatchArtifacts} from '../../src/dispatch/artifacts.js'
import {createDispatchSources} from '../../src/dispatch/sources.js'
import {assertReviewSourceReceipts,createAgentGateway} from '../../src/dispatch/agent-gateway.js'
import {createAgentOutputCapabilities} from '../../src/dispatch/agent-output-capability.js'
import {canonicalRuntimeStopObservation} from '@shared/queue-dispatch-runtime-observation.js'
import type {ExecutionContext} from '../../src/dispatch/ports.js'
let docId:string,revisionId:string
let h:DispatchHarness,f:DispatchHarnessSeed,ctx:ExecutionContext,artifacts:ReturnType<typeof createDispatchArtifacts>,sources:ReturnType<typeof createDispatchSources>,gateway:ReturnType<typeof createAgentGateway>,token:string
const keys=generateKeyPairSync('ed25519'),caps=createAgentOutputCapabilities(Buffer.alloc(32,2)),sha=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex')
const scope={scopeId:'container-1',bootId:'boot-test',imageDigest:`sha256:${'a'.repeat(64)}`,profileSha256:'a'.repeat(64)}
beforeEach(async()=>{
 h=await makeDispatchHarness();f=await h.seed();const auth=createDispatchAuth({store:h.dispatch})
 artifacts=createDispatchArtifacts({store:h.dispatch,auth});sources=createDispatchSources({store:h.dispatch,auth,fetchGit:async()=>({ok:false,reason:'network'})})
 const requests=createDispatchRequests({store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]})
 docId=randomUUID();revisionId=randomUUID();await h.admin.query("INSERT INTO product_docs(id,product_id,folder,slug,title,content_md,status,created_by,updated_at) VALUES($1,$2,'PLANS','source','Source','latest','active',$3,now())",[docId,f.input.product_id,f.actor.userId]);await h.admin.query("INSERT INTO product_doc_revisions(id,doc_id,revision,title,status,content_md,content_hash,created_by) VALUES($1,$2,1,'Source','active','pinned', $3,$4)",[revisionId,docId,sha('pinned'),f.actor.userId]);f.input.review_documents={version:1,items:[{key:'plan',title:'Plan',source:'product_doc',product_id:f.input.product_id,doc_id:docId,revision_id:revisionId,sha256:sha('pinned')}]}
 const r=await requests.submitDispatch(f.actor,f.input,randomUUID());await sources.prepareRequestSources(r.id)
 const reg=createDispatchRegistration({store:h.dispatch,auth,credentialKeys:{1:Buffer.alloc(32,7)},keyVersion:1})
 const session=await reg.registerDispatchExecutor(f.actor,{slot_id:f.jobSlot.id,registration_key:'test',boot_id:scope.bootId,runtime:'CODEX',image_digest:scope.imageDigest,profile_sha256:scope.profileSha256})
 await createDispatchSelection({store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]}).reserveRequest(r.id)
 const attempts=createDispatchAttempts({store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id],credentialKeys:{1:Buffer.alloc(32,8)},keyVersion:1,startPermitPrivateKey:keys.privateKey,startPermitKeyId:'permit-test'})
 const claim=await attempts.claimDispatchAttempt(f.actor,session.incarnation_id,'claim',session.session_credential);if(!claim?.context)throw Error('claim required');ctx=claim.context
 await attempts.startDispatchAttempt(f.actor,ctx.proof,scope)
 const inputHash=(await h.dispatch.query('SELECT input_hash FROM queue_dispatch_requests WHERE id=$1',[r.id])).rows[0].input_hash
 token=caps.mint({binding:{request_id:ctx.proof.request_id,candidate_id:ctx.proof.candidate_id,generation:ctx.proof.generation,attempt_id:ctx.proof.attempt_id,incarnation_id:ctx.proof.incarnation_id,input_sha256:inputHash,profile_sha256:scope.profileSha256} as never,action:'free_task',access:'read',attemptDeadlineMs:Date.now()+60000},Date.now())
 gateway=createAgentGateway({store:h.dispatch,auth,capabilities:caps})
})
afterEach(async()=>{await h.admin.query('DELETE FROM product_doc_revisions WHERE doc_id=$1',[docId]);await h.admin.query('DELETE FROM product_docs WHERE id=$1',[docId]);await h.close()})
it('persists bytes across service restart and races identical keys to one real receipt',async()=>{
 const bytes=Buffer.from('<script>unchanged</script>'),hash=sha(bytes)
 const ids=await Promise.all([1,2].map(()=>artifacts.storeAttemptArtifact(f.actor,ctx.proof,'report',bytes,hash)))
 expect(ids[0]).toBe(ids[1]);const restarted=createDispatchArtifacts({store:h.dispatch,auth:createDispatchAuth({store:h.dispatch})})
 expect(Buffer.from(await restarted.loadAuthorizedArtifact(f.actor,ids[0])).equals(bytes)).toBe(true)
 const download=await restarted.downloadArtifact(f.actor,ids[0]);expect(download.headers['Content-Disposition']).toContain('attachment;');expect(download.headers['Content-Type']).toBe('application/octet-stream');expect(download.headers['X-Content-Type-Options']).toBe('nosniff')
 await expect(artifacts.storeAttemptArtifact(f.actor,ctx.proof,'report',Buffer.from('changed'),sha('changed'))).rejects.toThrow('DISPATCH_IDEMPOTENCY_CONFLICT')
 expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_artifacts WHERE attempt_id=$1',[ctx.proof.attempt_id])).rows[0].n).toBe(1)
})
it('rejects wrong hash, reserved stop namespace and wrong attempt credentials',async()=>{
 await expect(artifacts.storeAttemptArtifact(f.actor,ctx.proof,'report',Buffer.from('x'),'0'.repeat(64))).rejects.toThrow('DISPATCH_INVALID_INPUT')
 await expect(artifacts.storeAttemptArtifact(f.actor,ctx.proof,'__supervisor_stop',Buffer.from('x'),sha('x'))).rejects.toThrow('DISPATCH_FORBIDDEN')
 await expect(artifacts.storeAttemptArtifact(f.actor,{...ctx.proof,credential:'fake'},'report',Buffer.from('x'),sha('x'))).rejects.toThrow('DISPATCH_FORBIDDEN')
})
it('enforces aggregate quota across concurrent different keys',async()=>{
 const bytes=Buffer.alloc(32*1024*1024),hash=sha(bytes)
 const results=await Promise.allSettled(['one','two','three'].map(k=>artifacts.storeAttemptArtifact(f.actor,ctx.proof,k,bytes,hash)))
 expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(results.filter(x=>x.status==='rejected')).toHaveLength(2)
 expect((await h.dispatch.query('SELECT sum(byte_size)::int n FROM queue_dispatch_artifacts WHERE attempt_id=$1',[ctx.proof.attempt_id])).rows[0].n).toBe(32*1024*1024)
})
it('gateway stages only fixed report/checks operations and rejects changed authority',async()=>{
 const id=await gateway.stage(token,ctx.proof.attempt_id,'stage_report',Buffer.from('report'),sha('report'));expect(id).toMatch(/^[a-f0-9-]{36}$/)
 await expect(gateway.stage(token,ctx.proof.attempt_id,'stage_code',Buffer.from('x'),sha('x'))).rejects.toThrow()
 await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[ctx.proof.attempt_id])
 await expect(gateway.stage(token,ctx.proof.attempt_id,'stage_checks',Buffer.from('x'),sha('x'))).rejects.toThrow()
})
it('keeps cleanup closed before a real accepted result receipt',async()=>{await expect(artifacts.assertCleanupReceipt(f.actor,ctx.proof.attempt_id,randomUUID())).rejects.toThrow('DISPATCH_STATE_CONFLICT')})
it('stores exact supervisor stop provenance atomically and replays the first observation after response loss',async()=>{
 const body={version:1,slotId:f.jobSlot.id,binding:{requestId:ctx.proof.request_id,candidateId:ctx.proof.candidate_id,generation:ctx.proof.generation,attemptId:ctx.proof.attempt_id,incarnationId:ctx.proof.incarnation_id,scope},runtimeBootId:'vm-test',observer:`broker:${f.jobSlot.id}`,observedAt:new Date().toISOString(),commands:[{command:'stop',succeeded:true}],containerId:scope.scopeId,pid:0,running:false,status:'exited'}
 const observation={...body,sha256:sha(canonicalRuntimeStopObservation(body))} as never
 const first=Buffer.alloc(32*1024*1024),second=Buffer.alloc(32*1024*1024-65536);await artifacts.storeAttemptArtifact(f.actor,ctx.proof,'full-one',first,sha(first));await artifacts.storeAttemptArtifact(f.actor,ctx.proof,'full-two',second,sha(second));await expect(artifacts.storeAttemptArtifact(f.actor,ctx.proof,'spill',Buffer.from('x'),sha('x'))).rejects.toThrow('DISPATCH_TOO_LARGE')
 await h.dispatch.query('UPDATE queue_dispatch_profiles SET revoked_at=now() WHERE id=$1',[f.profileId])
 const a=await artifacts.stageSupervisorStop(f.actor,observation),b=await artifacts.stageSupervisorStop(f.actor,observation);expect(a).toEqual(b)
 const provenance=(await h.dispatch.query("SELECT actor,payload FROM queue_dispatch_events WHERE type='artifact_staged' AND actor->>'source'='supervisor' AND attempt_id=$1",[ctx.proof.attempt_id])).rows
 expect(provenance).toHaveLength(1);expect(provenance[0].actor).toMatchObject({source:'supervisor',token_id:f.actor.tokenId,incarnation_id:ctx.proof.incarnation_id});expect(provenance[0].payload.artifact_id).toBe(a.artifact_id)
 const changed={...body,observedAt:new Date(Date.now()+1).toISOString()};await expect(artifacts.stageSupervisorStop(f.actor,{...changed,sha256:sha(canonicalRuntimeStopObservation(changed))} as never)).rejects.toThrow('DISPATCH_IDEMPOTENCY_CONFLICT')
})

it('requires actual per-key source delivery and an exact full result refset',async()=>{const db=await h.dispatch.connect();try{await expect(assertReviewSourceReceipts(db,ctx.proof.request_id,ctx.proof.attempt_id,f.input.review_documents)).rejects.toThrow('DISPATCH_STATE_CONFLICT');expect(Buffer.from(await gateway.readSource(token,ctx.proof.attempt_id,'plan')).toString()).toBe('pinned');await assertReviewSourceReceipts(db,ctx.proof.request_id,ctx.proof.attempt_id,f.input.review_documents);await expect(assertReviewSourceReceipts(db,ctx.proof.request_id,ctx.proof.attempt_id,{version:1,items:[{...f.input.review_documents!.items[0],title:'Changed'}]})).rejects.toThrow('DISPATCH_INVALID_INPUT');await expect(gateway.readSource(token,ctx.proof.attempt_id,'__supervisor_stop')).rejects.toThrow('DISPATCH_FORBIDDEN')}finally{db.release()}})
it('lets exactly the bound attempt read its own prepared sources by id, and nothing else',async()=>{
 const prepared=(await h.dispatch.query('SELECT id,sha256 FROM queue_dispatch_artifacts WHERE request_id=$1 AND attempt_id IS NULL',[ctx.proof.request_id])).rows
 expect(prepared).toHaveLength(1)
 const bytes=await artifacts.loadBoundSourceArtifact(f.actor,ctx.proof,prepared[0].id)
 expect(Buffer.from(bytes).toString()).toBe('pinned')
 const download=await artifacts.downloadBoundSource(f.actor,ctx.proof,prepared[0].id)
 expect(download.headers['X-Content-SHA256']).toBe(prepared[0].sha256)
 // The supervisor holds no requester identity, so this read is the attempt proof and nothing else.
 await expect(artifacts.loadBoundSourceArtifact(f.actor,{...ctx.proof,credential:'fake'},prepared[0].id)).rejects.toThrow('DISPATCH_FORBIDDEN')
 // Attempt output is never reachable through it, and neither is another request's source.
 const own=await artifacts.storeAttemptArtifact(f.actor,ctx.proof,'report',Buffer.from('mine'),sha('mine'))
 await expect(artifacts.loadBoundSourceArtifact(f.actor,ctx.proof,own)).rejects.toThrow('DISPATCH_NOT_FOUND')
 await expect(artifacts.loadBoundSourceArtifact(f.actor,ctx.proof,randomUUID())).rejects.toThrow('DISPATCH_NOT_FOUND')
})
it('signs real committed source IDs using a domain-separated manifest and never signs another requester input',async()=>{const envelope=await sources.preparedManifest(f.actor,ctx.proof,keys.privateKey,'manifest-test'),manifest=JSON.parse(envelope.manifest);const {verify}=await import('node:crypto');expect(verify(null,Buffer.from(envelope.manifest),keys.publicKey,Buffer.from(envelope.signature,'base64url'))).toBe(true);expect(manifest.purpose).toBe('dispatch-prepared-sources');expect(manifest.documents).toEqual(f.input.review_documents);const stored=(await h.dispatch.query('SELECT id,key,sha256 FROM queue_dispatch_artifacts WHERE request_id=$1 AND attempt_id IS NULL',[ctx.proof.request_id])).rows;expect(manifest.sources[0]).toMatchObject({artifactId:stored[0].id,key:stored[0].key,sha256:stored[0].sha256});await expect(sources.readDispatchSources(f.actor,{requestId:ctx.proof.request_id,input:{...f.input,objective:'Changed'}})).rejects.toThrow('DISPATCH_FORBIDDEN')})
it('never adopts a foreign scope or supervisor identity from a stop upload',async()=>{const body={version:1,slotId:f.jobSlot.id,binding:{requestId:ctx.proof.request_id,candidateId:ctx.proof.candidate_id,generation:ctx.proof.generation,attemptId:ctx.proof.attempt_id,incarnationId:ctx.proof.incarnation_id,scope:{...scope,scopeId:'foreign'}},runtimeBootId:'vm-test',observer:`broker:${f.jobSlot.id}`,observedAt:new Date().toISOString(),commands:[{command:'stop',succeeded:true}],containerId:'foreign',pid:0,running:false,status:'exited'};await expect(artifacts.stageSupervisorStop(f.actor,{...body,sha256:sha(canonicalRuntimeStopObservation(body))} as never)).rejects.toThrow('DISPATCH_FORBIDDEN');const bytes=Buffer.from('not supervisor evidence');await gateway.stage(token,ctx.proof.attempt_id,'stage_report',bytes,sha(bytes));expect((await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_events WHERE attempt_id=$1 AND actor->>'source'='supervisor'",[ctx.proof.attempt_id])).rows[0].n).toBe(0)})
