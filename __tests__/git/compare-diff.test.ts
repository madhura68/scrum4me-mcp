import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchCompareDiff } from '../../src/git/pr.js'

const DIFF = 'diff --git a/x.ts b/x.ts\nindex 000..111 100644\n--- a/x.ts\n+++ b/x.ts\n'
const REPO = 'https://git.example.test/janpeter/demo.git'

// git.example.test moet in de FORGEJO_HOSTS whitelist staan, anders gooit
// parseForgejoRemoteUrl een PARSE_ERROR. We zetten FORGEJO_HOST in beforeEach
// (zelfde patroon als pr.test.ts / pr-review-helpers.test.ts).
describe('fetchCompareDiff', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    process.env.FORGEJO_HOST = 'git.example.test'
    delete process.env.FORGEJO_HOSTS
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.FORGEJO_HOST
  })

  it('haalt een unified diff op via de web-.diff-route (niet /api/v1)', async () => {
    fetchMock.mockResolvedValue(new Response(DIFF, { status: 200 }))
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toBe(DIFF)
    const url = String(fetchMock.mock.calls[0]![0])
    expect(url).toBe('https://git.example.test/janpeter/demo/compare/aaa1111...bbb2222.diff')
    expect(url).not.toContain('/api/v1/')
  })

  it('weigert een lege range (base === head) zonder fetch-call', async () => {
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'aaa1111' })
    expect(out).toHaveProperty('error')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('non-2xx (bv. private repo: web-route kent geen token-auth) → {error}', async () => {
    fetchMock.mockResolvedValue(new Response('Not found.', { status: 404 }))
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toHaveProperty('error')
  })

  it('200 zonder unified-diff-body (sanity-check) → {error}', async () => {
    fetchMock.mockResolvedValue(new Response('<!DOCTYPE html>…', { status: 200 }))
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toHaveProperty('error')
  })

  it('onparseerbare repo-URL → {error} zonder fetch-call', async () => {
    const out = await fetchCompareDiff({ repoUrl: ':::', baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toHaveProperty('error')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
