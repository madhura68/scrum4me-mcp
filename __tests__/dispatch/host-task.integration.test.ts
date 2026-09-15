import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {randomUUID,generateKeyPairSync} from 'node:crypto'
import {PrismaClient} from '@prisma/client'
import {PrismaPg} from '@prisma/adapter-pg'
import {makeDispatchHarness,type DispatchHarness,type DispatchHarnessSeed} from './harness.js'
import {createDispatchAuth} from '../../src/dispatch/auth.js'
import {createDispatchRequests} from '../../src/dispatch/requests.js'
import {createReadyFixtureSelection as createDispatchSelection} from './source-fixtures.js'
import {createDispatchAttempts} from '../../src/dispatch/attempts.js'
import {createDispatchRegistration} from '../../src/dispatch/registration.js'
import type {DispatchInput} from '@shared/queue-dispatch.js'
const holder=vi.hoisted(()=>({db:null as unknown as PrismaClient,actor:null as unknown as {userId:string;tokenId:string}}))
vi.mock('../../src/prisma.js',()=>({get prisma(){return holder.db}}))
vi.mock('../../src/auth.js',async original=>({...await original<typeof import('../../src/auth.js')>(),requireWriteAccess:async()=>holder.actor}))
import {dispatchTaskImplementation} from '../../src/lib/dispatch/task-implementation.js'
import {backupPushOnFailure,prepareDoneUpdate,cleanupWorktreeForTerminalStatus,maybeCreateAutoPr,maybeCreateSprintBatchPr,runDeferredWorktreeCleanup} from '../../src/tools/update-job-status.js'
import {getFullJobContext,rollbackClaim,markJobTerminallyFailed} from '../../src/tools/wait-for-job.js'
import {setupProductWorktrees} from '../../src/git/job-locks.js'
import {handleUpdateTaskStatus} from '../../src/tools/update-task-status.js'
let h:DispatchHarness,f:DispatchHarnessSeed,input:DispatchInput,task:string
let selection:ReturnType<typeof createDispatchSelection>,attempts:ReturnType<typeof createDispatchAttempts>,requests:ReturnType<typeof createDispatchRequests>,session:{incarnation_id:string;session_credential:string}
const scope={scopeId:'host-task',bootId:'boot-host',imageDigest:`sha256:${'a'.repeat(64)}`,profileSha256:'e'.repeat(64)}
beforeEach(async()=>{
 h=await makeDispatchHarness();f=await h.seed();holder.db=new PrismaClient({adapter:new PrismaPg(h.web)});holder.actor={userId:f.actor.userId,tokenId:f.actor.tokenId!}
 const auth=createDispatchAuth({store:h.dispatch}),opts={store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]}
 selection=createDispatchSelection(opts);requests=createDispatchRequests(opts);attempts=createDispatchAttempts({...opts,credentialKeys:{1:Buffer.alloc(32,8)},keyVersion:1,startPermitPrivateKey:generateKeyPairSync('ed25519').privateKey})
 const pbi=randomUUID(),story=randomUUID(),profileId=randomUUID();task=randomUUID()
 await h.admin.query("UPDATE products SET repo_url='https://forge.test/repo.git' WHERE id=$1",[f.input.product_id])
 await h.admin.query("INSERT INTO pbis(id,product_id,code,title,priority,sort_order,updated_at) VALUES($1,$2,'PBI-1','PBI',1,1,now())",[pbi,f.input.product_id])
 await h.admin.query("INSERT INTO stories(id,pbi_id,product_id,code,title,acceptance_criteria,priority,sort_order,updated_at) VALUES($1,$2,$3,'ST-1','Story','accepted',1,1,now())",[story,pbi,f.input.product_id])
 await h.admin.query("INSERT INTO tasks(id,story_id,product_id,code,title,implementation_plan,priority,sort_order,updated_at) VALUES($1,$2,$3,'T-1','Task','accepted plan',1,1,now())",[task,story,f.input.product_id])
 const profile=(await h.dispatch.query('SELECT config FROM queue_dispatch_profiles WHERE id=$1',[f.profileId])).rows[0].config
 await h.dispatch.query('INSERT INTO queue_dispatch_profiles(id,key,revision,product_id,owner_user_id,config,sha256) VALUES($1::uuid,$1::text,1,$2,$3,$4,$5)',[profileId,f.input.product_id,f.actor.userId,{...profile,actions:['task_implementation'],access:'repo_write',repository_product_ids:[f.input.product_id],publish_modes:['branch']},scope.profileSha256])
 await h.dispatch.query('INSERT INTO queue_dispatch_slot_profiles(slot_id,profile_revision_id) VALUES($1,$2)',[f.hostSlot.id,profileId])
 await h.dispatch.query("UPDATE queue_dispatch_slots SET config=jsonb_set(config,'{capabilities}','[\"code_edit\"]') WHERE id=$1",[f.hostSlot.id])
 await h.dispatch.query('UPDATE queue_dispatch_slots SET enabled=false WHERE id=$1',[f.jobSlot.id])
 session=await createDispatchRegistration({store:h.dispatch,auth,credentialKeys:{1:Buffer.alloc(32,7)},keyVersion:1}).registerDispatchExecutor(f.actor,{slot_id:f.hostSlot.id,registration_key:'task-host',boot_id:scope.bootId,runtime:'CODEX',image_digest:scope.imageDigest,profile_sha256:scope.profileSha256})
 input={...f.input,action:'task_implementation',task_id:task,publish:'branch',requirements:{access:'repo_write',environment_keys:[],repository:{product_id:f.input.product_id,base_sha:'a'.repeat(40)}}}
})
afterEach(async()=>{await holder.db?.$disconnect();await h?.close()})
const ordinary=()=>dispatchTaskImplementation({taskId:task,productId:f.input.product_id,userId:f.actor.userId},{db:holder.db,notify:async()=>{}})
async function reserved(){const r=await requests.submitDispatch(f.actor,input,'host-task');expect(await selection.reserveRequest(r.id)).toBe(r.id);return r}
async function started(){const r=await reserved();const receipt=await attempts.claimDispatchAttempt(f.actor,session.incarnation_id,'task-claim',session.session_credential);expect(receipt?.authority).toBe('prepare');if(!receipt?.context)throw Error('missing host task');await attempts.startDispatchAttempt(f.actor,receipt.context.proof,scope);return r}
it('excludes ordinary enqueue after actual host Task reserve, claim and start',async()=>{
 await started();expect((await h.dispatch.query('SELECT count(*)::int n FROM claude_jobs')).rows[0].n).toBe(0)
 await expect(ordinary()).rejects.toThrow('DISPATCH_MANAGED_ROW')
})
it('refuses general Task status mutation while the host owns its Task',async()=>{
 await started();const result=await handleUpdateTaskStatus({task_id:task,status:'in_progress'})
 expect(result).toMatchObject({isError:true});expect(JSON.stringify(result)).toContain('DISPATCH_MANAGED_ROW')
 expect((await h.web.query('SELECT status FROM tasks WHERE id=$1',[task])).rows[0].status).toBe('TO_DO')
})
it('serializes actual host selection and ordinary enqueue over independent connections',async()=>{
 const r=await requests.submitDispatch(f.actor,input,'race'),barrier=h.barrier(2)
 await Promise.allSettled([barrier().then(()=>selection.reserveRequest(r.id)),barrier().then(ordinary)])
 const occupied=(await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_reservations WHERE released_at IS NULL')).rows[0].n
 const jobs=(await h.web.query("SELECT count(*)::int n FROM claude_jobs WHERE task_id=$1 AND status IN ('QUEUED','CLAIMED','RUNNING')",[task])).rows[0].n
 expect(occupied+jobs).toBe(1)
})
it('leaves host waiting when ordinary Task work already owns execution',async()=>{
 const r=await requests.submitDispatch(f.actor,input,'ordinary-first');await ordinary()
 expect(await selection.reserveRequest(r.id)).toBeNull()
 expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_reservations')).rows[0].n).toBe(0)
})
it('restores ordinary enqueue after legitimate unclaimed host retirement',async()=>{
 const r=await reserved(),c=await h.admin.connect()
 try{await c.query('BEGIN');await c.query('SET LOCAL session_replication_role=replica');await c.query("UPDATE queue_dispatch_candidates SET deadline=now()-interval '1 second' WHERE request_id=$1",[r.id]);await c.query('COMMIT')}finally{c.release()}
 expect(await selection.retireExpiredCandidate(r.id)).toBe(true)
 expect((await h.web.query('SELECT dispatch_request_id FROM tasks WHERE id=$1',[task])).rows[0].dispatch_request_id).toBeNull()
 await expect(ordinary()).resolves.toHaveProperty('job_id')
})
it('never releases host Task binding when heartbeat or maximum duration expires',async()=>{
 const r=await started()
 await h.dispatch.query("UPDATE queue_dispatch_attempts SET started_at=now()-interval '301 seconds' WHERE candidate_id IN (SELECT id FROM queue_dispatch_candidates WHERE request_id=$1)",[r.id])
 await attempts.markExpiredAttempts()
 expect((await requests.getDispatch(f.actor,r.id)).state).toBe('CANCEL_REQUESTED')
 await expect(ordinary()).rejects.toThrow('DISPATCH_MANAGED_ROW')
 await expect(h.web.query('UPDATE tasks SET dispatch_request_id=NULL WHERE id=$1',[task])).rejects.toMatchObject({code:'42501'})
 await expect(h.dispatch.query('UPDATE tasks SET dispatch_request_id=NULL WHERE id=$1',[task])).rejects.toMatchObject({code:'42501'})
})

it('blocks older unbound Task jobs and sprint executions before ordinary effects',async()=>{
 const oldJob=randomUUID(),batchJob=randomUUID(),execution=randomUUID()
 for(const [id,taskId,kind] of [[oldJob,task,'TASK_IMPLEMENTATION'],[batchJob,null,'SPRINT_IMPLEMENTATION']])await h.web.query("INSERT INTO claude_jobs(id,user_id,product_id,task_id,kind,source,status,branch,updated_at) VALUES($1,$2,$3,$4,$5::\"ClaudeJobKind\",$6,'DONE','feat/old',now())",[id,f.actor.userId,f.input.product_id,taskId,kind,taskId?'COPILOT':'MANUAL'])
 await h.web.query(`INSERT INTO sprint_task_executions(id,sprint_job_id,task_id,"order",plan_snapshot,verify_required_snapshot,status,updated_at) VALUES($1,$2,$3,0,'old plan','ALIGNED_OR_PARTIAL','DONE',now())`,[execution,batchJob,task])
 await h.web.query("UPDATE tasks SET status='TO_DO' WHERE id=$1",[task])
 await h.admin.query('UPDATE products SET auto_pr=true WHERE id=$1',[f.input.product_id])
 await started()
 for(const id of [oldJob,batchJob]){
  const pr={jobId:id,productId:f.input.product_id,taskId:task,worktreePath:'/nonexistent-dispatch-test',branchName:'feat/old',summary:undefined}
  for(const operation of [()=>prepareDoneUpdate(id,'feat/old'),()=>backupPushOnFailure(id,'feat/old'),()=>cleanupWorktreeForTerminalStatus(f.input.product_id,id,'done','feat/old'),()=>maybeCreateAutoPr(pr),()=>maybeCreateSprintBatchPr(pr),()=>runDeferredWorktreeCleanup(id),()=>getFullJobContext(id),()=>rollbackClaim(id,null),()=>markJobTerminallyFailed(id,'old'),()=>setupProductWorktrees(id,[f.input.product_id],async()=>{throw Error('unexpected effect')})])await expect(operation()).rejects.toThrow('DISPATCH_MANAGED_ROW')
 }
 await expect(h.web.query("UPDATE sprint_task_executions SET status='RUNNING' WHERE id=$1",[execution])).rejects.toMatchObject({code:'42501',message:'DISPATCH_MANAGED_ROW'})
 await expect(h.web.query(`INSERT INTO sprint_task_executions(id,sprint_job_id,task_id,"order",plan_snapshot,verify_required_snapshot,updated_at) VALUES($1,$2,$3,0,'new plan','ALIGNED_OR_PARTIAL',now())`,[randomUUID(),oldJob,task])).rejects.toMatchObject({code:'42501',message:'DISPATCH_MANAGED_ROW'})
})
