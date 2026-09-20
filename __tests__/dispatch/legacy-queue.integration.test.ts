import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {Pool} from 'pg'
import {randomUUID} from 'node:crypto'
import {PrismaClient} from '@prisma/client'
import {PrismaPg} from '@prisma/adapter-pg'
import {makeDispatchHarness,type DispatchHarness} from './harness.js'
import {running} from './lifecycle-fixtures.js'
import {createDispatchDelivery} from '../../src/dispatch/delivery.js'
import {assertDispatchTestUrl} from '../../scripts/dispatch-test-db.mjs'
const holder=vi.hoisted(()=>({db:null as unknown}))
vi.mock('../../src/prisma.js',()=>({get prisma(){return holder.db}}))
let h:DispatchHarness,projector:Pool
beforeEach(async()=>{h=await makeDispatchHarness();projector=new Pool({connectionString:assertDispatchTestUrl(process.env.DISPATCH_TEST_PROJECTOR_URL).href,max:2});holder.db=new PrismaClient({adapter:new PrismaPg(h.queue)})})
afterEach(async()=>{await (holder.db as PrismaClient).$disconnect();await projector.end();await h.close()})
const result={version:1 as const,outcome:'succeeded' as const,summary:'Done',report_markdown:'Final result',checks:[]}
/** A delivered terminal thread whose reply a CLI reader claimed five hours ago and then forgot. */
async function forgottenReply(){
 const x=await running(h);await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop);await x.completion.acceptDispatchResult(x.f.actor,x.proof,result)
 await createDispatchDelivery({store:h.dispatch,queue:projector}).deliverDispatchOutbox(25)
 const ids=(await h.dispatch.query('SELECT root_message_id root,reply_message_id reply FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0]
 await h.queue.query("UPDATE agent_message SET status='claimed',claimed_by='cli:forgotten',claimed_at=now()-interval '5 hours',started_at=now()-interval '5 hours' WHERE id=$1",[ids.reply])
 return {x,...ids as {root:string;reply:string}}
}
const row=async(id:string)=>(await h.admin.query('SELECT status,claimed_by,body FROM agent_message WHERE id=$1',[id])).rows[0]

it('the ordinary stale sweep requeues ordinary work and leaves a forgotten managed reply alone instead of rolling back',async()=>{
 const m=await forgottenReply(),ordinary=randomUUID()
 await h.queue.query("INSERT INTO agent_message(id,type,from_server,from_model,to_server,to_model,body,source,status,claimed_by,claimed_at) VALUES($1,'task','mac','jp','mac','codex','ordinary','cli','claimed','cli:dead',now()-interval '5 hours')",[ordinary])
 try{
  const {sweepStaleQueueClaims}=await import('../../src/queue/sweep.js')
  const swept=await sweepStaleQueueClaims()
  expect(swept.requeued).toContain(ordinary);expect(swept.requeued).not.toContain(m.reply)
  expect(await row(ordinary)).toMatchObject({status:'pending',claimed_by:null})
  expect(await row(m.reply)).toMatchObject({status:'claimed',claimed_by:'cli:forgotten',body:'Final result'})
 }finally{await h.admin.query('DELETE FROM agent_message WHERE id=$1',[ordinary])}
})
it('request claiming and claim rollback never touch a managed row',async()=>{
 const m=await forgottenReply(),{claimNextRequest,rollbackQueueClaim}=await import('../../src/queue/claim.js')
 expect(await claimNextRequest({server:'mac',model:'jp',claimedBy:'mcp:test'})).toBeNull()
 await expect(rollbackQueueClaim(m.reply,'cli:forgotten')).resolves.toBeUndefined()
 expect(await row(m.reply)).toMatchObject({status:'claimed',claimed_by:'cli:forgotten'})
 expect((await row(m.root)).status).toBe('done')
})
it('the final answer stays readable and acknowledgeable through the ordinary reply inbox',async()=>{
 const x=await running(h);await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop);await x.completion.acceptDispatchResult(x.f.actor,x.proof,result)
 await createDispatchDelivery({store:h.dispatch,queue:projector}).deliverDispatchOutbox(25)
 const ids=(await h.dispatch.query('SELECT root_message_id root,reply_message_id reply FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0]
 const {claimNextReply}=await import('../../src/queue/claim.js')
 // Reading the answer is the deliberate exception: it is addressed to the sender and acknowledging it changes nothing else.
 const read=await claimNextReply({server:'mac',model:'jp',messageIds:[ids.root],claimedBy:'mcp:reader'})
 expect(read).toMatchObject({id:ids.reply,type:'result',status:'done',body:'Final result',previous_status:'pending'})
 expect(await claimNextReply({server:'mac',model:'jp',messageIds:[ids.root],claimedBy:'mcp:reader'})).toBeNull()
})
it('archives a fully terminal managed thread by changing archived_at alone, and refuses an active one as a whole',async()=>{
 const x=await running(h),delivery=createDispatchDelivery({store:h.dispatch,queue:projector}),{archiveQueueSubtree,unarchiveQueueSubtree}=await import('../../src/tools/queue-archive.js')
 await delivery.deliverDispatchOutbox(25)
 const ids=(await h.dispatch.query('SELECT root_message_id root,reply_message_id reply FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0]
 // Still running: refused before any write, for archive and for unarchive alike.
 for(const run of [archiveQueueSubtree,unarchiveQueueSubtree]){const refused=await run(ids.root);expect(refused.isError).toBe(true);expect(JSON.stringify(refused)).toContain('QUEUE_MANAGED_NOT_TERMINAL')}
 await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop);await x.completion.acceptDispatchResult(x.f.actor,x.proof,result);await delivery.deliverDispatchOutbox(25)
 // Terminal root, but the answer is unread: still one thread, still refused as a whole.
 expect(JSON.stringify(await archiveQueueSubtree(ids.root))).toContain('QUEUE_MANAGED_NOT_TERMINAL')
 expect((await h.admin.query('SELECT count(*)::int n FROM agent_message WHERE dispatch_request_id=$1 AND archived_at IS NOT NULL',[x.proof.request_id])).rows[0].n).toBe(0)
 await h.queue.query("UPDATE agent_message SET status='done',finished_at=now() WHERE id=$1",[ids.reply])
 const snapshot=async()=>(await h.admin.query("SELECT to_jsonb(m)-'archived_at' AS row FROM agent_message m WHERE dispatch_request_id=$1 ORDER BY dispatch_role",[x.proof.request_id])).rows
 const before=await snapshot(),archived=await archiveQueueSubtree(ids.root)
 const body=(r:{content:Array<{type:string;text?:string}>})=>JSON.parse(r.content[0].text!)
 expect(archived.isError).toBeFalsy();expect(body(archived)).toMatchObject({total:2,archived:2})
 expect(await snapshot()).toEqual(before)
 expect((await h.admin.query('SELECT count(*)::int n FROM agent_message WHERE dispatch_request_id=$1 AND archived_at IS NOT NULL',[x.proof.request_id])).rows[0].n).toBe(2)
 expect(body(await unarchiveQueueSubtree(ids.root))).toMatchObject({total:2,unarchived:2});expect(await snapshot()).toEqual(before)
})
