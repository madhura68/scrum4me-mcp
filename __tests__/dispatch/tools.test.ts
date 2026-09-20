import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest'
vi.mock('../../src/prisma.js',()=>({prisma:{}}))
import {requestContext} from '../../src/request-context.js'
import {registerQueueTools,registerSharedTools,registerWorktreeTools} from '../../src/register.js'
import {registerDispatchTaskTool} from '../../src/tools/dispatch-task.js'
import {registerDispatchReviewTool} from '../../src/tools/dispatch-review.js'
import {registerGetDispatchTool} from '../../src/tools/get-dispatch.js'
import {registerCancelDispatchTool} from '../../src/tools/cancel-dispatch.js'

type Handler=(input:Record<string,unknown>)=>Promise<{isError?:boolean;content:Array<{text?:string}>}>
const handlers:Record<string,Handler>={},metas:Record<string,{inputSchema:unknown}>={}
const server={registerTool:vi.fn((name:string,meta:{inputSchema:unknown},h:Handler)=>{handlers[name]=h;metas[name]=meta})}
for(const register of [registerDispatchTaskTool,registerDispatchReviewTool,registerGetDispatchTool,registerCancelDispatchTool])register(server as never)

const id='11111111-1111-4111-8111-111111111111',task='task_cuid_1'
const view={id,version:'1',state:'WAITING',action:'free_task',reason:'waiting_for_capacity',route:null,profile_revision_id:null,job_id:null,executor_label:null,result_id:null,delivery:'pending',created_at:'2026-09-20T00:00:00.000Z'}
const documents={version:1,items:[{key:'plan',title:'Plan',source:'product_doc',product_id:'p',doc_id:'d',revision_id:'r',sha256:'a'.repeat(64)}]}
const base={product_id:'p',objective:'Do the work',verification:'Prove it',response_format:'Markdown',reply_to:'mac:jp'}
let calls:Array<{url:string;init:RequestInit}>
const body=(i=0)=>JSON.parse(String(calls[i].init.body)),header=(name:string,i=0)=>(calls[i].init.headers as Record<string,string>)[name]
const asUser=<T>(fn:()=>Promise<T>)=>requestContext.run({token:'user-token'},fn)
beforeEach(()=>{calls=[];vi.stubEnv('S4M_DISPATCH_URL','https://dispatch.example.test/dispatch/v1');vi.stubEnv('SCRUM4ME_TOKEN','service-token')
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{calls.push({url,init});return new Response(JSON.stringify(view),{status:200,headers:{'Content-Type':'application/json'}})}))})
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()})

describe('dispatch MCP tools',()=>{
 it('submits a free task with the caller\'s own bearer and a stable idempotency key',async()=>{
  const key='22222222-2222-4222-8222-222222222222',result=await asUser(()=>handlers.dispatch_task({...base,access:'read',idempotency_key:key}))
  expect(result.isError).toBeFalsy()
  expect(calls[0].url).toBe('https://dispatch.example.test/dispatch/v1/requests');expect(calls[0].init.method).toBe('POST')
  // The request context wins: never the broader process token when a caller presented their own.
  expect(header('Authorization')).toBe('Bearer user-token');expect(header('Idempotency-Key')).toBe(key)
  expect(body()).toEqual({version:1,...base,action:'free_task',requirements:{access:'read',environment_keys:[]},publish:'artifact'})
  expect(JSON.parse(result.content[0].text!)).toMatchObject({idempotency_key:key,dispatch:{id,state:'WAITING'}})
 })
 it('generates an idempotency key when none is given and returns it for a retry',async()=>{
  const result=await asUser(()=>handlers.dispatch_task({...base,access:'read'})),key=header('Idempotency-Key')
  expect(key).toMatch(/^[0-9a-f-]{36}$/);expect(JSON.parse(result.content[0].text!).idempotency_key).toBe(key)
 })
 it('chooses task_implementation only through an explicit task_id; work item metadata never changes the action',async()=>{
  await asUser(()=>handlers.dispatch_task({...base,access:'read',work_item:{task_id:task,story_id:'s'}}))
  expect(body(0)).toMatchObject({action:'free_task',work_item:{task_id:task,story_id:'s'}});expect(body(0).task_id).toBeUndefined()
  await asUser(()=>handlers.dispatch_task({...base,access:'repo_write',publish:'pull_request',task_id:task,repository:{product_id:'p',base_sha:'b'.repeat(40)}}))
  expect(body(1)).toMatchObject({action:'task_implementation',task_id:task,publish:'pull_request',requirements:{access:'repo_write',repository:{product_id:'p',base_sha:'b'.repeat(40)}}})
 })
 it('a review demands pinned document refs and is always read-only',async()=>{
  const refused=await asUser(()=>handlers.dispatch_review({...base}));expect(refused.isError).toBe(true);expect(calls).toHaveLength(0)
  const unpinned=await asUser(()=>handlers.dispatch_review({...base,review_documents:{version:1,items:[{...documents.items[0],sha256:undefined}]}}));expect(unpinned.isError).toBe(true);expect(calls).toHaveLength(0)
  await asUser(()=>handlers.dispatch_review({...base,review_documents:documents}))
  expect(body()).toEqual({version:1,...base,action:'review',requirements:{access:'read',environment_keys:[]},publish:'artifact',review_documents:documents})
 })
 it('refuses an unknown key instead of quietly dropping it, but reads prose as prose',async()=>{
  // The declared schema is what the SDK validates against. A stripped key is
  // worse than a refused one: the caller would believe a PPE marker or a
  // hand-written requirements block had been honoured when it never travelled.
  for(const name of ['dispatch_task','dispatch_review']){
   const schema=metas[name].inputSchema as {safeParse:(v:unknown)=>{success:boolean}}
   for(const bad of [{...base,access:'read',ppe_protocol:'x'},{...base,access:'read',requirements:{access:'read'}}]){
    expect(schema.safeParse(bad).success).toBe(false)
   }
  }
  // A marker that reaches the handler anyway is still refused by the contract.
  const smuggled=await asUser(()=>handlers.dispatch_task({...base,access:'read',ppe_protocol:'x'}))
  expect(smuggled.isError).toBe(true);expect(calls).toHaveLength(0)
  // Prose is prose: the word is not a marker.
  const fine=await asUser(()=>handlers.dispatch_task({...base,access:'read',objective:'Check the PPE validation path'}))
  expect(fine.isError).toBeFalsy();expect(body().objective).toBe('Check the PPE validation path')
 })
 it('surfaces an expired or revoked token without retry and without a second identity',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{calls.push({url,init});return new Response(JSON.stringify({error:'DISPATCH_TOKEN_EXPIRED'}),{status:401})}))
  const result=await asUser(()=>handlers.dispatch_task({...base,access:'read'}))
  expect(result.isError).toBe(true);expect(result.content[0].text).toContain('DISPATCH_TOKEN_EXPIRED')
  expect(result.content[0].text).not.toContain('user-token')
  expect(calls).toHaveLength(1);expect(header('Authorization')).toBe('Bearer user-token')
 })
 it('refuses unknown keys and invalid input before any request is sent',async()=>{
  for(const bad of [{...base,access:'read',reply_to:'nowhere'},{...base,access:'read',publish:'branch'},{...base,access:'repo_write'}]){
   const result=await asUser(()=>handlers.dispatch_task(bad));expect(result.isError).toBe(true);expect(result.content[0].text).toContain('DISPATCH_INVALID_INPUT')
  }
  expect(calls).toHaveLength(0)
 })
 it('reads and cancels through the same client and surfaces the central error code',async()=>{
  await asUser(()=>handlers.get_dispatch({request_id:id}));expect(calls[0].url).toBe(`https://dispatch.example.test/dispatch/v1/requests/${id}`);expect(calls[0].init.method).toBe('GET')
  await asUser(()=>handlers.cancel_dispatch({request_id:id,expected_version:'3',action_id:'33333333-3333-4333-8333-333333333333'}))
  expect(calls[1].url).toBe(`https://dispatch.example.test/dispatch/v1/requests/${id}/cancel`);expect(body(1)).toEqual({action_id:'33333333-3333-4333-8333-333333333333',expected_version:'3'})
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:'DISPATCH_FORBIDDEN'}),{status:403})))
  const forbidden=await asUser(()=>handlers.get_dispatch({request_id:id}));expect(forbidden.isError).toBe(true);expect(forbidden.content[0].text).toContain('DISPATCH_FORBIDDEN')
 })
 it('never falls through to a broader token, and says so when dispatch is not configured',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{calls.push({url,init});return new Response(JSON.stringify({error:'DISPATCH_FORBIDDEN'}),{status:403})}))
  const denied=await asUser(()=>handlers.dispatch_task({...base,access:'read'}))
  expect(denied.isError).toBe(true);expect(calls).toHaveLength(1);expect(header('Authorization')).toBe('Bearer user-token')
  vi.stubEnv('S4M_DISPATCH_URL','');calls=[]
  const unconfigured=await asUser(()=>handlers.get_dispatch({request_id:id}));expect(unconfigured.isError).toBe(true);expect(unconfigured.content[0].text).toContain('DISPATCH_NOT_CONFIGURED');expect(calls).toHaveLength(0)
 })
})

// The same fixture file, byte-identical, lives in s4m-queue as
// test/fixtures/dispatch-parity.json. Both sides assert its sha256, so the two
// repos cannot drift into asserting parity against different bytes.
describe('MCP/CLI request parity',()=>{
 it('puts exactly the bytes on the wire that the CLI does for the same request',async()=>{
  const parity=JSON.parse(readFileSync(new URL('./dispatch-parity.json',import.meta.url),'utf8')) as {mcp_tool_input:Record<string,unknown>;wire_path:string;wire_body:string;idempotency_key:string}
  await asUser(()=>handlers.dispatch_task(parity.mcp_tool_input))
  expect(calls[0].url).toBe(`https://dispatch.example.test${parity.wire_path}`)
  expect(String(calls[0].init.body)).toBe(parity.wire_body)
  expect(header('Idempotency-Key')).toBe(parity.idempotency_key)
 })
 it('holds the same fixture bytes as the s4m-queue repo',()=>{
  const bytes=readFileSync(new URL('./dispatch-parity.json',import.meta.url))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('260bef36caa5bcb90dfe996e4269517acad59ff8caf2844f8ce0df7090f812a0')
 })
})

const DISPATCH_TOOLS=['dispatch_task','dispatch_review','get_dispatch','cancel_dispatch']
function capture(register:(s:never)=>void){
 const names:string[]=[],descriptions:Record<string,string>={}
 register({registerTool:(n:string,meta:{description?:string})=>{names.push(n);descriptions[n]=meta.description??''},registerPrompt:()=>{}} as never)
 return {names,descriptions}
}
describe('dispatch tool registration',()=>{
 // The four tools need only the caller's token, never the host's queue identity,
 // so they belong in the shared set that both HTTP and stdio serve.
 it('serves the dispatch tools from the shared set, not the host-bound ones',()=>{
  const shared=capture(registerSharedTools)
  for(const name of DISPATCH_TOOLS)expect(shared.names).toContain(name)
  for(const register of [registerQueueTools,registerWorktreeTools]){
   const {names}=capture(register)
   for(const name of DISPATCH_TOOLS)expect(names).not.toContain(name)
  }
 })
 it('points queue_push at automatic dispatch without changing its own contract',()=>{
  const {descriptions}=capture(registerQueueTools)
  expect(descriptions.queue_push).toMatch(/dispatch_task/)
  expect(descriptions.queue_push).toMatch(/dispatch_review/)
 })
})
