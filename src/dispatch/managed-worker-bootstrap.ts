import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {PoolClient} from 'pg'
import {isManagedWorkerInstanceId} from '../presence/worker-mode.js'
import {createDispatchAuth} from './auth.js'
import {actorForToken} from './registration.js'
import {withDispatchTransaction,type DispatchStore} from './db.js'
const schema=z.object({
 owner_user_id:z.string().min(1),token_id:z.string().min(1),instance_id:z.string().refine(isManagedWorkerInstanceId),
 // null = every product the token may claim; registration and claim still authorize per product (ISS-11).
 product_id:z.string().min(1).nullable(),runtime:z.enum(['CLAUDE','CODEX']),
 capabilities:z.array(z.enum(['review','code_edit'])).min(1).refine(a=>new Set(a).size===a.length),
 tier:z.enum(['HIGH_P','MEDIUM_P','LOW_P']).nullable(),
 rebind:z.boolean().optional(),
}).strict()
export type ManagedWorkerBootstrapInput=z.infer<typeof schema>
export const parseManagedWorkerBootstrap=(value:unknown)=>schema.parse(value)
type WorkerRow={user_id:string;token_id:string;product_id:string|null;runtime:string;capabilities:string[];capability:string|null}
/** Only token and product may change, and only with an explicit rebind; everything else stays an exact binding. */
export function classifyBootstrapBinding(rows:WorkerRow[],input:ManagedWorkerBootstrapInput):'create'|'refresh'|'rebind'|'conflict' {
 if(!rows.length) return 'create'
 const row=rows[0]
 if(rows.length!==1 || row.user_id!==input.owner_user_id || row.runtime!==input.runtime || row.capability!==input.tier
  || JSON.stringify([...row.capabilities].sort())!==JSON.stringify([...input.capabilities].sort())) return 'conflict'
 if(row.token_id===input.token_id && row.product_id===input.product_id) return 'refresh'
 return input.rebind ? 'rebind' : 'conflict'
}
/** An unscoped all-products binding has no product to pre-authorize here; slot registration and claim do it per product. */
export function bootstrapClaimProducts(productId:string|null,scopedProducts:readonly string[]):string[] {
 return productId!==null ? [productId] : [...scopedProducts]
}
/** Operator-only preseed; this function has no HTTP route and creates no slot/profile.
 * Store must be the existing central migration owner connection, never dispatch or a worker DSN.
 */
export async function bootstrapManagedWorker(store:DispatchStore,value:unknown):Promise<{created:boolean;rebound?:true}> {
 const input=parseManagedWorkerBootstrap(value)
 return withDispatchTransaction(store,async(db:PoolClient)=>{
  const role=(await db.query('SELECT current_user AS role')).rows[0]?.role
  if(role!=='scrum4me') throw Error('DISPATCH_BOOTSTRAP_OPERATOR_REQUIRED')
  const auth=createDispatchAuth({store}),actor=actorForToken(input.owner_user_id,input.token_id)
  // Validates the token (active, owner, non-demo) even when no product is pre-authorized.
  const current=await auth.refreshActor(actor,db)
  for(const productId of bootstrapClaimProducts(input.product_id,current.scopedProducts))
   await auth.authorizeDispatch(actor,{version:1,product_id:productId,action:'free_task',objective:'Operator managed-worker bootstrap',verification:'Exact binding',response_format:'Markdown',requirements:{access:input.capabilities.includes('code_edit')?'repo_write':'read',environment_keys:[]},publish:'artifact',reply_to:'mac:jp'},'claim',db)
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`managed-worker-bootstrap:${input.instance_id}`])
  const rows=(await db.query<WorkerRow>('SELECT user_id,token_id,product_id,runtime,capabilities,capability FROM public.claude_workers WHERE instance_id=$1 FOR UPDATE',[input.instance_id])).rows
  const decision=classifyBootstrapBinding(rows,input)
  if(decision==='conflict') throw Error('DISPATCH_BOOTSTRAP_BINDING_CONFLICT')
  if(decision==='refresh'){
   // An operator rerun refreshes exactly this observation, not frozen authority or quota.
   await db.query('UPDATE public.claude_workers SET last_seen_at=clock_timestamp() AT TIME ZONE \'UTC\' WHERE user_id=$1 AND token_id=$2 AND instance_id=$3',[input.owner_user_id,input.token_id,input.instance_id])
   return {created:false}
  }
  if(decision==='rebind'){
   // Existing slots keep their old token until the operator re-posts them; old incarnations stop matching.
   await db.query('UPDATE public.claude_workers SET token_id=$3,product_id=$4,last_seen_at=clock_timestamp() AT TIME ZONE \'UTC\' WHERE user_id=$1 AND instance_id=$2',[input.owner_user_id,input.instance_id,input.token_id,input.product_id])
   return {created:false,rebound:true}
  }
  await db.query(`INSERT INTO public.claude_workers(id,user_id,token_id,instance_id,product_id,runtime,capabilities,capability,last_seen_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp() AT TIME ZONE 'UTC')`,[randomUUID(),input.owner_user_id,input.token_id,input.instance_id,input.product_id,input.runtime,input.capabilities,input.tier])
  return {created:true}
 })
}
