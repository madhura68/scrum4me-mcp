import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock node:child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

import { execFile } from 'node:child_process'
import { enableAutoMergeOnPr } from '../../src/git/pr.js'

const mockExecFile = vi.mocked(execFile) as unknown as ReturnType<typeof vi.fn>

function mockGhFailure(stderr: string) {
  mockExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: any) => {
    cb(Object.assign(new Error('gh exit'), { stderr }))
  }) as never)
}

function mockGhSuccess() {
  mockExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: any) => {
    cb(null, { stdout: '', stderr: '' })
  }) as never)
}

describe('enableAutoMergeOnPr — typed errors (PBI-47 C2 layer 1)', () => {
  beforeEach(() => {
    mockExecFile.mockReset()
  })

  it('returns ok:true on green merge', async () => {
    mockGhSuccess()
    const result = await enableAutoMergeOnPr({ prUrl: 'x', expectedHeadSha: 'sha1' })
    expect(result.ok).toBe(true)
  })

  it('classifies GH_AUTH_ERROR for 401/403 / permission strings', async () => {
    mockGhFailure('gh: HTTP 403: permission denied')
    const result = await enableAutoMergeOnPr({ prUrl: 'x', expectedHeadSha: 'sha1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('GH_AUTH_ERROR')
  })

  it('classifies AUTO_MERGE_NOT_ALLOWED for repo-setting refusal', async () => {
    mockGhFailure('auto-merge is not allowed for this repository')
    const result = await enableAutoMergeOnPr({ prUrl: 'x', expectedHeadSha: 'sha1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('AUTO_MERGE_NOT_ALLOWED')
  })

  it('classifies MERGE_CONFLICT for dirty merge state', async () => {
    mockGhFailure('pull request is not in a mergeable state (dirty)')
    const result = await enableAutoMergeOnPr({ prUrl: 'x', expectedHeadSha: 'sha1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('MERGE_CONFLICT')
  })

  it('classifies UNKNOWN for unrecognised stderr', async () => {
    mockGhFailure('unexpected gh error')
    const result = await enableAutoMergeOnPr({ prUrl: 'x', expectedHeadSha: 'sha1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('UNKNOWN')
  })

  it('passes --match-head-commit when expectedHeadSha provided', async () => {
    mockGhSuccess()
    await enableAutoMergeOnPr({ prUrl: 'pr-url', expectedHeadSha: 'abc123' })
    const callArgs = mockExecFile.mock.calls[0]
    expect(callArgs[0]).toBe('gh')
    const args = callArgs[1] as string[]
    expect(args).toContain('--match-head-commit')
    expect(args).toContain('abc123')
    expect(args).toContain('--auto')
    expect(args).toContain('--squash')
  })
})
