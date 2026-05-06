import { describe, it, expect } from 'vitest'
import { transition, type WorktreeLeaseState } from '../../src/flow/worktree-lease.js'

describe('worktree-lease pure transitions', () => {
  it('idle + JOB_CLAIMED → acquiring_lock, no effects', () => {
    const r = transition({ kind: 'idle' }, { type: 'JOB_CLAIMED', jobId: 'j1', productIds: ['p1'] })
    expect(r.nextState.kind).toBe('acquiring_lock')
    expect(r.effects).toEqual([])
  })

  it('acquiring_lock + LOCK_ACQUIRED → creating_or_reusing', () => {
    const state: WorktreeLeaseState = {
      kind: 'acquiring_lock',
      jobId: 'j1',
      productIds: ['p1'],
    }
    const r = transition(state, { type: 'LOCK_ACQUIRED' })
    expect(r.nextState.kind).toBe('creating_or_reusing')
    expect(r.effects).toEqual([])
  })

  it('acquiring_lock + LOCK_TIMEOUT → lock_timeout', () => {
    const state: WorktreeLeaseState = {
      kind: 'acquiring_lock',
      jobId: 'j1',
      productIds: ['p1'],
    }
    const r = transition(state, { type: 'LOCK_TIMEOUT' })
    expect(r.nextState.kind).toBe('lock_timeout')
  })

  it('creating_or_reusing + WORKTREE_READY → syncing', () => {
    const r = transition(
      { kind: 'creating_or_reusing', jobId: 'j1', productIds: ['p1'] },
      { type: 'WORKTREE_READY' },
    )
    expect(r.nextState.kind).toBe('syncing')
  })

  it('syncing + SYNC_DONE → ready (no release effect yet)', () => {
    const r = transition(
      { kind: 'syncing', jobId: 'j1', productIds: ['p1'] },
      { type: 'SYNC_DONE' },
    )
    expect(r.nextState.kind).toBe('ready')
    expect(r.effects).toEqual([])
  })

  it('syncing + SYNC_FAILED → sync_failed + RELEASE_WORKTREE_LOCKS effect', () => {
    const r = transition(
      { kind: 'syncing', jobId: 'j1', productIds: ['p1'] },
      { type: 'SYNC_FAILED', error: 'boom' },
    )
    expect(r.nextState.kind).toBe('sync_failed')
    expect(r.effects).toEqual([{ type: 'RELEASE_WORKTREE_LOCKS', jobId: 'j1' }])
  })

  it('ready + JOB_TERMINAL → releasing + RELEASE_WORKTREE_LOCKS effect', () => {
    const r = transition(
      { kind: 'ready', jobId: 'j1', productIds: ['p1'] },
      { type: 'JOB_TERMINAL', jobId: 'j1' },
    )
    expect(r.nextState.kind).toBe('releasing')
    expect(r.effects).toEqual([{ type: 'RELEASE_WORKTREE_LOCKS', jobId: 'j1' }])
  })

  it('ready + STALE_RESET → stale_released + RELEASE_WORKTREE_LOCKS effect', () => {
    const r = transition(
      { kind: 'ready', jobId: 'j1', productIds: ['p1'] },
      { type: 'STALE_RESET', jobId: 'j1' },
    )
    expect(r.nextState.kind).toBe('stale_released')
    expect(r.effects).toEqual([{ type: 'RELEASE_WORKTREE_LOCKS', jobId: 'j1' }])
  })

  it('forbidden transition (idle + LOCK_ACQUIRED) keeps state, no effects', () => {
    const state: WorktreeLeaseState = { kind: 'idle' }
    const r = transition(state, { type: 'LOCK_ACQUIRED' })
    expect(r.nextState).toEqual(state)
    expect(r.effects).toEqual([])
  })
})
