/** Pure decisions shared by legacy Prisma and managed pg adapters. */
/**
 * Story-rollup. EXCLUDED-taken tellen niet mee als openstaand werk (ISS-1):
 * een story is DONE zodra elke niet-EXCLUDED taak DONE is. Een story waarvan
 * alle taken EXCLUDED zijn is ook DONE — er is niets meer te doen.
 * Een story zonder taken blijft IN_SPRINT/OPEN.
 */
export const decideStoryStatus=(states:readonly string[],inSprint:boolean):'FAILED'|'DONE'|'IN_SPRINT'|'OPEN'=>
 states.includes('FAILED')?'FAILED'
 :states.length&&states.every(s=>s==='DONE'||s==='EXCLUDED')?'DONE'
 :inSprint?'IN_SPRINT':'OPEN'
export const decidePbiStatus=(states:readonly string[],current:string):'BLOCKED'|'FAILED'|'DONE'|'READY'=>current==='BLOCKED'?'BLOCKED':states.includes('FAILED')?'FAILED':states.length&&states.every(s=>s==='DONE')?'DONE':'READY'
export const decideSprintStatus=(states:readonly string[]):'FAILED'|'CLOSED'|'OPEN'=>states.includes('FAILED')?'FAILED':states.length&&states.every(s=>s==='DONE')?'CLOSED':'OPEN'
