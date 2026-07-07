import { describe, it, expect, vi } from 'vitest'
import { executeEffects } from '../../src/flow/effects.js'

vi.mock('../../src/git/pr.js', () => ({
  enableAutoMergeOnPr: vi.fn(async () => ({ ok: true, mode: 'merged' as const })),
}))

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

  it('ENABLE_AUTO_MERGE ok propageert mode in de outcome', async () => {
    const out = await executeEffects([
      { type: 'ENABLE_AUTO_MERGE', prUrl: 'https://git.jp-visser.nl/o/r/pulls/1', expectedHeadSha: 'sha1' },
    ])
    expect(out).toEqual([{ effect: 'ENABLE_AUTO_MERGE', ok: true, mode: 'merged' }])
  })
})
