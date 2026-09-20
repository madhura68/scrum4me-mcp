import {beforeEach,afterEach,it,expect} from 'vitest'
import {Pool,type PoolClient} from 'pg'
import {randomUUID} from 'node:crypto'
import {makeDispatchHarness,type DispatchHarness} from './harness.js'
import {running} from './lifecycle-fixtures.js'
import {createDispatchDelivery} from '../../src/dispatch/delivery.js'
import {applyDispatchProjection} from '../../src/dispatch/projection.js'
import {buildDispatchProjection} from '@shared/queue-dispatch-projection.js'
import {assertDispatchTestUrl} from '../../scripts/dispatch-test-db.mjs'
let h:DispatchHarness,projector:Pool
beforeEach(async()=>{h=await makeDispatchHarness();projector=new Pool({connectionString:assertDispatchTestUrl(process.env.DISPATCH_TEST_PROJECTOR_URL).href,max:4})})
afterEach(async()=>{await projector.end();await h.close()})
const messages=async(requestId:string)=>(await h.admin.query('SELECT id,type,status,body,meta,in_reply_to,to_server,to_model,from_server,from_model,dispatch_role,dispatch_projection_version::text AS version FROM agent_message WHERE dispatch_request_id=$1 ORDER BY dispatch_role DESC',[requestId])).rows
const result={version:1 as const,outcome:'succeeded' as const,summary:'Read-only work completed',report_markdown:'Final result',checks:[]}
async function finished(){const x=await running(h);await x.completion.verifyStopEvidence(x.f.actor,x.proof,x.stop);await x.completion.acceptDispatchResult(x.f.actor,x.proof,result);return x}
const withClient=async<T>(fn:(c:PoolClient)=>Promise<T>)=>{const c=await projector.connect();try{return await fn(c)}finally{c.release()}}

it('delivers the newest snapshot as one root, supersedes older versions, and adds nothing claimable',async()=>{
 const x=await running(h),delivery=createDispatchDelivery({store:h.dispatch,queue:projector})
 const pending=(await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_outbox WHERE request_id=$1 AND published_at IS NULL',[x.proof.request_id])).rows[0].n;expect(pending).toBeGreaterThan(1)
 expect(await delivery.deliverDispatchOutbox(25)).toMatchObject({delivered:1,failed:0})
 const rows=await messages(x.proof.request_id),version=(await h.dispatch.query('SELECT version::text v FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0].v
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({dispatch_role:'ROOT',status:'claimed',version,to_server:'scrum4me-dispatch',to_model:x.proof.request_id,in_reply_to:null})
 expect(rows[0].meta.dispatch).toMatchObject({request_id:x.proof.request_id,state:'RUNNING',projection_version:version})
 expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_outbox WHERE request_id=$1 AND published_at IS NULL',[x.proof.request_id])).rows[0].n).toBe(0)
 expect(await delivery.deliverDispatchOutbox(25)).toEqual({delivered:0,failed:0})
 expect((await x.requests.getDispatch(x.f.actor,x.proof.request_id)).delivery).toBe('delivered')
})
it('delivers exactly one reply after the root, and a replay never rewrites a reply its reader already handled',async()=>{
 const x=await finished(),delivery=createDispatchDelivery({store:h.dispatch,queue:projector})
 await delivery.deliverDispatchOutbox(25)
 const [root,reply]=await messages(x.proof.request_id)
 expect(root).toMatchObject({dispatch_role:'ROOT',status:'done'});expect(reply).toMatchObject({dispatch_role:'REPLY',type:'result',status:'pending',body:'Final result',in_reply_to:root.id,to_server:'mac',to_model:'jp',from_server:'scrum4me-dispatch'})
 // The reader acknowledges through the ordinary queue role; then the same snapshot is delivered again (lost ack).
 await h.queue.query("UPDATE agent_message SET status='done',finished_at=now() WHERE id=$1",[reply.id])
 await h.dispatch.query('UPDATE queue_dispatch_outbox SET published_at=NULL WHERE request_id=$1',[x.proof.request_id])
 expect(await delivery.deliverDispatchOutbox(25)).toMatchObject({delivered:1,failed:0})
 const again=await messages(x.proof.request_id);expect(again).toHaveLength(2)
 expect(again[1]).toMatchObject({id:reply.id,status:'done',body:'Final result'});expect(again[0]).toMatchObject({id:root.id,status:'done',version:root.version})
})
it('applies versions out of order without ever regressing the root',async()=>{
 const x=await running(h),r=(await h.dispatch.query('SELECT id,input,root_message_id,reply_message_id FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0]
 const at=(version:string,state:'WAITING'|'RESERVED'|'RUNNING')=>buildDispatchProjection({id:r.id,version,state,input:r.input,rootId:r.root_message_id,replyId:r.reply_message_id,route:'job',reason:state.toLowerCase()},null)
 for(const [version,state] of [['3','RUNNING'],['1','WAITING'],['2','RESERVED']] as const)await withClient(c=>applyDispatchProjection(c,at(version,state)))
 const rows=await messages(r.id);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({status:'claimed',version:'3'});expect(rows[0].meta.dispatch.state).toBe('RUNNING')
})
it('two projectors racing over the same outbox still produce one root and one reply',async()=>{
 const x=await finished(),a=createDispatchDelivery({store:h.dispatch,queue:projector}),b=createDispatchDelivery({store:h.dispatch,queue:projector})
 const barrier=h.barrier(2),outcomes=await Promise.all([barrier().then(()=>a.deliverDispatchOutbox(25)),barrier().then(()=>b.deliverDispatchOutbox(25))])
 expect(outcomes[0].failed+outcomes[1].failed).toBe(0);expect(outcomes[0].delivered+outcomes[1].delivered).toBe(1)
 expect((await messages(x.proof.request_id)).map(m=>m.dispatch_role)).toEqual(['ROOT','REPLY'])
})
it('refuses to adopt an id that already belongs to an ordinary message and leaves that message alone',async()=>{
 const x=await finished(),rootId=(await h.dispatch.query('SELECT root_message_id id FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0].id
 await h.queue.query("INSERT INTO agent_message(id,type,from_server,from_model,to_server,to_model,body,source,status) VALUES($1,'task','mac','jp','mac','codex','ordinary work','cli','pending')",[rootId])
 const delivery=createDispatchDelivery({store:h.dispatch,queue:projector,random:()=>0})
 expect(await delivery.deliverDispatchOutbox(25)).toEqual({delivered:0,failed:1})
 expect((await h.admin.query('SELECT body,dispatch_request_id FROM agent_message WHERE id=$1',[rootId])).rows[0]).toEqual({body:'ordinary work',dispatch_request_id:null})
 expect(await messages(x.proof.request_id)).toHaveLength(0)
 await h.admin.query('DELETE FROM agent_message WHERE id=$1',[rootId])
})
it('a queue outage backs off, reports failed after ten attempts, keeps retrying and never touches the result',async()=>{
 const x=await finished(),dead=new Pool({connectionString:'postgresql://nobody:nothing@127.0.0.1:1/s4m_dispatch_test',connectionTimeoutMillis:500,max:1})
 try{
  const before=(await h.dispatch.query('SELECT state,result_id,version::text v FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0]
  const down=createDispatchDelivery({store:h.dispatch,queue:dead,random:()=>0})
  expect(await down.deliverDispatchOutbox(25)).toEqual({delivered:0,failed:1})
  let row=(await h.dispatch.query("SELECT attempts,published_at,round(extract(epoch from next_attempt_at-now())) wait FROM queue_dispatch_outbox WHERE request_id=$1 ORDER BY version DESC LIMIT 1",[x.proof.request_id])).rows[0]
  expect(row).toMatchObject({attempts:1,published_at:null});expect(Number(row.wait)).toBe(1)
  // Not due yet: nothing is attempted while it backs off.
  expect(await down.deliverDispatchOutbox(25)).toEqual({delivered:0,failed:0})
  for(let i=2;i<=10;i++){await h.dispatch.query('UPDATE queue_dispatch_outbox SET next_attempt_at=now() WHERE request_id=$1',[x.proof.request_id]);expect((await down.deliverDispatchOutbox(1)).failed).toBe(1)}
  row=(await h.dispatch.query("SELECT attempts,round(extract(epoch from next_attempt_at-now())) wait FROM queue_dispatch_outbox WHERE request_id=$1 ORDER BY version DESC LIMIT 1",[x.proof.request_id])).rows[0]
  expect(row.attempts).toBe(10);expect(Number(row.wait)).toBe(60)
  expect((await x.requests.getDispatch(x.f.actor,x.proof.request_id)).delivery).toBe('failed')
  expect((await h.dispatch.query('SELECT state,result_id,version::text v FROM queue_dispatch_requests WHERE id=$1',[x.proof.request_id])).rows[0]).toEqual(before)
  // The queue comes back: the durable retry delivers the same snapshot.
  await h.dispatch.query('UPDATE queue_dispatch_outbox SET next_attempt_at=now() WHERE request_id=$1',[x.proof.request_id])
  expect(await createDispatchDelivery({store:h.dispatch,queue:projector}).deliverDispatchOutbox(25)).toMatchObject({delivered:1,failed:0})
  expect((await messages(x.proof.request_id)).map(m=>m.status)).toEqual(['done','pending'])
  expect((await x.requests.getDispatch(x.f.actor,x.proof.request_id)).delivery).toBe('delivered')
 }finally{await dead.end()}
})
it('wakes existing listeners on the ordinary queue channel with the ordinary envelope',async()=>{
 const x=await finished(),listener=await h.admin.connect(),seen:Array<Record<string,unknown>>=[]
 try{
  await listener.query('LISTEN agent_queue');listener.on('notification',n=>{if(n.payload)seen.push(JSON.parse(n.payload))})
  await createDispatchDelivery({store:h.dispatch,queue:projector}).deliverDispatchOutbox(25)
  await new Promise(resolve=>setTimeout(resolve,200))
  const mine=seen.filter(e=>e.to_model===x.proof.request_id||e.from_model===x.proof.request_id)
  expect(mine.map(e=>[e.type,e.status,e.previous_status])).toEqual([['task','done',null],['result','pending',null]])
  expect(Object.keys(mine[0]).sort()).toEqual(['from_model','from_server','id','in_reply_to','previous_status','status','to_model','to_server','type'])
 }finally{await listener.query('UNLISTEN *');listener.release()}
})
