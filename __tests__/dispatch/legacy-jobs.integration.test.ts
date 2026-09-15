import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { makeDispatchHarness,type DispatchHarness,type DispatchHarnessSeed } from './harness.js'
import { createDispatchAuth } from '../../src/dispatch/auth.js'
import { createDispatchRequests } from '../../src/dispatch/requests.js'
import { createDispatchSelection } from '../../src/dispatch/selection.js'
const holder=vi.hoisted(()=>({db:null as unknown as PrismaClient,actor:null as unknown as {userId:string;tokenId:string}}))
vi.mock('../../src/prisma.js',()=>({get prisma(){return holder.db}}))
vi.mock('../../src/auth.js',async importOriginal=>({...await importOriginal<typeof import('../../src/auth.js')>(),requireWriteAccess:async()=>holder.actor}))
import { registerUpdateJobStatusTool,runDeferredWorktreeCleanup } from '../../src/tools/update-job-status.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { resetStaleClaimedJobs,rollbackClaim,markJobTerminallyFailed,getFullJobContext } from '../../src/tools/wait-for-job.js'
let h:DispatchHarness,f:DispatchHarnessSeed,jobId:string
beforeEach(async()=>{
 h=await makeDispatchHarness();f=await h.seed();holder.actor={userId:f.actor.userId,tokenId:f.actor.tokenId!};holder.db=new PrismaClient({adapter:new PrismaPg(h.web)})
 const auth=createDispatchAuth({store:h.dispatch}),opts={store:h.dispatch,auth,enabled:true,productAllowlist:[f.input.product_id]}
 const r=await createDispatchRequests(opts).submitDispatch(f.actor,f.input,'legacy')
 await createDispatchSelection(opts).reserveRequest(r.id)
 jobId=(await h.dispatch.query('SELECT id FROM claude_jobs WHERE dispatch_request_id=$1',[r.id])).rows[0].id
 await h.dispatch.query("UPDATE claude_jobs SET status='CLAIMED',claimed_at=now()-interval '1 hour',lease_until=now()-interval '1 minute',claimed_by_token_id=$2 WHERE id=$1",[jobId,f.actor.tokenId])
})
afterEach(async()=>{await holder.db?.$disconnect();await h?.close()})
it.each([0,2])('ordinary stale-reset leaves managed retry-count %s untouched',async retry=>{
 await h.dispatch.query('UPDATE claude_jobs SET retry_count=$2 WHERE id=$1',[jobId,retry])
 await expect(resetStaleClaimedJobs(f.actor.userId)).resolves.toBeUndefined()
 expect((await h.dispatch.query('SELECT status,retry_count FROM claude_jobs WHERE id=$1',[jobId])).rows[0]).toEqual({status:'CLAIMED',retry_count:retry})
})
it('refuses legacy rollback, failure and context before any worktree or external action',async()=>{
 for(const op of [()=>rollbackClaim(jobId,null),()=>markJobTerminallyFailed(jobId,'legacy'),()=>getFullJobContext(jobId)])await expect(op()).rejects.toThrow('DISPATCH_MANAGED_ROW')
 expect((await h.dispatch.query('SELECT status FROM claude_jobs WHERE id=$1',[jobId])).rows[0].status).toBe('CLAIMED')
})

it('rejects late ordinary done on the same managed binding even through MANUAL kind metadata',async()=>{
 await h.dispatch.query("UPDATE claude_jobs SET kind='TASK_IMPLEMENTATION',source='MANUAL' WHERE id=$1",[jobId])
 let handle!:(input:Record<string,unknown>)=>Promise<unknown>
 registerUpdateJobStatusTool({registerTool:(_name:unknown,_options:unknown,fn:typeof handle)=>{handle=fn}} as unknown as McpServer)
 const result=await handle({job_id:jobId,status:'done',summary:'late legacy done'})
 expect(result).toMatchObject({isError:true});expect(JSON.stringify(result)).toContain('DISPATCH_MANAGED_ROW')
 expect((await h.dispatch.query('SELECT status FROM claude_jobs WHERE id=$1',[jobId])).rows[0].status).toBe('CLAIMED')
})

it('refuses deferred cleanup before reading or clearing its pending marker',async()=>{
 await expect(runDeferredWorktreeCleanup(jobId)).rejects.toThrow('DISPATCH_MANAGED_ROW')
})
