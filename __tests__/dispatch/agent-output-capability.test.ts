import {it,expect} from 'vitest'
import {createAgentOutputCapabilities} from '../../src/dispatch/agent-output-capability.js'
const id='11111111-1111-4111-8111-111111111111'
const binding={request_id:id,candidate_id:id,generation:1,attempt_id:id,incarnation_id:id,input_sha256:'a'.repeat(64),profile_sha256:'b'.repeat(64)}
it('restricts read-profile child token to its attempt and non-control operations',()=>{
 const service=createAgentOutputCapabilities(Buffer.alloc(32,61)),now=Date.now()
 const token=service.mint({binding,action:'review',access:'read',attemptDeadlineMs:now+500000},now)
 expect(service.verify(token,binding,'read_source',now).purpose).toBe('agent-output')
 for(const op of ['stage_code','claim','start','cancel','recover','task_status','stage_stop','publish'])expect(()=>service.verify(token,binding,op as any,now)).toThrow()
 expect(()=>service.verify(token,{...binding,generation:2},'read_source',now)).toThrow()
 expect(()=>service.verify(token,binding,'read_source',now+300000)).toThrow()
 expect(()=>service.verify(token+'x',binding,'read_source',now)).toThrow()
 expect(()=>service.verify(token,binding,'read_source',now-1)).toThrow()
})
it('bounds expiry by remaining attempt deadline and permits code staging only for code work',()=>{
 const service=createAgentOutputCapabilities(Buffer.alloc(32,62)),now=Date.now()
 const token=service.mint({binding,action:'free_task',access:'repo_write',attemptDeadlineMs:now+50},now)
 expect(service.verify(token,binding,'stage_code',now).expires_at).toBe(now+50)
 expect(()=>service.verify(token,binding,'stage_code',now+50)).toThrow()
 expect(()=>service.mint({binding,action:'free_task',access:'read',attemptDeadlineMs:now},now)).toThrow()
 expect(()=>createAgentOutputCapabilities(Buffer.alloc(31))).toThrow()
})
