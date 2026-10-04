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
import {
  fetchPrDiff,
  fetchRepoFileAtRef,
  getPullRequestState,
  listPullRequestCommitShas,
  postPullRequestReview,
} from '../../src/git/pr.js'

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
  it('lege diff-body (200) → lege string, geen error', async () => {
    vi.mocked(forgejoFetch).mockResolvedValue(new Response('', { status: 200 }))
    const out = await fetchPrDiff({ prUrl: PR })
    expect(out).toBe('')
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
  it('ongeldige PR-URL → { error } zonder POST', async () => {
    const out = await postPullRequestReview({ prUrl: 'https://github.com/x/y/pulls/1', event: 'COMMENT', body: 'x' })
    expect(out).toHaveProperty('error')
    expect(callForgejo).not.toHaveBeenCalled()
  })
})

const PULL = {
  number: 42,
  html_url: PR,
  state: 'open',
  merged: false,
  merge_commit_sha: null,
  title: 'T',
  base: { ref: 'main' },
  head: { ref: 'feat/x', sha: 'abc123' },
}

describe('getPullRequestState — body', () => {
  it('geeft de PR-beschrijving door', async () => {
    vi.mocked(callForgejo).mockResolvedValue({ ...PULL, body: 'Plan: docs/plans/a.md' })
    const out = await getPullRequestState({ prUrl: PR })
    expect(out).toMatchObject({ body: 'Plan: docs/plans/a.md', headSha: 'abc123' })
  })
  it('null-body wordt een lege string', async () => {
    vi.mocked(callForgejo).mockResolvedValue({ ...PULL, body: null })
    const out = await getPullRequestState({ prUrl: PR })
    expect(out).toMatchObject({ body: '' })
  })
})

describe('listPullRequestCommitShas', () => {
  it('GET /pulls/{index}/commits?limit=50 en geeft alleen de sha-velden', async () => {
    vi.mocked(callForgejo).mockResolvedValue([{ sha: 'a'.repeat(40), commit: {} }, { sha: 'b'.repeat(40) }])
    const out = await listPullRequestCommitShas({ prUrl: PR })
    expect(out).toStrictEqual(['a'.repeat(40), 'b'.repeat(40)])
    const path = vi.mocked(callForgejo).mock.calls[0][0] as string
    expect(path).toBe('/repos/janpeter/scrum4me-mcp/pulls/42/commits?limit=50')
  })
  it('Forgejo-fout → { error }, geen throw', async () => {
    vi.mocked(callForgejo).mockRejectedValue(new Error('boom'))
    expect(await listPullRequestCommitShas({ prUrl: PR })).toHaveProperty('error')
  })
  it('ongeldige PR-URL → { error } zonder call', async () => {
    expect(await listPullRequestCommitShas({ prUrl: 'https://github.com/x/y/pulls/1' })).toHaveProperty('error')
    expect(callForgejo).not.toHaveBeenCalled()
  })
})

describe('fetchRepoFileAtRef', () => {
  it('GET /raw/{pad} met gecodeerde segmenten en ?ref=<sha>', async () => {
    vi.mocked(forgejoFetch).mockResolvedValue(new Response('# Plan', { status: 200 }))
    const out = await fetchRepoFileAtRef({ prUrl: PR, path: 'docs/plans/M 44#x.md', ref: 'abc123' })
    expect(out).toBe('# Plan')
    const path = vi.mocked(forgejoFetch).mock.calls[0][0] as string
    expect(path).toBe('/repos/janpeter/scrum4me-mcp/raw/docs/plans/M%2044%23x.md?ref=abc123')
  })
  it('404 → { error }', async () => {
    vi.mocked(forgejoFetch).mockResolvedValue(new Response('nope', { status: 404 }))
    expect(await fetchRepoFileAtRef({ prUrl: PR, path: 'docs/plans/a.md', ref: 'abc' })).toHaveProperty('error')
  })
  it('netwerkfout → { error }, geen throw', async () => {
    vi.mocked(forgejoFetch).mockRejectedValue(new Error('boom'))
    expect(await fetchRepoFileAtRef({ prUrl: PR, path: 'docs/plans/a.md', ref: 'abc' })).toHaveProperty('error')
  })
})
