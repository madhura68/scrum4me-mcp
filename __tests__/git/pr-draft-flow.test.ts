import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: mockExecFile }))

import { clearDiscoveryCache } from '../../src/git/forgejo-rest.js'
import { createPullRequest } from '../../src/git/pr.js'

type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void

beforeEach(() => {
  process.env.FORGEJO_HOST = 'git.jp-visser.nl'
  process.env.FORGEJO_TOKEN = 'test-token'
  delete process.env.FORGEJO_HOSTS
  mockExecFile.mockReset()
  mockExecFile.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return cb(null, { stdout: 'https://git.jp-visser.nl/scrum/mcp.git\n', stderr: '' })
      }
      cb(null, { stdout: '', stderr: '' })
    },
  )
  clearDiscoveryCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Forgejo 15.0.2 heeft geen `draft`-veld in POST /pulls (verified live).
// Onze fallback is een title-prefix `WIP: ` zodat sprint-mode PRs herkenbaar
// blijven en de title-PATCH-strip-strategie van markPullRequestReady werkt.
describe('createPullRequest — draft=true → WIP: prefix (Forgejo 15.0.2 fallback)', () => {
  it('draft=true → title in POST-body krijgt "WIP: " prefix', async () => {
    let postBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        postBody = init.body as string
        return new Response(
          JSON.stringify({
            number: 1,
            html_url: 'https://git.jp-visser.nl/scrum/mcp/pulls/1',
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            title: 'WIP: Sprint draft',
            body: '',
            base: { ref: 'main' },
            head: { ref: 'sprint/x', sha: 'sha' },
          }),
          { status: 201 },
        )
      }),
    )

    const result = await createPullRequest({
      worktreePath: '/wt/sprint',
      branchName: 'sprint/sprint-12345678',
      title: 'Sprint: Cascade-flow live',
      body: 'Sprint draft',
      draft: true,
    })

    expect(result).toEqual({ url: 'https://git.jp-visser.nl/scrum/mcp/pulls/1' })
    const parsed = JSON.parse(postBody)
    expect(parsed.title).toBe('WIP: Sprint: Cascade-flow live')
    expect(parsed.head).toBe('sprint/sprint-12345678')
    expect(parsed.base).toBe('main')
    // Crucial: er mag GEEN `draft` veld in body zitten — Forgejo 15.0.2 zou het stilletjes
    // negeren en je raakt synchronisatie kwijt met de WIP-detectie van markPullRequestReady.
    expect(parsed.draft).toBeUndefined()
  })

  it('draft=false → title onveranderd, geen WIP-prefix', async () => {
    let postBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        postBody = init.body as string
        return new Response(
          JSON.stringify({
            number: 2,
            html_url: 'https://git.jp-visser.nl/scrum/mcp/pulls/2',
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            title: 'PBI-12: feature',
            body: '',
            base: { ref: 'main' },
            head: { ref: 'feat/x', sha: 'sha' },
          }),
          { status: 201 },
        )
      }),
    )

    await createPullRequest({
      worktreePath: '/wt/x',
      branchName: 'feat/x',
      title: 'PBI-12: feature',
      body: 'body',
      draft: false,
    })

    const parsed = JSON.parse(postBody)
    expect(parsed.title).toBe('PBI-12: feature')
    expect(parsed.title.startsWith('WIP:')).toBe(false)
  })

  it('draft=true + enableAutoMerge=true → auto-merge wordt overgeslagen', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/pulls') && init.method === 'POST') {
        return new Response(
          JSON.stringify({
            number: 3,
            html_url: 'https://git.jp-visser.nl/scrum/mcp/pulls/3',
            state: 'open',
            merged: false,
            merge_commit_sha: null,
            title: 'WIP: x',
            body: '',
            base: { ref: 'main' },
            head: { ref: 'sprint/x', sha: 'sha' },
          }),
          { status: 201 },
        )
      }
      // Als auto-merge per ongeluk getriggerd wordt → mark this test failed.
      if (url.endsWith('/merge')) {
        throw new Error('merge should NOT have been called for draft PR')
      }
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPullRequest({
      worktreePath: '/wt/sprint',
      branchName: 'sprint/x',
      title: 'X',
      body: 'b',
      draft: true,
      enableAutoMerge: true,
    })

    expect(result).toEqual({ url: 'https://git.jp-visser.nl/scrum/mcp/pulls/3' })
    // Géén /merge-call: alleen POST /pulls.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
