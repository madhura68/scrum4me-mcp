import type { FlowEffect, PauseContext } from './effects.js'

export type SprintRunStateKind =
  | 'queued'
  | 'running'
  | 'paused_merge_conflict'
  | 'done'
  | 'failed'
  | 'cancelled'

export type SprintRunState = {
  kind: SprintRunStateKind
  sprintRunId: string
  pauseContext?: PauseContext
}

export type SprintRunEvent =
  | { type: 'CLAIM_FIRST_JOB' }
  | { type: 'TASK_DONE'; taskId: string }
  | { type: 'TASK_FAILED'; taskId: string; error: string }
  | {
      type: 'MERGE_CONFLICT'
      prUrl: string
      prHeadSha: string
      conflictFiles: string[]
      resumeInstructions: string
    }
  | { type: 'USER_RESUMED' }
  | { type: 'USER_CANCELLED' }
  | { type: 'ALL_DONE' }

export type TransitionResult = { nextState: SprintRunState; effects: FlowEffect[] }

export function transition(state: SprintRunState, event: SprintRunEvent): TransitionResult {
  switch (state.kind) {
    case 'queued':
      if (event.type === 'CLAIM_FIRST_JOB') {
        return {
          nextState: { ...state, kind: 'running' },
          effects: [
            { type: 'SET_SPRINT_RUN_STATUS', sprintRunId: state.sprintRunId, status: 'RUNNING' },
          ],
        }
      }
      break
    case 'running':
      if (event.type === 'TASK_DONE') {
        return { nextState: state, effects: [] }
      }
      if (event.type === 'TASK_FAILED') {
        return {
          nextState: { ...state, kind: 'failed' },
          effects: [
            { type: 'SET_SPRINT_RUN_STATUS', sprintRunId: state.sprintRunId, status: 'FAILED' },
          ],
        }
      }
      if (event.type === 'ALL_DONE') {
        return {
          nextState: { ...state, kind: 'done' },
          effects: [
            { type: 'SET_SPRINT_RUN_STATUS', sprintRunId: state.sprintRunId, status: 'DONE' },
          ],
        }
      }
      if (event.type === 'MERGE_CONFLICT') {
        const pauseContextDraft: Omit<PauseContext, 'claude_question_id'> = {
          pause_reason: 'MERGE_CONFLICT',
          pr_url: event.prUrl,
          pr_head_sha: event.prHeadSha,
          conflict_files: event.conflictFiles,
          resume_instructions: event.resumeInstructions,
          paused_at: new Date().toISOString(),
        }
        return {
          nextState: { ...state, kind: 'paused_merge_conflict' },
          effects: [
            {
              type: 'CREATE_CLAUDE_QUESTION',
              sprintRunId: state.sprintRunId,
              prUrl: event.prUrl,
              files: event.conflictFiles,
            },
            {
              type: 'SET_SPRINT_RUN_STATUS',
              sprintRunId: state.sprintRunId,
              status: 'PAUSED',
              pauseContextDraft,
            },
          ],
        }
      }
      if (event.type === 'USER_CANCELLED') {
        return {
          nextState: { ...state, kind: 'cancelled' },
          effects: [
            { type: 'SET_SPRINT_RUN_STATUS', sprintRunId: state.sprintRunId, status: 'CANCELLED' },
          ],
        }
      }
      break
    case 'paused_merge_conflict':
      if (event.type === 'USER_RESUMED') {
        const closeQuestionEffects: FlowEffect[] = state.pauseContext
          ? [{ type: 'CLOSE_CLAUDE_QUESTION', questionId: state.pauseContext.claude_question_id }]
          : []
        return {
          nextState: { ...state, kind: 'running', pauseContext: undefined },
          effects: [
            ...closeQuestionEffects,
            {
              type: 'SET_SPRINT_RUN_STATUS',
              sprintRunId: state.sprintRunId,
              status: 'RUNNING',
              clearPauseContext: true,
            },
          ],
        }
      }
      if (event.type === 'USER_CANCELLED') {
        return {
          nextState: { ...state, kind: 'cancelled', pauseContext: undefined },
          effects: [
            {
              type: 'SET_SPRINT_RUN_STATUS',
              sprintRunId: state.sprintRunId,
              status: 'CANCELLED',
              clearPauseContext: true,
            },
          ],
        }
      }
      break
  }
  return { nextState: state, effects: [] }
}
