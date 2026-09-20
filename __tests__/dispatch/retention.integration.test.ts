import {beforeEach,afterEach,it,expect} from 'vitest'
import {Pool} from 'pg'
import {randomUUID} from 'node:crypto'
import {makeDispatchHarness,type DispatchHarness} from './harness.js'
import {running} from './lifecycle-fixtures.js'
import {createDispatchDelivery} from '../../src/dispatch/delivery.js'
import {recoverForgottenReplyReads,retainTerminalDispatchThreads} from '../../src/dispatch/projection.js'
import {createDispatchRecovery} from '../../src/dispatch/recovery.js'
import {assertDispatchTestUrl} from '../../scripts/dispatch-test-db.mjs'
let h:DispatchHarness,projector:Pool
// Managed rows outlive their fixture: the guards refuse even the admin. Like the harness, clear them with
// triggers disabled so that every count below is about this test's own thread.
async function purge(){const c=await h.admin.connect();try{await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");await c.query('DELETE FROM agent_message WHERE dispatch_request_id IS NOT NULL');await c.query('DELETE FROM agent_message_archive WHERE dispatch_request_id IS NOT NULL');await c.query('COMMIT')}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
beforeEach(async()=>{h=await makeDispatchHarness();projector=new Pool({connectionString:assertDispatchTestUrl(process.env.DISPATCH_TEST_PROJECTOR_URL).href,max:2});await purge()})
afterEach(async()=>{await purge();await projector.end();await h.close()})
const result={version:1 as const,outcome:'succeeded' as const,summary:'Done',report_markdown:'Final result',checks:[]}
async function delivered(){
 const x=await running(h);await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop);await x.completion.acceptDispatchResult(x.f.actor,x.proof,result)
 await createDispatchDelivery({store:h.dispatch,queue:projector}).deliverDispatchOutbox(25)
 const ids=(await h.dispatch.query('SELECT root_message_id root,reply_message_id reply FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0] as {root:string;reply:string}
 return {x,id:x.proof.request_id,...ids}
}
const hot=async(id:string)=>(await h.admin.query('SELECT to_jsonb(m) AS row FROM agent_message m WHERE dispatch_request_id=$1 ORDER BY dispatch_role',[id])).rows.map(r=>r.row)
const cold=async(id:string)=>(await h.admin.query('SELECT to_jsonb(m) AS row FROM agent_message_archive m WHERE dispatch_request_id=$1 ORDER BY dispatch_role',[id])).rows.map(r=>r.row)
const acknowledge=(reply:string)=>h.queue.query("UPDATE agent_message SET status='done',finished_at=now() WHERE id=$1",[reply])

it('makes a forgotten reply claim readable again after four hours and changes nothing else',async()=>{
 const m=await delivered(),ordinary=randomUUID()
 await h.queue.query("UPDATE agent_message SET status='claimed',claimed_by='cli:forgotten',claimed_at=now()-interval '5 hours',started_at=now()-interval '5 hours' WHERE id=$1",[m.reply])
 await h.queue.query("INSERT INTO agent_message(id,type,from_server,from_model,to_server,to_model,body,source,status,claimed_by,claimed_at) VALUES($1,'task','mac','jp','mac','codex','ordinary','cli','claimed','cli:dead',now()-interval '5 hours')",[ordinary])
 try{
  const before=(await h.dispatch.query('SELECT state,version::text v,result_id FROM queue_dispatch_requests WHERE id=$1',[m.id])).rows[0]
  expect(await recoverForgottenReplyReads(projector)).toEqual([m.reply])
  const [root,reply]=(await hot(m.id)).sort((a,b)=>a.dispatch_role<b.dispatch_role?1:-1)
  expect(reply).toMatchObject({id:m.reply,status:'pending',claimed_by:null,claimed_at:null,started_at:null,finished_at:null,body:'Final result'});expect(root.status).toBe('done')
  expect((await h.admin.query('SELECT status FROM agent_message WHERE id=$1',[ordinary])).rows[0].status).toBe('claimed')
  expect((await h.dispatch.query('SELECT state,version::text v,result_id FROM queue_dispatch_requests WHERE id=$1',[m.id])).rows[0]).toEqual(before)
  expect(await recoverForgottenReplyReads(projector)).toEqual([])
 }finally{await h.admin.query('DELETE FROM agent_message WHERE id=$1',[ordinary])}
})
it('leaves a recent reply claim alone',async()=>{
 const m=await delivered()
 await h.queue.query("UPDATE agent_message SET status='claimed',claimed_by='cli:reading',claimed_at=now()-interval '1 hour',started_at=now() WHERE id=$1",[m.reply])
 expect(await recoverForgottenReplyReads(projector)).toEqual([])
})
it('archives a terminal thread before deleting it, byte for byte, and a retry is a no-op',async()=>{
 const m=await delivered();await acknowledge(m.reply)
 const before=await hot(m.id);expect(before).toHaveLength(2)
 expect(await retainTerminalDispatchThreads({store:h.dispatch,queue:projector},{olderThan:'0 seconds',limit:25})).toEqual({archived:1,refused:0})
 expect(await hot(m.id)).toEqual([]);expect(await cold(m.id)).toEqual(before)
 expect(await retainTerminalDispatchThreads({store:h.dispatch,queue:projector},{olderThan:'0 seconds',limit:25})).toEqual({archived:0,refused:0})
 expect(await cold(m.id)).toEqual(before)
})
it('keeps a thread whose answer is still unread, and one that is younger than the retention period',async()=>{
 const m=await delivered()
 expect(await retainTerminalDispatchThreads({store:h.dispatch,queue:projector},{olderThan:'0 seconds',limit:25})).toEqual({archived:0,refused:0})
 await acknowledge(m.reply)
 expect(await retainTerminalDispatchThreads({store:h.dispatch,queue:projector},{olderThan:'30 days',limit:25})).toEqual({archived:0,refused:0})
 expect(await hot(m.id)).toHaveLength(2);expect(await cold(m.id)).toEqual([])
})
it('refuses the whole thread when an archive id already holds something else',async()=>{
 const m=await delivered();await acknowledge(m.reply);const before=await hot(m.id)
 const c=await h.admin.connect()
 try{await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");await c.query("INSERT INTO agent_message_archive SELECT (jsonb_populate_record(NULL::agent_message_archive,to_jsonb(a)||'{\"body\":\"something else\"}'::jsonb)).* FROM agent_message a WHERE a.id=$1",[m.reply]);await c.query('COMMIT')}finally{c.release()}
 expect(await retainTerminalDispatchThreads({store:h.dispatch,queue:projector},{olderThan:'0 seconds',limit:25})).toEqual({archived:0,refused:1})
 expect(await hot(m.id)).toEqual(before);expect((await cold(m.id)).map(r=>r.body)).toEqual(['something else'])
})
it('leaves the hot thread intact when the projector may not insert into the archive',async()=>{
 const m=await delivered();await acknowledge(m.reply);const before=await hot(m.id)
 await h.admin.query('REVOKE INSERT ON agent_message_archive FROM s4m_dispatch_projector')
 try{
  expect(await retainTerminalDispatchThreads({store:h.dispatch,queue:projector},{olderThan:'0 seconds',limit:25})).toEqual({archived:0,refused:1})
  expect(await hot(m.id)).toEqual(before);expect(await cold(m.id)).toEqual([])
 }finally{await h.admin.query('GRANT INSERT ON agent_message_archive TO s4m_dispatch_projector')}
})
it('keeps the thread of a request that went through recovery',async()=>{
 const x=await running(h),recovery=createDispatchRecovery(x.opts)
 await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1",[x.proof.attempt_id]);await x.attempts.markExpiredAttempts()
 const v=await x.requests.getDispatch(x.f.actor,x.proof.request_id);await recovery.recoverDispatch(x.f.actor,v.id,randomUUID(),v.version,x.stop,'close_failed')
 await createDispatchDelivery({store:h.dispatch,queue:projector}).deliverDispatchOutbox(25)
 const reply=(await h.dispatch.query('SELECT reply_message_id id FROM queue_dispatch_requests WHERE id=$1',[v.id])).rows[0].id;await acknowledge(reply)
 expect(await retainTerminalDispatchThreads({store:h.dispatch,queue:projector},{olderThan:'0 seconds',limit:25})).toEqual({archived:0,refused:0})
 expect(await hot(v.id)).toHaveLength(2)
})
