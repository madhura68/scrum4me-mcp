import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: mockExecFile }))

import { clearDiscoveryCache } from '../../src/git/forgejo-rest.js'
import { createRevertPullRequest } from '../../src/git/pr.js'

type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void

const SHA_SQUASH = 'a'.repeat(40)
const SHA_MERGE = 'b'.repeat(40)

function makeMock(opts: { mergeCommitOutput: string }) {
  const calls: string[][] = []
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      calls.push([...args])
      if (args[0] === 'cat-file') {
        return cb(null, { stdout: opts.mergeCommitOutput, stderr: '' })
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return cb(null, { stdout: 'https://git.jp-visser.nl/scrum/mcp.git\n', stderr: '' })
      }
      cb(null, { stdout: '', stderr: '' })
    },
  )
  return calls
}

function stubForgejoOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            number: 99,
            html_url: 'https://git.jp-visser.nl/scrum/mcp/pulls/99',
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            title: 'Revert: X',
            body: '',
            base: { ref: 'main' },
            head: { ref: 'revert/x', sha: 'r' },
          }),
          { status: 201 },
        ),
    ),
  )
}

beforeEach(() => {
  process.env.FORGEJO_HOST = 'git.jp-visser.nl'
  process.env.FORGEJO_TOKEN = 'test-token'
  delete process.env.FORGEJO_HOSTS
  mockExecFile.mockReset()
  clearDiscoveryCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createRevertPullRequest — parent-count detectie', () => {
  it('squash-merge (1 parent) → `git revert <sha>` zonder -m', async () => {
    const calls = makeMock({
      mergeCommitOutput: [
        `tree abc`,
        `parent ${'p'.repeat(40)}`,
        `author X`,
        ``,
        `squash merge of PR #1`,
      ].join('\n'),
    })
    stubForgejoOk()

    const result = await createRevertPullRequest({
      repoRoot: '/repo',
      mergeSha: SHA_SQUASH,
      baseRef: 'main',
      originalTitle: 'X',
      originalBranch: 'feat/x',
      jobId: 'job-1234-5678',
      pbiCode: 'PBI-1',
    })

    expect(result).toEqual({ url: 'https://git.jp-visser.nl/scrum/mcp/pulls/99' })
    const revertCall = calls.find((c) => c[0] === 'revert')
    expect(revertCall).toEqual(['revert', SHA_SQUASH, '--no-edit'])
    expect(revertCall).not.toContain('-m')
  })

  it('merge-commit (2 parents) → `git revert -m 1 <sha>`', async () => {
    const calls = makeMock({
      mergeCommitOutput: [
        `tree abc`,
        `parent ${'p'.repeat(40)}`,
        `parent ${'q'.repeat(40)}`,
        `author X`,
        ``,
        `Merge branch 'feat/x'`,
      ].join('\n'),
    })
    stubForgejoOk()

    const result = await createRevertPullRequest({
      repoRoot: '/repo',
      mergeSha: SHA_MERGE,
      baseRef: 'main',
      originalTitle: 'X',
      originalBranch: 'feat/x',
      jobId: 'job-9999-0000',
      pbiCode: 'PBI-2',
    })

    expect(result).toEqual({ url: 'https://git.jp-visser.nl/scrum/mcp/pulls/99' })
    const revertCall = calls.find((c) => c[0] === 'revert')
    expect(revertCall).toEqual(['revert', '-m', '1', SHA_MERGE, '--no-edit'])
  })

  it('cat-file failure → typed error voordat we git-revert pogen', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
        if (args[0] === 'cat-file') {
          return cb(
            Object.assign(new Error('cat-file failed'), { stderr: 'fatal: bad object' }),
          )
        }
        cb(null, { stdout: '', stderr: '' })
      },
    )

    const result = await createRevertPullRequest({
      repoRoot: '/repo',
      mergeSha: 'invalid-sha',
      baseRef: 'main',
      originalTitle: 'X',
      originalBranch: 'feat/x',
      jobId: 'job-1234-5678',
      pbiCode: 'PBI-1',
    })

    expect(result).toMatchObject({ error: expect.stringContaining('git cat-file failed') })
  })

  it('revert conflict → typed error met "conflicts" in message', async () => {
    const callCount = { revert: 0 }
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
        if (args[0] === 'cat-file') {
          return cb(null, {
            stdout: ['tree abc', `parent ${'p'.repeat(40)}`, 'author X', ''].join('\n'),
            stderr: '',
          })
        }
        if (args[0] === 'revert') {
          callCount.revert++
          return cb(
            Object.assign(new Error('revert failed'), {
              stderr: 'error: could not revert — conflict in src/foo.ts',
            }),
          )
        }
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return cb(null, { stdout: 'https://git.jp-visser.nl/scrum/mcp.git\n', stderr: '' })
        }
        cb(null, { stdout: '', stderr: '' })
      },
    )

    const result = await createRevertPullRequest({
      repoRoot: '/repo',
      mergeSha: SHA_SQUASH,
      baseRef: 'main',
      originalTitle: 'X',
      originalBranch: 'feat/x',
      jobId: 'job-1234-5678',
      pbiCode: 'PBI-1',
    })

    expect(result).toMatchObject({ error: expect.stringContaining('conflicts on') })
    expect(callCount.revert).toBe(1)
  })
})
