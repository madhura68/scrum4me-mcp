import {it,expect} from 'vitest'
import {randomUUID,generateKeyPairSync} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {makeDispatchHarness} from './harness.js'
import {createDispatchAuth} from '../../src/dispatch/auth.js'
import {createDispatchRequests} from '../../src/dispatch/requests.js'
import {createDispatchSources} from '../../src/dispatch/sources.js'
import {createDispatchSelection} from '../../src/dispatch/selection.js'
import {createDispatchRegistration} from '../../src/dispatch/registration.js'
import {createDispatchAttempts} from '../../src/dispatch/attempts.js'
import {createDispatchArtifacts,artifactHash} from '../../src/dispatch/artifacts.js'
import {createDispatchCompletion} from '../../src/dispatch/completion.js'
import {createDispatchPublication,createGitPublicationPort} from '../../src/dispatch/publication.js'
import {canonicalRuntimeStopObservation,type RuntimeStopObservationBody} from '@shared/queue-dispatch-runtime-observation.js'
import {isolatedGit,createCodeArtifact} from '../../src/dispatch/workspace.js'
import type {DispatchInput,DispatchResult} from '@shared/queue-dispatch.js'
export async function codeAttempt(h:Awaited<ReturnType<typeof makeDispatchHarness>>,root:string,options:{verifyOnly?:boolean;change?:boolean;free?:boolean}={}){
 const verifyOnly=options.verifyOnly??false
  const f=await h.seed(),auth=createDispatchAuth({store:h.dispatch}),opts={store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]},pbi=randomUUID(),story=randomUUID(),task=randomUUID(),profileId=randomUUID(),repo=join(root,'repo')
  await mkdir(repo);await isolatedGit(repo,['init','-b','main']);await isolatedGit(repo,['config','user.name','Fixture']);await isolatedGit(repo,['config','user.email','fixture@example.invalid']);await writeFile(join(repo,'file.txt'),'base\n');await isolatedGit(repo,['add','.']);await isolatedGit(repo,['commit','-m','base']);const baseSha=await isolatedGit(repo,['rev-parse','HEAD']);await isolatedGit(repo,['bundle','create',join(root,'base.bundle'),'HEAD']);const bundle=await readFile(join(root,'base.bundle'))
  await h.admin.query('UPDATE products SET repo_url=$2 WHERE id=$1',[f.input.product_id,repo]);await isolatedGit(repo,['remote','add','origin',repo])
  await h.admin.query("INSERT INTO pbis(id,product_id,code,title,priority,sort_order,updated_at) VALUES($1,$2,'PBI-1','PBI',1,1,now())",[pbi,f.input.product_id])
  await h.admin.query("INSERT INTO stories(id,pbi_id,product_id,code,title,acceptance_criteria,priority,sort_order,updated_at) VALUES($1,$2,$3,'ST-1','Story','accepted',1,1,now())",[story,pbi,f.input.product_id])
  await h.admin.query("INSERT INTO tasks(id,story_id,product_id,code,title,implementation_plan,verify_only,priority,sort_order,updated_at) VALUES($1,$2,$3,'T-1','Task','Change `file.txt`',$4,1,1,now())",[task,story,f.input.product_id,verifyOnly])
  const config=(await h.dispatch.query('SELECT config FROM queue_dispatch_profiles WHERE id=$1',[f.profileId])).rows[0].config,profileSha256='e'.repeat(64),imageDigest=`sha256:${'a'.repeat(64)}`
  await h.dispatch.query('INSERT INTO queue_dispatch_profiles(id,key,revision,product_id,owner_user_id,config,sha256) VALUES($1::uuid,$1::text,1,$2,$3,$4,$5)',[profileId,f.input.product_id,f.actor.userId,{...config,actions:options.free?['free_task']:['task_implementation'],access:'repo_write',repository_product_ids:[f.input.product_id],publish_modes:['branch']},profileSha256])
  await h.dispatch.query('INSERT INTO queue_dispatch_slot_profiles(slot_id,profile_revision_id) VALUES($1,$2)',[f.hostSlot.id,profileId]);await h.dispatch.query("UPDATE queue_dispatch_slots SET config=jsonb_set(config,'{capabilities}','[\"code_edit\"]') WHERE id=$1",[f.hostSlot.id]);await h.dispatch.query('UPDATE queue_dispatch_slots SET enabled=false WHERE id=$1',[f.jobSlot.id])
  const session=await createDispatchRegistration({...opts,credentialKeys:{1:Buffer.alloc(32,7)},keyVersion:1}).registerDispatchExecutor(f.actor,{slot_id:f.hostSlot.id,registration_key:'task',boot_id:'boot',runtime:'CODEX',image_digest:imageDigest,profile_sha256:profileSha256})
  const input:DispatchInput={...f.input,action:options.free?'free_task':'task_implementation',...(options.free?{work_item:{task_id:task}}:{task_id:task}),publish:'branch',requirements:{access:'repo_write',environment_keys:[],repository:{product_id:f.input.product_id,base_sha:baseSha}}},r=await createDispatchRequests(opts).submitDispatch(f.actor,input,randomUUID()),branch=`codex/queue-${r.id}`
  await isolatedGit(repo,['checkout','-b',branch]);await createDispatchSources({...opts,fetchGit:async()=>({ok:false,reason:'network'}),prepareRepository:async()=>({bytes:bundle,repoUrl:repo,baseSha})}).prepareRequestSources(r.id);await createDispatchSelection(opts).reserveRequest(r.id)
  const attempts=createDispatchAttempts({...opts,credentialKeys:{1:Buffer.alloc(32,8)},keyVersion:1,startPermitPrivateKey:generateKeyPairSync('ed25519').privateKey}),claim=await attempts.claimDispatchAttempt(f.actor,session.incarnation_id,'task-claim',session.session_credential);if(!claim?.context)throw Error('claim required');const proof=claim.context.proof,scope={scopeId:randomUUID(),bootId:'boot',imageDigest,profileSha256};await attempts.startDispatchAttempt(f.actor,proof,scope)
  if(options.change){await writeFile(join(repo,'file.txt'),'changed\n');await isolatedGit(repo,['commit','-am','change'])}
  const headSha=await isolatedGit(repo,['rev-parse','HEAD'])
  const result:DispatchResult={version:1,outcome:'succeeded',summary:'Verified existing implementation against the fixed plan.',report_markdown:'Verification of existing implementation.',checks:[]},artifacts=createDispatchArtifacts(opts)
  const body:RuntimeStopObservationBody={version:1,slotId:f.hostSlot.id,binding:{requestId:r.id,candidateId:proof.candidate_id,generation:proof.generation,attemptId:proof.attempt_id,incarnationId:proof.incarnation_id,scope},runtimeBootId:'vm',observer:`broker:${f.hostSlot.id}`,observedAt:new Date().toISOString(),commands:[{command:'stop',succeeded:true}],containerId:scope.scopeId,pid:0,running:false,status:'exited'},stop=await artifacts.stageSupervisorStop(f.actor,{...body,sha256:artifactHash(canonicalRuntimeStopObservation(body))})
  await createDispatchCompletion(opts).verifyStopEvidence(f.actor,proof,stop)
  const bytes=await createCodeArtifact(repo,{repoUrl:repo,baseSha,headSha,branch,checks:result.checks})
  const artifactId=await artifacts.stageCollectedArtifact(f.actor,body.binding,'code',bytes,artifactHash(bytes));result.code={base_sha:baseSha,head_sha:headSha,branch,artifact_id:artifactId}
  const publisher=createDispatchPublication({...opts,loadBaseBranch:async()=> 'main',port:createGitPublicationPort({root:join(root,'publisher'),allowedProtocols:['file'],allowedHosts:[]})}),completion=createDispatchCompletion({...opts,publisher})
 return {h,f,opts,task,story,pbi,repo,proof,result,artifactId,stop,artifacts,publisher,completion}
}
