import {createHmac,timingSafeEqual} from 'node:crypto'
import {z} from 'zod'
const bindingSchema=z.object({request_id:z.string().uuid(),candidate_id:z.string().uuid(),generation:z.number().int().positive(),attempt_id:z.string().uuid(),incarnation_id:z.string().uuid(),input_sha256:z.string().regex(/^[a-f0-9]{64}$/),profile_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
const operationSchema=z.enum(['read_source','stage_report','stage_checks','stage_code'])
export type AgentOutputOperation=z.infer<typeof operationSchema>
export type AgentOutputBinding=z.infer<typeof bindingSchema>
const claimsSchema=z.object({version:z.literal(1),purpose:z.literal('agent-output'),binding:bindingSchema,operations:z.array(operationSchema),issued_at:z.number().int().nonnegative(),expires_at:z.number().int().positive()}).strict()
export type AgentOutputMintContext={binding:AgentOutputBinding;action:'free_task'|'review'|'task_implementation';access:'read'|'repo_write';attemptDeadlineMs:number}
/** Crypto primitive, no endpoint and no DB authority. The IP13 authenticated
 * supervisor adapter must build context from the current authorized attempt.
 * IP08 must independently recheck current state/lease/rights and protected key
 * namespace on EVERY operation; signature verification is not that authorization.
 */
export function createAgentOutputCapabilities(key:Uint8Array){
 if(key.byteLength<32)throw Error('DISPATCH_AGENT_OUTPUT_KEY_INVALID')
 const signature=(body:string)=>createHmac('sha256',key).update('agent-output-v1.'+body).digest()
 return {
  mint(context:AgentOutputMintContext,nowMs:number):string{
   if(!Number.isSafeInteger(nowMs)||nowMs<0||!Number.isSafeInteger(context.attemptDeadlineMs)||context.attemptDeadlineMs<=nowMs
    ||!['read','repo_write'].includes(context.access)||!['free_task','review','task_implementation'].includes(context.action))throw Error('DISPATCH_AGENT_OUTPUT_REFUSED')
   const operations:AgentOutputOperation[]=['read_source','stage_report','stage_checks']
   if(context.access==='repo_write'&&context.action!=='review')operations.push('stage_code')
   const claims=claimsSchema.parse({version:1,purpose:'agent-output',binding:bindingSchema.parse(context.binding),operations,issued_at:nowMs,expires_at:Math.min(nowMs+300000,context.attemptDeadlineMs)})
   const body=Buffer.from(JSON.stringify(claims)).toString('base64url')
   return 'agent-output.'+body+'.'+signature(body).toString('base64url')
  },
  verify(token:string,expected:AgentOutputBinding,operation:AgentOutputOperation,nowMs:number){
   try{
    const parts=token.split('.')
    if(parts.length!==3||parts[0]!=='agent-output'||token.length>4096||parts.slice(1).some(p=>!/^[A-Za-z0-9_-]+$/.test(p)))throw Error()
    const body=Buffer.from(parts[1],'base64url'),sig=Buffer.from(parts[2],'base64url')
    if(body.toString('base64url')!==parts[1]||sig.toString('base64url')!==parts[2]||sig.length!==32||!timingSafeEqual(signature(parts[1]),sig))throw Error()
    const claims=claimsSchema.parse(JSON.parse(body.toString('utf8')))
    if(JSON.stringify(claims)!==body.toString('utf8')||!Number.isSafeInteger(nowMs)||claims.issued_at>nowMs||claims.expires_at<=nowMs
     ||claims.expires_at<=claims.issued_at||claims.expires_at-claims.issued_at>300000||JSON.stringify(claims.binding)!==JSON.stringify(bindingSchema.parse(expected))
     ||!operationSchema.safeParse(operation).success||!claims.operations.includes(operation))throw Error()
    return claims
   }catch{throw Error('DISPATCH_AGENT_OUTPUT_REFUSED')}
  }
 }
}
