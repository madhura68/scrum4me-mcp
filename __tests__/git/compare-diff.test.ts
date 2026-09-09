import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/git/forgejo-rest.js', async (orig) => {
  const actual = await orig<typeof import('../../src/git/forgejo-rest.js')>()
  return { ...actual, forgejoFetch: vi.fn() }
})

import { fetchCompareDiff } from '../../src/git/pr.js'
import { forgejoFetch } from '../../src/git/forgejo-rest.js'

const REPO = 'https://git.example.test/janpeter/demo.git'
const d = (f: string) => `diff --git a/${f} b/${f}\nindex 000..111 100644\n--- a/${f}\n+++ b/${f}\n`

// De API levert commits NIEUWSTE-eerst; fetchCompareDiff draait dat om.
const compareJson = (...shas: string[]) =>
  new Response(JSON.stringify({ total_commits: shas.length, commits: shas.map((sha) => ({ sha })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const mock = vi.mocked(forgejoFetch)

describe('fetchCompareDiff', () => {
  beforeEach(() => {
    mock.mockReset()
    process.env.FORGEJO_HOST = 'git.example.test'
    delete process.env.FORGEJO_HOSTS
  })
  afterEach(() => {
    delete process.env.FORGEJO_HOST
  })

  it('gaat via de geauthenticeerde API, niet via de web-route', async () => {
    // De web-route kent geen token-auth en gaf op een private repo altijd 404
    // (ISS-5). Alles moet nu door forgejoFetch, dus over /api/v1 mét token.
    mock
      .mockResolvedValueOnce(compareJson('bbb2222'))
      .mockResolvedValueOnce(new Response(d('x.ts'), { status: 200 }))
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toBe(d('x.ts'))
    const paden = mock.mock.calls.map((c) => String(c[0]))
    expect(paden[0]).toBe('/repos/janpeter/demo/compare/aaa1111...bbb2222')
    expect(paden[1]).toBe('/repos/janpeter/demo/git/commits/bbb2222.diff')
    for (const p of paden) expect(p.startsWith('/repos/')).toBe(true)
  })

  it('zet de commit-diffs in chronologische volgorde (API geeft nieuwste eerst)', async () => {
    mock
      .mockResolvedValueOnce(compareJson('nieuw', 'oud'))
      .mockResolvedValueOnce(new Response(d('oud.ts'), { status: 200 }))
      .mockResolvedValueOnce(new Response(d('nieuw.ts'), { status: 200 }))
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toBe(d('oud.ts') + d('nieuw.ts'))
    // eerst de oudste commit opgehaald
    expect(String(mock.mock.calls[1]![0])).toContain('/git/commits/oud.diff')
  })

  it('slaat een merge-commit met lege diff over zonder te falen', async () => {
    mock
      .mockResolvedValueOnce(compareJson('merge', 'echt'))
      .mockResolvedValueOnce(new Response(d('echt.ts'), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toBe(d('echt.ts'))
  })

  it('weigert een lege range (base === head) zonder enige call', async () => {
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'aaa1111' })
    expect(out).toHaveProperty('error')
    expect(mock).not.toHaveBeenCalled()
  })

  it('onparseerbare repo-URL → {error} zonder enige call', async () => {
    const out = await fetchCompareDiff({ repoUrl: ':::', baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toHaveProperty('error')
    expect(mock).not.toHaveBeenCalled()
  })

  it('non-2xx op de compare → {error}', async () => {
    mock.mockResolvedValueOnce(new Response('nope', { status: 404 }))
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toHaveProperty('error')
  })

  it('non-2xx op een commit-diff → {error}, geen halve diff', async () => {
    mock
      .mockResolvedValueOnce(compareJson('a', 'b'))
      .mockResolvedValueOnce(new Response(d('b.ts'), { status: 200 }))
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toHaveProperty('error')
  })

  it('range zonder commits → {error}', async () => {
    mock.mockResolvedValueOnce(compareJson())
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toHaveProperty('error')
  })

  it('te veel commits → {error} in plaats van een ontplofte context', async () => {
    // Een drie-punts-range trekt merge-historie mee; gemeten gaf HEAD~4...HEAD
    // er 16. Boven de grens is dat een expliciete fout, geen stille afkapping.
    mock.mockResolvedValueOnce(compareJson(...Array.from({ length: 51 }, (_, i) => `c${i}`)))
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toHaveProperty('error')
    expect((out as { error: string }).error).toContain('51 commits')
  })

  it('200 met een body die geen unified diff is → {error}', async () => {
    mock
      .mockResolvedValueOnce(compareJson('a'))
      .mockResolvedValueOnce(new Response('<!DOCTYPE html>…', { status: 200 }))
    const out = await fetchCompareDiff({ repoUrl: REPO, baseSha: 'aaa1111', headSha: 'bbb2222' })
    expect(out).toHaveProperty('error')
  })
})
