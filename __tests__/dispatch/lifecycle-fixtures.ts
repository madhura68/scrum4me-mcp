import {createAgentGateway} from '../../src/dispatch/agent-gateway.js'
import {createAgentOutputCapabilities} from '../../src/dispatch/agent-output-capability.js'
import {randomUUID,generateKeyPairSync} from 'node:crypto'
import {makeDispatchHarness,type DispatchHarness} from './harness.js'
import {createDispatchAuth} from '../../src/dispatch/auth.js'
import {createDispatchRequests} from '../../src/dispatch/requests.js'
import {createDispatchSources} from '../../src/dispatch/sources.js'
import {createDispatchSelection} from '../../src/dispatch/selection.js'
import {createDispatchRegistration} from '../../src/dispatch/registration.js'
import {createDispatchAttempts} from '../../src/dispatch/attempts.js'
import {createDispatchArtifacts,artifactHash} from '../../src/dispatch/artifacts.js'
import {createDispatchCompletion} from '../../src/dispatch/completion.js'
import {createDispatchCancellation} from '../../src/dispatch/cancel.js'
import {canonicalRuntimeStopObservation,type RuntimeStopObservationBody} from '@shared/queue-dispatch-runtime-observation.js'
import type {DispatchResult} from '@shared/queue-dispatch.js'
export async function running(h:DispatchHarness,options:{prepared?:boolean;review?:boolean;readSource?:boolean}={}){
 const f=await h.seed(),auth=createDispatchAuth({store:h.dispatch}),opts={store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]},requests=createDispatchRequests(opts)
 if(options.review){
  const docId=randomUUID(),revisionId=randomUUID(),profileId=randomUUID(),sha=artifactHash('pinned')
  await h.admin.query("INSERT INTO product_docs(id,product_id,folder,slug,title,content_md,status,created_by,updated_at) VALUES($1,$2,'PLANS','source','Source','latest','active',$3,now())",[docId,f.input.product_id,f.actor.userId]);await h.admin.query("INSERT INTO product_doc_revisions(id,doc_id,revision,title,status,content_md,content_hash,created_by) VALUES($1,$2,1,'Source','active','pinned',$3,$4)",[revisionId,docId,sha,f.actor.userId])
  await h.dispatch.query("UPDATE queue_dispatch_slots SET config=jsonb_set(config,'{capabilities}','[\"review\"]') WHERE id=$1",[f.jobSlot.id]);await h.admin.query("UPDATE claude_workers SET capabilities=ARRAY['review'] WHERE id=$1",[f.jobSlot.id])
  f.input.action='review';f.input.review_documents={version:1,items:[{key:'plan',title:'Plan',source:'product_doc',product_id:f.input.product_id,doc_id:docId,revision_id:revisionId,sha256:sha}]}
  const config=(await h.dispatch.query('SELECT config FROM queue_dispatch_profiles WHERE id=$1',[f.profileId])).rows[0].config
  await h.dispatch.query('INSERT INTO queue_dispatch_profiles(id,key,revision,product_id,owner_user_id,config,sha256) VALUES($1::uuid,$1::text,1,$2,$3,$4,$5)',[profileId,f.input.product_id,f.actor.userId,{...config,actions:['review']},'a'.repeat(64)])
  await h.dispatch.query('INSERT INTO queue_dispatch_slot_profiles(slot_id,profile_revision_id) VALUES($1,$2)',[f.jobSlot.id,profileId])
 }
 const reg=createDispatchRegistration({...opts,credentialKeys:{1:Buffer.alloc(32,7)},keyVersion:1}),scope={scopeId:randomUUID(),bootId:'boot',imageDigest:`sha256:${'a'.repeat(64)}`,profileSha256:'a'.repeat(64)}
 const session=await reg.registerDispatchExecutor(f.actor,{slot_id:f.jobSlot.id,registration_key:'completion',boot_id:'boot',runtime:'CODEX',image_digest:scope.imageDigest,profile_sha256:scope.profileSha256})
 const r=await requests.submitDispatch(f.actor,f.input,randomUUID());await createDispatchSources({...opts,fetchGit:async()=>({ok:false,reason:'network'})}).prepareRequestSources(r.id);await createDispatchSelection(opts).reserveRequest(r.id)
 const attempts=createDispatchAttempts({...opts,credentialKeys:{1:Buffer.alloc(32,8)},keyVersion:1,startPermitPrivateKey:generateKeyPairSync('ed25519').privateKey}),receipt=await attempts.claimDispatchAttempt(f.actor,session.incarnation_id,'claim',session.session_credential)
 if(!receipt?.context)throw Error('claim required');const proof=receipt.context.proof;if(!options.prepared)await attempts.startDispatchAttempt(f.actor,proof,scope)
 if(options.readSource){const capabilities=createAgentOutputCapabilities(Buffer.alloc(32,2)),inputHash=(await h.dispatch.query('SELECT input_hash FROM queue_dispatch_requests WHERE id=$1',[r.id])).rows[0].input_hash,token=capabilities.mint({binding:{request_id:r.id,candidate_id:proof.candidate_id,generation:proof.generation,attempt_id:proof.attempt_id,incarnation_id:proof.incarnation_id,input_sha256:inputHash,profile_sha256:scope.profileSha256},action:f.input.action,access:'read',attemptDeadlineMs:Date.now()+60000},Date.now());await createAgentGateway({...opts,capabilities}).readSource(token,proof.attempt_id,'plan')}
 const body:RuntimeStopObservationBody={version:1,slotId:f.jobSlot.id,binding:{requestId:r.id,candidateId:proof.candidate_id,generation:proof.generation,attemptId:proof.attempt_id,incarnationId:proof.incarnation_id,scope},runtimeBootId:'vm-boot',observer:`broker:${f.jobSlot.id}`,observedAt:new Date().toISOString(),commands:[{command:'stop',succeeded:true}],containerId:scope.scopeId,pid:0,running:false,status:options.prepared?'created':'exited'}
 const artifacts=createDispatchArtifacts(opts),stop=await artifacts.stageSupervisorStop(f.actor,{...body,sha256:artifactHash(canonicalRuntimeStopObservation(body))})
 return {f,opts,requests,proof,stop,artifacts,scope,body,attempts,session,completion:createDispatchCompletion(opts),cancel:createDispatchCancellation(opts)}
}
