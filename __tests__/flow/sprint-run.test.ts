import { describe, it, expect } from 'vitest'
import { transition, type SprintRunState } from '../../src/flow/sprint-run.js'

describe('sprint-run pure transitions', () => {
  it('queued + CLAIM_FIRST_JOB → running with SET_SPRINT_RUN_STATUS effect', () => {
    const state: SprintRunState = { kind: 'queued', sprintRunId: 'sr1' }
    const r = transition(state, { type: 'CLAIM_FIRST_JOB' })
    expect(r.nextState.kind).toBe('running')
    expect(r.effects).toEqual([
      { type: 'SET_SPRINT_RUN_STATUS', sprintRunId: 'sr1', status: 'RUNNING' },
    ])
  })

  it('running + MERGE_CONFLICT → paused_merge_conflict + 2 effects in order', () => {
    const state: SprintRunState = { kind: 'running', sprintRunId: 'sr1' }
    const r = transition(state, {
      type: 'MERGE_CONFLICT',
      prUrl: 'https://github.com/o/r/pull/1',
      prHeadSha: 'abc123',
      conflictFiles: ['a.ts', 'b.ts'],
      resumeInstructions: 'Resolve and push',
    })
    expect(r.nextState.kind).toBe('paused_merge_conflict')
    expect(r.effects).toHaveLength(2)
    expect(r.effects[0].type).toBe('CREATE_CLAUDE_QUESTION')
    expect(r.effects[1].type).toBe('SET_SPRINT_RUN_STATUS')
    if (r.effects[1].type === 'SET_SPRINT_RUN_STATUS') {
      expect(r.effects[1].status).toBe('PAUSED')
      expect(r.effects[1].pauseContextDraft).toMatchObject({
        pause_reason: 'MERGE_CONFLICT',
        pr_url: 'https://github.com/o/r/pull/1',
        pr_head_sha: 'abc123',
        conflict_files: ['a.ts', 'b.ts'],
      })
    }
  })

  it('paused + USER_RESUMED → running + CLOSE_CLAUDE_QUESTION + clear pause_context', () => {
    const state: SprintRunState = {
      kind: 'paused_merge_conflict',
      sprintRunId: 'sr1',
      pauseContext: {
        pause_reason: 'MERGE_CONFLICT',
        pr_url: 'x',
        pr_head_sha: 'y',
        conflict_files: [],
        claude_question_id: 'q1',
        resume_instructions: 'r',
        paused_at: new Date().toISOString(),
      },
    }
    const r = transition(state, { type: 'USER_RESUMED' })
    expect(r.nextState.kind).toBe('running')
    expect(r.effects[0]).toEqual({ type: 'CLOSE_CLAUDE_QUESTION', questionId: 'q1' })
    expect(r.effects[1]).toMatchObject({
      type: 'SET_SPRINT_RUN_STATUS',
      status: 'RUNNING',
      clearPauseContext: true,
    })
  })

  it('running + TASK_FAILED → failed (no PAUSE)', () => {
    const state: SprintRunState = { kind: 'running', sprintRunId: 'sr1' }
    const r = transition(state, { type: 'TASK_FAILED', taskId: 't1', error: 'CI red' })
    expect(r.nextState.kind).toBe('failed')
    expect(r.effects[0]).toMatchObject({ status: 'FAILED' })
  })

  it('running + ALL_DONE → done + SET_SPRINT_RUN_STATUS DONE', () => {
    const state: SprintRunState = { kind: 'running', sprintRunId: 'sr1' }
    const r = transition(state, { type: 'ALL_DONE' })
    expect(r.nextState.kind).toBe('done')
    expect(r.effects[0]).toMatchObject({ status: 'DONE' })
  })

  it('forbidden transition (running + CLAIM_FIRST_JOB) keeps state and emits no effects', () => {
    const state: SprintRunState = { kind: 'running', sprintRunId: 'sr1' }
    const r = transition(state, { type: 'CLAIM_FIRST_JOB' })
    expect(r.nextState).toEqual(state)
    expect(r.effects).toEqual([])
  })
})
