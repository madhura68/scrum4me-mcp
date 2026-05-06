import type { FlowEffect } from './effects.js'

export type WorktreeLeaseState =
  | { kind: 'idle' }
  | { kind: 'acquiring_lock'; jobId: string; productIds: string[] }
  | { kind: 'creating_or_reusing'; jobId: string; productIds: string[] }
  | { kind: 'syncing'; jobId: string; productIds: string[] }
  | { kind: 'ready'; jobId: string; productIds: string[] }
  | { kind: 'releasing'; jobId: string }
  | { kind: 'released'; jobId: string }
  | { kind: 'lock_timeout'; jobId: string; productIds: string[] }
  | { kind: 'sync_failed'; jobId: string; productIds: string[]; error: string }
  | { kind: 'stale_released'; jobId: string }

export type WorktreeLeaseEvent =
  | { type: 'JOB_CLAIMED'; jobId: string; productIds: string[] }
  | { type: 'LOCK_ACQUIRED' }
  | { type: 'LOCK_TIMEOUT' }
  | { type: 'WORKTREE_READY' }
  | { type: 'SYNC_DONE' }
  | { type: 'SYNC_FAILED'; error: string }
  | { type: 'JOB_TERMINAL'; jobId: string }
  | { type: 'STALE_RESET'; jobId: string }

export type TransitionResult = {
  nextState: WorktreeLeaseState
  effects: FlowEffect[]
}

export function transition(
  state: WorktreeLeaseState,
  event: WorktreeLeaseEvent,
): TransitionResult {
  switch (state.kind) {
    case 'idle':
      if (event.type === 'JOB_CLAIMED') {
        return {
          nextState: { kind: 'acquiring_lock', jobId: event.jobId, productIds: event.productIds },
          effects: [],
        }
      }
      break
    case 'acquiring_lock':
      if (event.type === 'LOCK_ACQUIRED') {
        return {
          nextState: { kind: 'creating_or_reusing', jobId: state.jobId, productIds: state.productIds },
          effects: [],
        }
      }
      if (event.type === 'LOCK_TIMEOUT') {
        return {
          nextState: { kind: 'lock_timeout', jobId: state.jobId, productIds: state.productIds },
          effects: [],
        }
      }
      break
    case 'creating_or_reusing':
      if (event.type === 'WORKTREE_READY') {
        return {
          nextState: { kind: 'syncing', jobId: state.jobId, productIds: state.productIds },
          effects: [],
        }
      }
      break
    case 'syncing':
      if (event.type === 'SYNC_DONE') {
        return {
          nextState: { kind: 'ready', jobId: state.jobId, productIds: state.productIds },
          effects: [],
        }
      }
      if (event.type === 'SYNC_FAILED') {
        return {
          nextState: {
            kind: 'sync_failed',
            jobId: state.jobId,
            productIds: state.productIds,
            error: event.error,
          },
          effects: [{ type: 'RELEASE_WORKTREE_LOCKS', jobId: state.jobId }],
        }
      }
      break
    case 'ready':
      if (event.type === 'JOB_TERMINAL') {
        return {
          nextState: { kind: 'releasing', jobId: state.jobId },
          effects: [{ type: 'RELEASE_WORKTREE_LOCKS', jobId: state.jobId }],
        }
      }
      if (event.type === 'STALE_RESET') {
        return {
          nextState: { kind: 'stale_released', jobId: state.jobId },
          effects: [{ type: 'RELEASE_WORKTREE_LOCKS', jobId: state.jobId }],
        }
      }
      break
    case 'releasing':
      return { nextState: { kind: 'released', jobId: state.jobId }, effects: [] }
  }
  // Unknown or forbidden transition — keep current state, no effects
  return { nextState: state, effects: [] }
}
