import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: mockExecFile }))
vi.mock('node:util', () => ({
  promisify:
    (fn: (...args: unknown[]) => void) =>
    (...args: unknown[]) =>
      new Promise((resolve, reject) =>
        fn(...args, (err: Error | null, result: unknown) => (err ? reject(err) : resolve(result))),
      ),
}))

import { createPullRequest } from '../../src/git/pr.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createPullRequest', () => {
  it('returns PR URL when gh succeeds', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, res: { stdout: string; stderr: string }) => void) =>
        cb(null, { stdout: 'Creating pull request...\nhttps://github.com/org/repo/pull/42\n', stderr: '' }),
    )

    const result = await createPullRequest({
      worktreePath: '/worktrees/job-abc',
      branchName: 'feat/job-abc',
      title: 'SCRUM-1: Add feature',
      body: 'Summary\n\n---\n\n*Auto-generated*',
    })

    expect(result).toEqual({ url: 'https://github.com/org/repo/pull/42' })
  })

  it('returns error when gh is not installed (ENOENT)', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) =>
        cb(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })),
    )

    const result = await createPullRequest({
      worktreePath: '/worktrees/job-abc',
      branchName: 'feat/job-abc',
      title: 'My PR',
      body: 'Body',
    })

    expect(result).toMatchObject({ error: expect.stringContaining('gh CLI not found') })
  })

  it('returns error on generic gh failure', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) =>
        cb(new Error('authentication required')),
    )

    const result = await createPullRequest({
      worktreePath: '/worktrees/job-abc',
      branchName: 'feat/job-abc',
      title: 'My PR',
      body: 'Body',
    })

    expect(result).toMatchObject({ error: expect.stringContaining('gh pr create failed') })
  })
})
