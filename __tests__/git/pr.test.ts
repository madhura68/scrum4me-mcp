import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// node:child_process is alleen voor `git remote get-url origin` (host detect)
// en — in revert-tests — voor de worktree-/git-revert-pad. createPullRequest
// + markPullRequestReady gaan via fetch.
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: mockExecFile }))

import { clearDiscoveryCache } from '../../src/git/forgejo-rest.js'
import { createPullRequest, markPullRequestReady } from '../../src/git/pr.js'

const FORGEJO_ORIGIN = 'https://git.jp-visser.nl/scrum/mcp.git'

type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void

function mockGitRemote(originUrl: string = FORGEJO_ORIGIN) {
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return cb(null, { stdout: `${originUrl}\n`, stderr: '' })
      }
      cb(null, { stdout: '', stderr: '' })
    },
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

describe('createPullRequest', () => {
  it('returns PR html_url op 201', async () => {
    mockGitRemote()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            number: 42,
            html_url: 'https://git.jp-visser.nl/scrum/mcp/pulls/42',
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            title: 'SCRUM-1: Add feature',
            body: '',
            base: { ref: 'main' },
            head: { ref: 'feat/x', sha: 'abc' },
          }),
          { status: 201 },
        ),
      ),
    )

    const result = await createPullRequest({
      worktreePath: '/wt/job-abc',
      branchName: 'feat/job-abc',
      title: 'SCRUM-1: Add feature',
      body: 'Summary',
    })

    expect(result).toEqual({ url: 'https://git.jp-visser.nl/scrum/mcp/pulls/42' })
  })

  it('stuurt POST /api/v1/repos/owner/repo/pulls met correcte body', async () => {
    mockGitRemote()
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url
        capturedInit = init
        return new Response(
          JSON.stringify({
            number: 7,
            html_url: 'https://git.jp-visser.nl/scrum/mcp/pulls/7',
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            title: 'X',
            body: '',
            base: { ref: 'main' },
            head: { ref: 'feat/job-abc', sha: 'sha' },
          }),
          { status: 201 },
        )
      }),
    )

    await createPullRequest({
      worktreePath: '/wt/job-abc',
      branchName: 'feat/job-abc',
      title: 'X',
      body: 'Summary',
    })

    expect(capturedUrl).toBe('https://git.jp-visser.nl/api/v1/repos/scrum/mcp/pulls')
    expect(capturedInit?.method).toBe('POST')
    expect(capturedInit?.body).toBe(
      JSON.stringify({ head: 'feat/job-abc', base: 'main', title: 'X', body: 'Summary' }),
    )
    const headers = capturedInit?.headers as Headers
    expect(headers.get('Authorization')).toBe('token test-token')
  })

  it('JSON-body branchname behoudt raw slashes (geen url-encoding)', async () => {
    mockGitRemote()
    let capturedBody: string | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = init.body as string
        return new Response(
          JSON.stringify({
            number: 1,
            html_url: 'https://git.jp-visser.nl/scrum/mcp/pulls/1',
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            title: '',
            body: '',
            base: { ref: 'main' },
            head: { ref: 'feat/foo/bar', sha: 'sha' },
          }),
          { status: 201 },
        )
      }),
    )

    await createPullRequest({
      worktreePath: '/wt/x',
      branchName: 'feat/foo/bar',
      title: 't',
      body: 'b',
    })

    expect(capturedBody).toContain('"head":"feat/foo/bar"')
    expect(capturedBody).not.toContain('feat%2Ffoo')
  })

  it('Forgejo 5xx → error met geredigeerde message', async () => {
    mockGitRemote()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('internal server error', { status: 500 })),
    )

    const result = await createPullRequest({
      worktreePath: '/wt/x',
      branchName: 'feat/x',
      title: 't',
      body: 'b',
    })

    expect(result).toMatchObject({ error: expect.stringContaining('Forgejo pr-create failed') })
  })

  it('GitHub remote URL → LEGACY_GITHUB_URL error', async () => {
    mockGitRemote('https://github.com/org/repo.git')
    vi.stubGlobal('fetch', vi.fn())

    const result = await createPullRequest({
      worktreePath: '/wt/x',
      branchName: 'feat/x',
      title: 't',
      body: 'b',
    })

    expect(result).toMatchObject({
      error: expect.stringContaining('Forgejo is leidend'),
    })
  })
})

describe('markPullRequestReady', () => {
  it('strip "WIP: " prefix uit title via PATCH', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init })
        if (init.method === undefined || init.method === 'GET') {
          return new Response(
            JSON.stringify({
              number: 100,
              html_url: 'https://git.jp-visser.nl/scrum/mcp/pulls/100',
              state: 'open',
              merged: false,
              merge_commit_sha: null,
              title: 'WIP: Sprint Demo',
              body: '',
              base: { ref: 'main' },
              head: { ref: 'sprint/x', sha: 'sha' },
            }),
            { status: 200 },
          )
        }
        return new Response('{}', { status: 200 })
      }),
    )

    const result = await markPullRequestReady({
      prUrl: 'https://git.jp-visser.nl/scrum/mcp/pulls/100',
    })

    expect(result).toEqual({ ok: true })
    expect(calls.length).toBe(2)
    expect(calls[0]?.url).toBe('https://git.jp-visser.nl/api/v1/repos/scrum/mcp/pulls/100')
    expect(calls[1]?.init.method).toBe('PATCH')
    expect(calls[1]?.init.body).toBe(JSON.stringify({ title: 'Sprint Demo' }))
  })

  it('strip "[WIP] " prefix variant', async () => {
    let patchedBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        if (init.method === 'PATCH') {
          patchedBody = init.body as string
          return new Response('{}', { status: 200 })
        }
        return new Response(
          JSON.stringify({
            number: 100,
            html_url: 'https://git.jp-visser.nl/scrum/mcp/pulls/100',
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            title: '[WIP] Sprint Demo',
            body: '',
            base: { ref: 'main' },
            head: { ref: 'sprint/x', sha: 'sha' },
          }),
          { status: 200 },
        )
      }),
    )

    const result = await markPullRequestReady({
      prUrl: 'https://git.jp-visser.nl/scrum/mcp/pulls/100',
    })

    expect(result).toEqual({ ok: true })
    expect(patchedBody).toBe(JSON.stringify({ title: 'Sprint Demo' }))
  })

  it('idempotent: zonder prefix wordt geen PATCH gedaan', async () => {
    const calls: { url: string; method?: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: init.method })
        return new Response(
          JSON.stringify({
            number: 100,
            html_url: 'https://git.jp-visser.nl/scrum/mcp/pulls/100',
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            title: 'Already Ready Title',
            body: '',
            base: { ref: 'main' },
            head: { ref: 'sprint/x', sha: 'sha' },
          }),
          { status: 200 },
        )
      }),
    )

    const result = await markPullRequestReady({
      prUrl: 'https://git.jp-visser.nl/scrum/mcp/pulls/100',
    })

    expect(result).toEqual({ ok: true })
    expect(calls.length).toBe(1)
    expect(calls[0]?.method).toBeUndefined()
  })

  it('returnt error op 500 bij GET', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )

    const result = await markPullRequestReady({
      prUrl: 'https://git.jp-visser.nl/scrum/mcp/pulls/100',
    })

    expect(result).toMatchObject({ error: expect.stringContaining('Forgejo pr-get failed') })
  })

  it('github.com URL → typed error met LEGACY_GITHUB_URL boodschap', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const result = await markPullRequestReady({
      prUrl: 'https://github.com/org/repo/pull/100',
    })

    expect(result).toMatchObject({
      error: expect.stringContaining('Forgejo is leidend'),
    })
  })
})
