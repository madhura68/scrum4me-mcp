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

import { createPullRequest, markPullRequestReady } from '../../src/git/pr.js'

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

  it('passes --draft when draft=true en slaat auto-merge over', async () => {
    const calls: string[][] = []
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: null, res: { stdout: string; stderr: string }) => void,
      ) => {
        calls.push(args)
        cb(null, {
          stdout: 'Creating draft pull request...\nhttps://github.com/org/repo/pull/100\n',
          stderr: '',
        })
      },
    )

    const result = await createPullRequest({
      worktreePath: '/wt/sprint-1',
      branchName: 'feat/sprint-12345678',
      title: 'Sprint: Cascade-flow live',
      body: 'Sprint draft',
      draft: true,
      enableAutoMerge: false,
    })

    expect(result).toEqual({ url: 'https://github.com/org/repo/pull/100' })
    expect(calls.some((a) => a.includes('--draft'))).toBe(true)
    // gh pr merge --auto mag NIET gestart zijn voor draft + auto-merge=false
    expect(calls.some((a) => a[0] === 'pr' && a[1] === 'merge')).toBe(false)
  })
})

describe('markPullRequestReady', () => {
  it('roept gh pr ready aan met de PR-URL', async () => {
    const calls: string[][] = []
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (err: null, res: { stdout: string; stderr: string }) => void,
      ) => {
        calls.push(args)
        cb(null, { stdout: '', stderr: '' })
      },
    )

    const result = await markPullRequestReady({ prUrl: 'https://github.com/org/repo/pull/100' })

    expect(result).toEqual({ ok: true })
    expect(calls[0]).toEqual(['pr', 'ready', 'https://github.com/org/repo/pull/100'])
  })

  it('behandelt "already ready" als success', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) =>
        cb(Object.assign(new Error(''), { stderr: 'Pull request is not in draft state' })),
    )

    const result = await markPullRequestReady({ prUrl: 'https://github.com/org/repo/pull/100' })

    expect(result).toEqual({ ok: true })
  })

  it('retourneert error op onverwachte gh-fout', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) =>
        cb(new Error('rate limit exceeded')),
    )

    const result = await markPullRequestReady({ prUrl: 'https://github.com/org/repo/pull/100' })

    expect(result).toMatchObject({ error: expect.stringContaining('gh pr ready failed') })
  })
})
