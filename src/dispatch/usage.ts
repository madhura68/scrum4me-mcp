import {z} from 'zod'
import type {PoolClient} from 'pg'

/** T-1972: the token usage the supervisor read from the sealed child's own transcript. The child
 * produced those bytes, so this is reporting, never accounting or authority: every count is a
 * bounded int4, and a value that does not parse is recorded as `parse_error` instead of refusing
 * the result it travels with. */
const COUNT=z.number().int().min(0).max(2_000_000_000)
export const dispatchUsageSchema=z.object({
 version:z.literal(1),runtime:z.enum(['CODEX','CLAUDE']),status:z.enum(['captured','no_usage_events','parse_error']),
 model:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).nullable(),
 input_tokens:COUNT,output_tokens:COUNT,cache_read_tokens:COUNT,cache_write_tokens:COUNT,reasoning_output_tokens:COUNT.nullable(),
}).strict()
export type DispatchUsage=z.infer<typeof dispatchUsageSchema>
export const DISPATCH_USAGE_SOURCE='dispatch_transcript'

/** The `claude_jobs` usage columns, priced like the Codex runner: the observed model, else the
 * model the job was configured with (`requested_model`), else `missing_model`. */
export function dispatchUsageColumns(raw:unknown,requestedModel:string|null){
 const parsed=dispatchUsageSchema.safeParse(raw)
 const status=parsed.success?parsed.data.status:'parse_error'
 const none={model_id:null,pricing_model_id:null,pricing_model_source:null,input_tokens:null,output_tokens:null,cache_read_tokens:null,cache_write_tokens:null,reasoning_output_tokens:null,
  usage_capture_source:DISPATCH_USAGE_SOURCE,usage_capture_status:status,usage_capture_error:`${DISPATCH_USAGE_SOURCE}_${status}`}
 if(!parsed.success||status!=='captured')return none
 const u=parsed.data,model=u.model??requestedModel
 return {model_id:model,pricing_model_id:model,pricing_model_source:u.model?'observed_event':model?'cli_model':null,
  input_tokens:u.input_tokens,output_tokens:u.output_tokens,cache_read_tokens:u.cache_read_tokens,cache_write_tokens:u.cache_write_tokens,reasoning_output_tokens:u.reasoning_output_tokens,
  usage_capture_source:DISPATCH_USAGE_SOURCE,usage_capture_status:model?'captured':'missing_model',usage_capture_error:model?null:`${DISPATCH_USAGE_SOURCE}_missing_model`}
}

/** `once` leaves a job that already carries usage as it is: the late-result path of a cancelled
 * attempt may arrive more than once, and only its first usage counts. */
export async function writeDispatchUsage(db:PoolClient,jobId:string,raw:unknown,options:{once?:boolean}={}):Promise<void>{
 const job=(await db.query('SELECT requested_model,usage_capture_status FROM claude_jobs WHERE id=$1',[jobId])).rows[0]
 if(!job||(options.once&&job.usage_capture_status!==null))return
 const c=dispatchUsageColumns(raw,job.requested_model??null),keys=Object.keys(c) as (keyof typeof c)[]
 await db.query(`UPDATE claude_jobs SET ${keys.map((k,i)=>`${k}=$${i+2}`).join(',')},updated_at=now() WHERE id=$1`,[jobId,...keys.map(k=>c[k])])
}
