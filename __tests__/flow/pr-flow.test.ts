import { describe, it, expect } from 'vitest'
import { transition, type PrFlowState } from '../../src/flow/pr-flow.js'

describe('pr-flow STORY-mode 3-tasks scenario', () => {
  it('opens PR early; auto-merge only fires on the last task', () => {
    let state: PrFlowState = { kind: 'none', strategy: 'STORY' }
    const allEffects: Array<Record<string, unknown>> = []

    // Task 1 DONE → PR_CREATED
    let r = transition(state, { type: 'PR_CREATED', prUrl: 'https://github.com/o/r/pull/1' })
    state = r.nextState
    allEffects.push(...r.effects)
    expect(state.kind).toBe('pr_opened')
    expect(allEffects.filter((e) => e.type === 'ENABLE_AUTO_MERGE')).toHaveLength(0)

    // Task 2 DONE → no STORY_COMPLETED yet, no transition emitted
    r = transition(state, { type: 'TASK_DONE', taskId: 't2', headSha: 'abc123' })
    state = r.nextState
    allEffects.push(...r.effects)
    expect(state.kind).toBe('pr_opened')
    expect(allEffects.filter((e) => e.type === 'ENABLE_AUTO_MERGE')).toHaveLength(0)

    // Task 3 DONE = STORY_COMPLETED → ENABLE_AUTO_MERGE with head guard
    r = transition(state, { type: 'STORY_COMPLETED', storyId: 's1', headSha: 'def456' })
    state = r.nextState
    allEffects.push(...r.effects)
    expect(state.kind).toBe('waiting_for_checks')
    const enableEffects = allEffects.filter((e) => e.type === 'ENABLE_AUTO_MERGE')
    expect(enableEffects).toHaveLength(1)
    expect(enableEffects[0]).toMatchObject({ expectedHeadSha: 'def456' })

    // CI green + merge OK
    r = transition(state, { type: 'MERGE_RESULT' })
    state = r.nextState
    expect(state.kind).toBe('auto_merge_enabled')
  })

  it('CHECKS_FAILED → checks_failed (no pause)', () => {
    const state: PrFlowState = {
      kind: 'waiting_for_checks',
      strategy: 'STORY',
      prUrl: 'x',
      headSha: 'y',
    }
    const r = transition(state, { type: 'MERGE_RESULT', reason: 'CHECKS_FAILED' })
    expect(r.nextState.kind).toBe('checks_failed')
  })

  it('MERGE_CONFLICT → merge_conflict_paused', () => {
    const state: PrFlowState = {
      kind: 'waiting_for_checks',
      strategy: 'STORY',
      prUrl: 'x',
      headSha: 'y',
    }
    const r = transition(state, { type: 'MERGE_RESULT', reason: 'MERGE_CONFLICT' })
    expect(r.nextState.kind).toBe('merge_conflict_paused')
  })
})

describe('pr-flow SPRINT-mode', () => {
  it('draft stays draft until SPRINT_COMPLETED → MARK_PR_READY effect', () => {
    let state: PrFlowState = { kind: 'none', strategy: 'SPRINT' }
    let r = transition(state, { type: 'PR_CREATED', prUrl: 'x' })
    expect(r.nextState.kind).toBe('draft_opened')
    expect(r.effects).toHaveLength(0)

    state = r.nextState
    r = transition(state, { type: 'TASK_DONE', taskId: 't1', headSha: 'a' })
    expect(r.nextState.kind).toBe('draft_opened')
    expect(r.effects).toHaveLength(0)

    state = r.nextState
    r = transition(state, { type: 'SPRINT_COMPLETED', sprintRunId: 'sr1' })
    expect(r.nextState.kind).toBe('ready_for_review')
    expect(r.effects.filter((e) => e.type === 'MARK_PR_READY')).toHaveLength(1)
  })
})
