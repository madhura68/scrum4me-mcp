import {it,expect} from 'vitest'
import {decideStoryStatus,decidePbiStatus,decideSprintStatus} from '../../src/lib/task-status-decisions.js'
import {checkVerifyGate} from '../../src/verify/gate.js'
it('preserves FAILED precedence, nonempty ALL DONE and manual BLOCKED',()=>{
 expect(decideStoryStatus(['DONE','FAILED'],true)).toBe('FAILED')
 expect(decideStoryStatus([],false)).toBe('OPEN')
 expect(decidePbiStatus(['FAILED'],'BLOCKED')).toBe('BLOCKED')
 expect(decideSprintStatus(['DONE'])).toBe('CLOSED')
 expect(decideSprintStatus([])).toBe('OPEN')
})
it('treats EXCLUDED tasks as settled in the story rollup (ISS-1)',()=>{
 expect(decideStoryStatus(['DONE','EXCLUDED'],true)).toBe('DONE')
 expect(decideStoryStatus(['EXCLUDED','EXCLUDED'],true)).toBe('DONE')
 expect(decideStoryStatus(['EXCLUDED'],false)).toBe('DONE')
 expect(decideStoryStatus(['EXCLUDED','TO_DO'],true)).toBe('IN_SPRINT')
 expect(decideStoryStatus(['EXCLUDED','IN_PROGRESS'],false)).toBe('OPEN')
 expect(decideStoryStatus(['EXCLUDED','REVIEW'],true)).toBe('IN_SPRINT')
 expect(decideStoryStatus(['FAILED','EXCLUDED','DONE'],true)).toBe('FAILED')
})
it('cannot accept empty changes without the frozen verify-only permission',()=>{
 expect(checkVerifyGate('EMPTY',false,'ANY')).toHaveProperty('allowed',false)
 expect(checkVerifyGate('EMPTY',true,'ALIGNED')).toHaveProperty('allowed',true)
})
