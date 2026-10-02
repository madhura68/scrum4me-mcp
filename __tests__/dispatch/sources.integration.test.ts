import {beforeEach,afterEach,it,expect} from 'vitest'
import {randomUUID,createHash} from 'node:crypto'
import {makeDispatchHarness,type DispatchHarness,type DispatchHarnessSeed} from './harness.js'
import {createDispatchAuth} from '../../src/dispatch/auth.js'
import {createDispatchRequests} from '../../src/dispatch/requests.js'
import {createDispatchSources,createDocumentSourcePorts} from '../../src/dispatch/sources.js'
import {createDispatchSelection} from '../../src/dispatch/selection.js'
import {readPinnedDocument} from '@shared/queue-document-reader.js'
import {canonicalDispatchInput} from '@shared/queue-dispatch-validation.js'
import {DISPATCH_INPUT_SOURCE_KEY} from '@shared/queue-dispatch-sources.js'
let h:DispatchHarness,f:DispatchHarnessSeed,sources:ReturnType<typeof createDispatchSources>,requests:ReturnType<typeof createDispatchRequests>,selection:ReturnType<typeof createDispatchSelection>
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),content='\ufeff# Pinned café\r\n'
let docId:string,revisionId:string
beforeEach(async()=>{h=await makeDispatchHarness();f=await h.seed();const auth=createDispatchAuth({store:h.dispatch});sources=createDispatchSources({store:h.dispatch,auth,fetchGit:async()=>({ok:false,reason:'network'})});requests=createDispatchRequests({store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]});selection=createDispatchSelection({store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]});docId=randomUUID();revisionId=randomUUID();await h.admin.query("INSERT INTO product_docs(id,product_id,folder,slug,title,content_md,status,created_by,updated_at) VALUES($1,$2,'PLANS','plan','Plan','latest','active',$3,now())",[docId,f.input.product_id,f.actor.userId]);await h.admin.query("INSERT INTO product_doc_revisions(id,doc_id,revision,title,status,content_md,content_hash,created_by) VALUES($1,$2,1,'Plan','active',$3,$4,$5)",[revisionId,docId,content,sha(content),f.actor.userId])})
afterEach(async()=>{await h.admin.query('DELETE FROM product_doc_revisions WHERE doc_id=$1',[docId]);await h.admin.query('DELETE FROM product_docs WHERE id=$1',[docId]);await h.close()})
const ref=()=>({key:'plan',title:'Plan',source:'product_doc' as const,product_id:f.input.product_id,doc_id:docId,revision_id:revisionId,sha256:sha(content)})
it('stores actual old ProductDoc bytes and full refs before making selection ready',async()=>{
 const input={...f.input,action:'review' as const,review_documents:{version:1 as const,items:[ref()]}};const r=await requests.submitDispatch(f.actor,input,randomUUID())
 expect(await selection.reserveRequest(r.id)).toBeNull()
 // The pinned document plus the one service source carrying the task itself (M41).
 const exposed=await sources.readDispatchSources(f.actor,{requestId:r.id,input});expect(exposed.map(x=>x.key)).toEqual(['__dispatch_input','plan'])
 const rows=(await h.dispatch.query("SELECT key,sha256,bytes,attempt_id FROM queue_dispatch_artifacts WHERE request_id=$1 AND key='plan'",[r.id])).rows;expect(rows).toHaveLength(1);expect(rows[0].bytes.equals(Buffer.from(content))).toBe(true);expect(rows[0].attempt_id).toBeNull()
 await h.admin.query("UPDATE product_docs SET content_md='newest' WHERE id=$1",[docId]);await sources.prepareRequestSources(r.id)
 expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_artifacts WHERE request_id=$1',[r.id])).rows[0].n).toBe(2)
 expect((await h.dispatch.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='sources_prepared'",[r.id])).rows[0].payload.documents).toEqual(input.review_documents)
})
it('uses all three exact revision keys and never falls back on current content',async()=>{
 const ports=createDocumentSourcePorts(h.dispatch,async()=>({ok:false,reason:'network'}))
 expect(await readPinnedDocument(ref(),ports)).toMatchObject({ok:true,content})
 for(const bad of [{...ref(),product_id:'different'},{...ref(),doc_id:'different'},{...ref(),revision_id:'missing'}])expect(await readPinnedDocument(bad,ports)).toEqual({ok:false,reason:'missing'})
 expect(await readPinnedDocument({...ref(),sha256:'0'.repeat(64)},ports)).toEqual({ok:false,reason:'hash-mismatch'})
})
it('rejects permanent authorization loss even after readiness, producing exactly one result',async()=>{const r=await requests.submitDispatch(f.actor,f.input,randomUUID());await sources.prepareRequestSources(r.id);await h.admin.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1',[f.actor.tokenId]);await sources.prepareRequestSources(r.id);await sources.prepareRequestSources(r.id);expect((await h.dispatch.query('SELECT state FROM queue_dispatch_requests WHERE id=$1',[r.id])).rows[0].state).toBe('FAILED');expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_results WHERE request_id=$1',[r.id])).rows[0].n).toBe(1)})
it('keeps a transient transport error waiting with a bounded durable retry reason',async()=>{await h.admin.query("UPDATE products SET repo_url='https://git.jp-visser.nl/o/r.git' WHERE id=$1",[f.input.product_id]);const input={...f.input,action:'review' as const,review_documents:{version:1 as const,items:[{key:'git',title:'Git',source:'git' as const,product_id:f.input.product_id,path:'docs/plan.md',commit_sha:'a'.repeat(40),sha256:'a'.repeat(64)}]}};const r=await requests.submitDispatch(f.actor,input,randomUUID());await sources.prepareRequestSources(r.id);await sources.prepareRequestSources(r.id);expect((await requests.getDispatch(f.actor,r.id)).state).toBe('WAITING');expect((await h.dispatch.query("SELECT count(*)::int n FROM queue_dispatch_events WHERE request_id=$1 AND type='source_retry'",[r.id])).rows[0].n).toBe(1);expect((await h.dispatch.query('SELECT sources_ready_at FROM queue_dispatch_requests WHERE id=$1',[r.id])).rows[0].sources_ready_at).toBeNull()})
it('cannot reserve an otherwise eligible free task until source preparation commits',async()=>{const r=await requests.submitDispatch(f.actor,f.input,randomUUID());expect(await selection.reserveRequest(r.id)).toBeNull();await sources.prepareRequestSources(r.id);expect(await selection.reserveRequest(r.id)).toBe(r.id)})
it('permanent missing pinned revision fails once before claim and keeps latest out of the artifact',async()=>{const r=await requests.submitDispatch(f.actor,{...f.input,review_documents:{version:1,items:[ref()]}},randomUUID());await h.admin.query('DELETE FROM product_doc_revisions WHERE id=$1',[revisionId]);await sources.prepareRequestSources(r.id);expect((await h.dispatch.query('SELECT state,sources_ready_at FROM queue_dispatch_requests WHERE id=$1',[r.id])).rows[0]).toEqual({state:'FAILED',sources_ready_at:null});expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_artifacts WHERE request_id=$1',[r.id])).rows[0].n).toBe(0)})
it('selection permanently rejects fresh authorization loss after readiness',async()=>{const r=await requests.submitDispatch(f.actor,f.input,randomUUID());await sources.prepareRequestSources(r.id);await h.admin.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1',[f.actor.tokenId]);expect(await selection.reserveRequest(r.id)).toBeNull();expect((await h.dispatch.query('SELECT state FROM queue_dispatch_requests WHERE id=$1',[r.id])).rows[0].state).toBe('FAILED')})
it('stores the canonical DispatchInput as the service source __dispatch_input, bound by the input hash',async()=>{
 const r=await requests.submitDispatch(f.actor,f.input,randomUUID());await sources.prepareRequestSources(r.id)
 const request=(await h.dispatch.query('SELECT input,input_hash FROM queue_dispatch_requests WHERE id=$1',[r.id])).rows[0]
 const rows=(await h.dispatch.query('SELECT id,sha256,bytes,attempt_id FROM queue_dispatch_artifacts WHERE request_id=$1 AND key=$2',[r.id,DISPATCH_INPUT_SOURCE_KEY])).rows
 expect(rows).toHaveLength(1)
 expect(rows[0].bytes.equals(Buffer.from(canonicalDispatchInput(request.input),'utf8'))).toBe(true)
 expect(rows[0].sha256).toBe(request.input_hash);expect(rows[0].attempt_id).toBeNull()
 const prepared=(await h.dispatch.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='sources_prepared'",[r.id])).rows[0].payload
 expect(prepared.sources).toEqual([{key:DISPATCH_INPUT_SOURCE_KEY,artifactId:rows[0].id,sha256:request.input_hash,byteSize:rows[0].bytes.length}])
})
it('fails preparation instead of serving a task whose bytes no longer match the signed input hash',async()=>{
 // The stored input is immutable, so only canonicalization drift can get here: model it as a
 // request whose recorded hash is not the hash of its canonical bytes.
 const original=await requests.submitDispatch(f.actor,f.input,randomUUID()),r={id:randomUUID()}
 await h.admin.query(`INSERT INTO queue_dispatch_requests SELECT (jsonb_populate_record(NULL::queue_dispatch_requests,to_jsonb(q)||jsonb_build_object('id',$2::uuid,'idempotency_key',$2::text,'input_hash',repeat('0',64),'root_message_id',$3::uuid,'reply_message_id',$4::uuid))).* FROM queue_dispatch_requests q WHERE q.id=$1`,[original.id,r.id,randomUUID(),randomUUID()])
 await sources.prepareRequestSources(r.id)
 expect((await h.dispatch.query('SELECT state,sources_ready_at FROM queue_dispatch_requests WHERE id=$1',[r.id])).rows[0]).toEqual({state:'FAILED',sources_ready_at:null})
 expect((await h.dispatch.query('SELECT payload FROM queue_dispatch_results WHERE request_id=$1',[r.id])).rows[0].payload.summary).toBe('source_input_mismatch')
 expect((await h.dispatch.query('SELECT count(*)::int n FROM queue_dispatch_artifacts WHERE request_id=$1',[r.id])).rows[0].n).toBe(0)
})
