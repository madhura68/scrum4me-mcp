import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/git/forgejo-rest.js', async (orig) => {
  const actual = await orig<typeof import('../../src/git/forgejo-rest.js')>()
  return {
    ...actual,
    forgejoFetch: vi.fn(),
    callForgejo: vi.fn(),
    requireToken: vi.fn(() => 'tok'),
  }
})

import { forgejoFetch, callForgejo } from '../../src/git/forgejo-rest.js'
import { fetchPrDiff, postPullRequestReview } from '../../src/git/pr.js'

const PR = 'https://git.jp-visser.nl/janpeter/scrum4me-mcp/pulls/42'

beforeEach(() => { vi.clearAllMocks() })

describe('fetchPrDiff', () => {
  it('haalt de unified diff via de .diff-endpoint met forgejoFetch', async () => {
    vi.mocked(forgejoFetch).mockResolvedValue(new Response('diff --git a b', { status: 200 }))
    const out = await fetchPrDiff({ prUrl: PR })
    expect(out).toContain('diff --git')
    const calledPath = vi.mocked(forgejoFetch).mock.calls[0][0] as string
    expect(calledPath).toContain('/pulls/42.diff')
  })
  it('non-2xx → { error }', async () => {
    vi.mocked(forgejoFetch).mockResolvedValue(new Response('nope', { status: 404 }))
    const out = await fetchPrDiff({ prUrl: PR })
    expect(out).toHaveProperty('error')
  })
  it('ongeldige PR-URL → { error } zonder fetch', async () => {
    const out = await fetchPrDiff({ prUrl: 'https://github.com/x/y/pulls/1' })
    expect(out).toHaveProperty('error')
    expect(forgejoFetch).not.toHaveBeenCalled()
  })
})

describe('postPullRequestReview', () => {
  it('POST /pulls/{index}/reviews met event + body (write)', async () => {
    vi.mocked(callForgejo).mockResolvedValue({ id: 7 })
    const out = await postPullRequestReview({ prUrl: PR, event: 'REQUEST_CHANGES', body: 'x' })
    expect(out).toEqual({ ok: true, reviewId: 7 })
    const [path, init] = vi.mocked(callForgejo).mock.calls[0] as [string, any]
    expect(path).toContain('/pulls/42/reviews')
    expect(init.method).toBe('POST')
    expect(init.write).toBe(true)
    expect(init.json).toMatchObject({ event: 'REQUEST_CHANGES', body: 'x' })
  })
  it('commit_id wordt doorgegeven wanneer aanwezig', async () => {
    vi.mocked(callForgejo).mockResolvedValue({ id: 8 })
    await postPullRequestReview({ prUrl: PR, event: 'APPROVED', body: 'ok', commitId: 'abc123' })
    const [, init] = vi.mocked(callForgejo).mock.calls[0] as [string, any]
    expect(init.json).toMatchObject({ commit_id: 'abc123' })
  })
  it('Forgejo-fout → { error }', async () => {
    vi.mocked(callForgejo).mockRejectedValue(new Error('boom'))
    const out = await postPullRequestReview({ prUrl: PR, event: 'COMMENT', body: 'x' })
    expect(out).toHaveProperty('error')
  })
})
