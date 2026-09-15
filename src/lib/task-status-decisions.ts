/** Pure decisions shared by legacy Prisma and managed pg adapters. */
export const decideStoryStatus=(states:readonly string[],inSprint:boolean):'FAILED'|'DONE'|'IN_SPRINT'|'OPEN'=>states.includes('FAILED')?'FAILED':states.length&&states.every(s=>s==='DONE')?'DONE':inSprint?'IN_SPRINT':'OPEN'
export const decidePbiStatus=(states:readonly string[],current:string):'BLOCKED'|'FAILED'|'DONE'|'READY'=>current==='BLOCKED'?'BLOCKED':states.includes('FAILED')?'FAILED':states.length&&states.every(s=>s==='DONE')?'DONE':'READY'
export const decideSprintStatus=(states:readonly string[]):'FAILED'|'CLOSED'|'OPEN'=>states.includes('FAILED')?'FAILED':states.length&&states.every(s=>s==='DONE')?'CLOSED':'OPEN'
