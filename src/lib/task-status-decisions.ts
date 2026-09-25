/** Pure decisions shared by legacy Prisma and managed pg adapters. */
// EXCLUDED telt mee als terminaal, maar promoveert niet op zichzelf. `every(DONE)`
// liet een uitgesloten taak de story permanent op IN_SPRINT/OPEN staan; de aanroeper
// schrijft de uitkomst weg, dus een handmatige correctie werd bij de eerstvolgende
// taakwissel teruggedraaid (9 stories zaten zo vast, gemeten 2026-09-24).
// De `some(DONE)`-eis houdt de andere kant dicht: een story waarin geen enkele taak
// is uitgevoerd heet niet DONE.
// Alleen hier: EXCLUDED bestaat in TaskStatus, niet in StoryStatus/PbiStatus/
// SprintStatus — decidePbiStatus en decideSprintStatus krijgen die waarde nooit
// binnen en moeten dus niet "gelijkgetrokken" worden.
// Deze kopie MOET gelijk blijven aan Scrum4Me:lib/task-status-decisions.ts. Beide
// paden schrijven naar dezelfde stories-tabel: de webapp via Prisma, deze MCP via
// src/lib/tasks-status-update.ts. Scrum4Me PR #257 (de2fc42a) fixte alleen de
// eerste; agents gebruiken update_task_status en raakten dus dit bestand.
export const decideStoryStatus=(states:readonly string[],inSprint:boolean):'FAILED'|'DONE'|'IN_SPRINT'|'OPEN'=>states.includes('FAILED')?'FAILED':states.some(s=>s==='DONE')&&states.every(s=>s==='DONE'||s==='EXCLUDED')?'DONE':inSprint?'IN_SPRINT':'OPEN'
export const decidePbiStatus=(states:readonly string[],current:string):'BLOCKED'|'FAILED'|'DONE'|'READY'=>current==='BLOCKED'?'BLOCKED':states.includes('FAILED')?'FAILED':states.length&&states.every(s=>s==='DONE')?'DONE':'READY'
export const decideSprintStatus=(states:readonly string[]):'FAILED'|'CLOSED'|'OPEN'=>states.includes('FAILED')?'FAILED':states.length&&states.every(s=>s==='DONE')?'CLOSED':'OPEN'
