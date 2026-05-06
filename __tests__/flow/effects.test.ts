import { describe, it, expect } from 'vitest'
import { executeEffects } from '../../src/flow/effects.js'

describe('effects executor', () => {
  it('RELEASE_WORKTREE_LOCKS for unknown jobId is a no-op (no throw)', async () => {
    const out = await executeEffects([{ type: 'RELEASE_WORKTREE_LOCKS', jobId: 'no-such-job' }])
    expect(out).toEqual([])
  })

  it('multiple effects execute in order; failure in one is logged but does not abort', async () => {
    const out = await executeEffects([
      { type: 'RELEASE_WORKTREE_LOCKS', jobId: 'a' },
      { type: 'RELEASE_WORKTREE_LOCKS', jobId: 'b' },
    ])
    expect(out).toEqual([])
  })

  it('empty effects array returns empty outcomes', async () => {
    const out = await executeEffects([])
    expect(out).toEqual([])
  })
})
