import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { makeDispatchHarness, type DispatchHarness, type DispatchHarnessSeed } from './harness.js'
import { createDispatchApp } from '../../src/dispatch/routes.js'
import { createDispatchClient } from '../../src/dispatch/client.js'
import { signDispatchAssertion } from '../../src/dispatch/assertions.js'
import { registerDispatchTaskTool } from '../../src/tools/dispatch-task.js'
import { installTokenUsageObserver } from '../../src/token-usage-observer.js'
import { requestContext } from '../../src/request-context.js'
import { recordDispatchTokenUse } from '../../src/dispatch/token-usage.js'

let h:DispatchHarness, f:DispatchHarnessSeed, server:Server, root:string
const raw='synthetic-token-usage-dispatch'
const assertionKey=Buffer.alloc(32,9)
beforeEach(async()=>{
  h=await makeDispatchHarness();f=await h.seed()
  await h.admin.query('UPDATE api_tokens SET token_hash=$1 WHERE id=$2',[createHash('sha256').update(raw).digest('hex'),f.actor.tokenId])
  server=createDispatchApp({store:h.dispatch,enabled:true,productAllowlist:[f.input.product_id],assertionKeys:{web:assertionKey},executor:{credentialKeys:{1:Buffer.alloc(32,7)},keyVersion:1,startPermitPrivateKey:generateKeyPairSync('ed25519').privateKey,startPermitKeyId:'test'}}).listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  root=`http://127.0.0.1:${(server.address() as {port:number}).port}/dispatch/v1`
})
afterEach(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await h?.close();vi.unstubAllEnvs()})
const client=()=>createDispatchClient({baseUrl:root,token:raw})
const stamp=async()=> (await h.admin.query('SELECT last_used_at FROM api_tokens WHERE id=$1',[f.actor.tokenId])).rows[0].last_used_at as Date|null
async function advance(action:()=>Promise<unknown>){
  const before=await stamp();await action()
  for(let i=0;i<100;i++){const current=await stamp();if(current && (!before||current>before))return current;await new Promise(r=>setTimeout(r,10))}
  throw Error('Successful HTTP action did not record usage')
}
it('uses only a column grant, keeping identity and revocation columns protected',async()=>{
  const rights=await h.dispatch.query("SELECT has_column_privilege(current_user,'api_tokens','last_used_at','UPDATE') AS usage, has_column_privilege(current_user,'api_tokens','token_hash','UPDATE') AS hash, has_column_privilege(current_user,'api_tokens','user_id','UPDATE') AS owner, has_column_privilege(current_user,'api_tokens','revoked_at','UPDATE') AS revoke")
  expect(rights.rows[0]).toEqual({usage:true,hash:false,owner:false,revoke:false})
})
it('counts submit, read and self-sent artifact download; failures preserve time',async()=>{
  let id=''
  await advance(async()=>{id=(await client().submitDispatch(f.input,randomUUID())).id})
  await advance(()=>client().getDispatch(id))
  const bytes=Buffer.from('synthetic artifact'), artifactId=randomUUID()
  await h.admin.query('INSERT INTO queue_dispatch_artifacts(id,request_id,key,sha256,bytes,byte_size) VALUES($1,$2,$3,$4,$5,$6)',[artifactId,id,'report',createHash('sha256').update(bytes).digest('hex'),bytes,bytes.length])
  await advance(async()=>{const res=await fetch(`${root}/artifacts/${artifactId}`,{headers:{Authorization:`Bearer ${raw}`}});expect(res.status).toBe(200);expect(await res.text()).toBe(bytes.toString())})
  const before=await stamp()
  await expect(client().getDispatch(randomUUID())).rejects.toThrow()
  await new Promise(r=>setTimeout(r,30));expect(await stamp()).toEqual(before)
  // No request went through the adapter: later background bookkeeping cannot stamp its submitter.
  await h.admin.query('UPDATE queue_dispatch_requests SET updated_at=now() WHERE id=$1',[id])
  expect(await stamp()).toEqual(before)
})
it('counts successful executor heartbeat and empty claim',async()=>{
  const session=await h.registerNextIncarnation(f.hostSlot.id)
  const identity={incarnation_id:session.incarnationId,session_credential:session.sessionCredential}
  await advance(()=>client().heartbeatExecutor({...identity,busy:false}))
  await advance(async()=>{expect(await client().claimAttempt({...identity,claim_key:randomUUID()})).toBeNull()})
})
it('MCP dispatch forwarder records only at dispatch, never in local observer',async()=>{
  vi.stubEnv('S4M_DISPATCH_URL',root)
  const server=new McpServer({name:'forwarder',version:'1'}), local=vi.fn(async()=>{})
  installTokenUsageObserver(server,local);registerDispatchTaskTool(server)
  const [a,b]=InMemoryTransport.createLinkedPair();const mcp=new Client({name:'test',version:'1'})
  await server.connect(b);await mcp.connect(a)
  try{
    await advance(async()=>{
      const result=await requestContext.run({token:raw},()=>mcp.callTool({name:'dispatch_task',arguments:{product_id:f.input.product_id,objective:'Synthetic',verification:'Test',response_format:'Markdown',reply_to:'mac:jp',access:'read'}}))
      expect(result.isError).not.toBe(true)
    })
    expect(local).not.toHaveBeenCalled()
  }finally{await mcp.close();await server.close()}
})
it('successful web assertion carries no token usage',async()=>{
  const id=(await client().submitDispatch(f.input,randomUUID())).id
  await new Promise(r=>setTimeout(r,30))
  const before=await stamp()
  const body=Buffer.alloc(0),path=`/dispatch/v1/requests/${id}`
  const assertion=signDispatchAssertion({issuer:'scrum4me-web',userId:f.actor.userId,jti:randomUUID(),method:'GET',path,rawBody:body,key:assertionKey,idempotencyKey:''})
  const result=await fetch(root+`/requests/${id}`,{headers:{'X-Dispatch-Assertion':assertion}})
  expect(result.status).toBe(200);await result.text();await new Promise(r=>setTimeout(r,30));expect(await stamp()).toEqual(before)
})
it('revocation and SQL denial remain nonfatal without advancing usage',async()=>{
  await h.admin.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1',[f.actor.tokenId])
  await expect(recordDispatchTokenUse(h.dispatch,{tokenId:f.actor.tokenId!,userId:f.actor.userId,completedAt:new Date()})).resolves.toBeUndefined()
  expect(await stamp()).toBeNull()
  // queue identity deliberately has no token UPDATE privilege.
  await expect(recordDispatchTokenUse(h.queue,{tokenId:f.actor.tokenId!,userId:f.actor.userId,completedAt:new Date()})).resolves.toBeUndefined()
  expect(await stamp()).toBeNull()
})
