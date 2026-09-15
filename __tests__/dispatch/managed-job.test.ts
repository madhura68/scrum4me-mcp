import { expect,it } from 'vitest'
import { assertUnmanagedJob } from '../../src/dispatch/managed-job.js'
it('refuses markers and managed kinds even when MANUAL strips the binding',()=>{
 for(const job of [{kind:'QUEUE_TASK',source:'MANUAL'},{kind:'QUEUE_REVIEW'}, {kind:'TASK_IMPLEMENTATION',dispatch_request_id:'request'}, {dispatch_candidate_id:'candidate'}]) expect(()=>assertUnmanagedJob(job)).toThrow('DISPATCH_MANAGED_ROW')
 expect(()=>assertUnmanagedJob({kind:'TASK_IMPLEMENTATION',dispatch_request_id:null,dispatch_candidate_id:null})).not.toThrow()
})
