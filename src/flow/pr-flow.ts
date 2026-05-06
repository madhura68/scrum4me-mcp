import type { FlowEffect } from './effects.js'
import type { AutoMergeFailReason } from '../git/pr.js'

export type PrStrategy = 'STORY' | 'SPRINT'

export type PrFlowState =
  | { kind: 'none'; strategy: PrStrategy }
  | { kind: 'branch_pushed'; strategy: PrStrategy; prUrl?: string }
  | { kind: 'pr_opened'; strategy: 'STORY'; prUrl: string }
  | { kind: 'draft_opened'; strategy: 'SPRINT'; prUrl: string }
  | { kind: 'waiting_for_checks'; strategy: 'STORY'; prUrl: string; headSha: string }
  | { kind: 'auto_merge_enabled'; strategy: 'STORY'; prUrl: string; headSha: string }
  | { kind: 'ready_for_review'; strategy: 'SPRINT'; prUrl: string }
  | { kind: 'merged'; strategy: PrStrategy; prUrl: string }
  | { kind: 'checks_failed'; strategy: PrStrategy; prUrl: string }
  | { kind: 'merge_conflict_paused'; strategy: PrStrategy; prUrl: string; headSha: string }

export type PrFlowEvent =
  | { type: 'PR_CREATED'; prUrl: string }
  | { type: 'TASK_DONE'; taskId: string; headSha: string }
  | { type: 'STORY_COMPLETED'; storyId: string; headSha: string }
  | { type: 'SPRINT_COMPLETED'; sprintRunId: string }
  | { type: 'MERGE_RESULT'; reason?: AutoMergeFailReason }

export type TransitionResult = { nextState: PrFlowState; effects: FlowEffect[] }

export function transition(state: PrFlowState, event: PrFlowEvent): TransitionResult {
  if (state.strategy === 'STORY') {
    switch (state.kind) {
      case 'none':
      case 'branch_pushed':
        if (event.type === 'PR_CREATED') {
          return {
            nextState: { kind: 'pr_opened', strategy: 'STORY', prUrl: event.prUrl },
            effects: [],
          }
        }
        break
      case 'pr_opened':
        if (event.type === 'STORY_COMPLETED') {
          return {
            nextState: {
              kind: 'waiting_for_checks',
              strategy: 'STORY',
              prUrl: state.prUrl,
              headSha: event.headSha,
            },
            effects: [
              { type: 'ENABLE_AUTO_MERGE', prUrl: state.prUrl, expectedHeadSha: event.headSha },
            ],
          }
        }
        break
      case 'waiting_for_checks':
        if (event.type === 'MERGE_RESULT' && !event.reason) {
          return {
            nextState: {
              kind: 'auto_merge_enabled',
              strategy: 'STORY',
              prUrl: state.prUrl,
              headSha: state.headSha,
            },
            effects: [],
          }
        }
        if (event.type === 'MERGE_RESULT' && event.reason === 'MERGE_CONFLICT') {
          return {
            nextState: {
              kind: 'merge_conflict_paused',
              strategy: 'STORY',
              prUrl: state.prUrl,
              headSha: state.headSha,
            },
            effects: [],
          }
        }
        if (event.type === 'MERGE_RESULT' && event.reason === 'CHECKS_FAILED') {
          return {
            nextState: { kind: 'checks_failed', strategy: 'STORY', prUrl: state.prUrl },
            effects: [],
          }
        }
        break
    }
  }

  if (state.strategy === 'SPRINT') {
    switch (state.kind) {
      case 'none':
      case 'branch_pushed':
        if (event.type === 'PR_CREATED') {
          return {
            nextState: { kind: 'draft_opened', strategy: 'SPRINT', prUrl: event.prUrl },
            effects: [],
          }
        }
        break
      case 'draft_opened':
        if (event.type === 'SPRINT_COMPLETED') {
          return {
            nextState: { kind: 'ready_for_review', strategy: 'SPRINT', prUrl: state.prUrl },
            effects: [{ type: 'MARK_PR_READY', prUrl: state.prUrl }],
          }
        }
        break
    }
  }

  return { nextState: state, effects: [] }
}
