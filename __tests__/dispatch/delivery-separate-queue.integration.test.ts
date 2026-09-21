import {beforeEach,afterEach,it,expect} from 'vitest'
import {makeDispatchHarness,type DispatchHarness} from './harness.js'
import {running} from './lifecycle-fixtures.js'
import {makeQueueDatabase} from './queue-db.js'
import {createDispatchDelivery} from '../../src/dispatch/delivery.js'
let h:DispatchHarness,q:Awaited<ReturnType<typeof makeQueueDatabase>>
beforeEach(async()=>{h=await makeDispatchHarness();q=await makeQueueDatabase()})
afterEach(async()=>{await q?.close();await h.close()})
const result={version:1 as const,outcome:'succeeded' as const,summary:'Done',report_markdown:'Final result',checks:[]}
async function finished(){const x=await running(h);await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop);await x.completion.acceptDispatchResult(x.f.actor,x.proof,result);return x}
const thread=async(id:string)=>(await q.admin.query('SELECT to_jsonb(m) AS row FROM agent_message m WHERE dispatch_request_id=$1 ORDER BY dispatch_role DESC',[id])).rows.map(r=>r.row)
const execution=async(id:string)=>(await h.dispatch.query(`SELECT r.state,r.version::text v,r.generation,r.result_id,
  (SELECT count(*)::int FROM queue_dispatch_candidates c WHERE c.request_id=r.id) candidates,
  (SELECT count(*)::int FROM queue_dispatch_attempts a JOIN queue_dispatch_candidates c ON c.id=a.candidate_id WHERE c.request_id=r.id) attempts,
  (SELECT count(*)::int FROM claude_jobs j WHERE j.dispatch_request_id=r.id) jobs,
  (SELECT count(*)::int FROM queue_dispatch_events e WHERE e.request_id=r.id) events FROM queue_dispatch_requests r WHERE r.id=$1`,[id])).rows[0]

it('projects into a queue database that is not the dispatch database',async()=>{
 const x=await finished(),delivery=createDispatchDelivery({store:h.dispatch,queue:q.projector})
 expect(await delivery.deliverDispatchOutbox(25)).toMatchObject({delivered:1,failed:0})
 expect((await thread(x.proof.request_id)).map(m=>[m.dispatch_role,m.status])).toEqual([['ROOT','done'],['REPLY','pending']])
 // Nothing leaked into the dispatch database's own copy of the table.
 expect((await h.admin.query('SELECT count(*)::int n FROM agent_message WHERE dispatch_request_id=$1',[x.proof.request_id])).rows[0].n).toBe(0)
})
it('a real queue outage delays delivery and nothing else, and delivery resumes by itself',async()=>{
 const x=await finished(),delivery=createDispatchDelivery({store:h.dispatch,queue:q.projector,random:()=>0}),before=await execution(x.proof.request_id)
 await q.setAvailable(false)
 expect(await delivery.deliverDispatchOutbox(25)).toEqual({delivered:0,failed:1})
 expect(await execution(x.proof.request_id)).toEqual(before)
 expect((await x.requests.getDispatch(x.f.actor,x.proof.request_id)).delivery).toBe('pending')
 await q.setAvailable(true)
 await h.dispatch.query('UPDATE queue_dispatch_outbox SET next_attempt_at=now() WHERE request_id=$1',[x.proof.request_id])
 expect(await delivery.deliverDispatchOutbox(25)).toMatchObject({delivered:1,failed:0})
 expect(await thread(x.proof.request_id)).toHaveLength(2);expect(await execution(x.proof.request_id)).toEqual(before)
})
it('restores a lost conversation from the outbox without starting any execution',async()=>{
 const x=await finished(),delivery=createDispatchDelivery({store:h.dispatch,queue:q.projector}),id=x.proof.request_id
 await delivery.deliverDispatchOutbox(25)
 const original=await thread(id),before=await execution(id);expect(original).toHaveLength(2)
 // The queue database is restored from a backup that predates the conversation.
 await q.admin.query("SET session_replication_role='replica'");await q.admin.query('DELETE FROM agent_message');await q.admin.query("SET session_replication_role='origin'")
 expect(await thread(id)).toEqual([])
 // The documented operator step: mark the newest snapshot of the request undelivered. Nothing else is touched.
 await h.dispatch.query('UPDATE queue_dispatch_outbox SET published_at=NULL,next_attempt_at=now() WHERE request_id=$1 AND version=(SELECT max(version) FROM queue_dispatch_outbox WHERE request_id=$1)',[id])
 expect(await delivery.deliverDispatchOutbox(25)).toMatchObject({delivered:1,failed:0})
 const restored=await thread(id),stable=(m:Record<string,unknown>)=>{const {created_at:_c,claimed_at:_a,finished_at:_f,...rest}=m;return rest}
 expect(restored.map(stable)).toEqual(original.map(stable))
 // Same ids, same bodies, same pins — and no candidate, attempt, job or lifecycle event came into being.
 expect(await execution(id)).toEqual(before)
})
