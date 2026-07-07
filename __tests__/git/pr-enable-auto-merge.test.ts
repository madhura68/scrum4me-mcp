import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import { clearDiscoveryCache } from '../../src/git/forgejo-rest.js'
import { enableAutoMergeOnPr } from '../../src/git/pr.js'

const FIXTURE_V15 = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'forgejo', 'v15.0.2.json'), 'utf8'),
)

const PR_URL = 'https://git.jp-visser.nl/scrum/mcp/pulls/42'

// Hulp-mock: 1e call → /version, 2e → /swagger.v1.json, 3e+ → merge endpoint
function mockForgejoWithMerge(opts: {
  supportsAutoMerge?: boolean
  mergeResponse?: () => Response
  versionResponse?: () => Response
} = {}) {
  const { supportsAutoMerge = true, mergeResponse, versionResponse } = opts
  let swaggerToReturn: unknown = FIXTURE_V15
  if (!supportsAutoMerge) {
    swaggerToReturn = {
      definitions: {
        MergePullRequestOption: { properties: { Do: {} } },
      },
    }
  }
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/api/v1/version')) {
      return (
        versionResponse?.() ?? new Response('{"version":"15.0.2"}', { status: 200 })
      )
    }
    if (url.endsWith('/swagger.v1.json')) {
      return new Response(JSON.stringify(swaggerToReturn), { status: 200 })
    }
    if (url.endsWith('/merge') && init.method === 'POST') {
      return mergeResponse?.() ?? new Response('', { status: 200 })
    }
    return new Response('', { status: 404 })
  })
}

// Onderscheidt de schedule-POST (merge_when_checks_succeed in body) van de
// opportunistische directe-merge-POST (zonder dat veld). directResponses geeft
// één response per directe poging (voor retry-tests); de laatste wordt herhaald.
function mockScheduleThenDirect(opts: {
  supportsAutoMerge?: boolean
  scheduleResponse?: () => Response
  directResponses?: (() => Response)[]
} = {}) {
  const { supportsAutoMerge = true, scheduleResponse, directResponses } = opts
  let swaggerToReturn: unknown = FIXTURE_V15
  if (!supportsAutoMerge) {
    swaggerToReturn = { definitions: { MergePullRequestOption: { properties: { Do: {} } } } }
  }
  let directCall = 0
  const scheduleBodies: unknown[] = []
  const directBodies: unknown[] = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/api/v1/version')) return new Response('{"version":"15.0.2"}', { status: 200 })
    if (url.endsWith('/swagger.v1.json')) return new Response(JSON.stringify(swaggerToReturn), { status: 200 })
    if (url.endsWith('/merge') && init.method === 'POST') {
      const body = JSON.parse((init.body as string) ?? '{}')
      if (body.merge_when_checks_succeed) {
        scheduleBodies.push(body)
        return scheduleResponse?.() ?? new Response('', { status: 200 })
      }
      directBodies.push(body)
      const resp = directResponses?.[Math.min(directCall, (directResponses.length || 1) - 1)]
      directCall++
      return resp?.() ?? new Response('', { status: 200 })
    }
    return new Response('', { status: 404 })
  })
  return { fetchMock, scheduleBodies, directBodies, directCallCount: () => directCall }
}

beforeEach(() => {
  process.env.FORGEJO_HOST = 'git.jp-visser.nl'
  process.env.FORGEJO_TOKEN = 'test-token'
  delete process.env.FORGEJO_HOSTS
  clearDiscoveryCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('enableAutoMergeOnPr — Forgejo REST + typed errors', () => {
  it('returns ok:true op 2xx merge response', async () => {
    vi.stubGlobal('fetch', mockForgejoWithMerge())
    const result = await enableAutoMergeOnPr({ prUrl: PR_URL, expectedHeadSha: 'sha1' })
    expect(result.ok).toBe(true)
  })

  it('AUTO_MERGE_NOT_ALLOWED wanneer discovery merge_when_checks_succeed mist (geen merge-call)', async () => {
    let mergeCalled = false
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/api/v1/version')) return new Response('{"version":"14.0.0"}', { status: 200 })
      if (url.endsWith('/swagger.v1.json')) {
        return new Response(
          JSON.stringify({ definitions: { MergePullRequestOption: { properties: { Do: {} } } } }),
          { status: 200 },
        )
      }
      if (url.endsWith('/merge') && init.method === 'POST') {
        mergeCalled = true
        return new Response('', { status: 200 })
      }
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await enableAutoMergeOnPr({ prUrl: PR_URL, expectedHeadSha: 'sha1' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('AUTO_MERGE_NOT_ALLOWED')
      expect(result.stderr).toContain('14.0.0')
    }
    expect(mergeCalled).toBe(false) // crucial: géén merge-call zonder support
  })

  it('GH_AUTH_ERROR voor 401 op merge', async () => {
    vi.stubGlobal(
      'fetch',
      mockForgejoWithMerge({
        mergeResponse: () => new Response('{"message":"token required"}', { status: 401 }),
      }),
    )
    const result = await enableAutoMergeOnPr({ prUrl: PR_URL, expectedHeadSha: 'sha1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('GH_AUTH_ERROR')
  })

  it('MERGE_CONFLICT voor 409 head-mismatch', async () => {
    vi.stubGlobal(
      'fetch',
      mockForgejoWithMerge({
        mergeResponse: () => new Response('{"message":"head commit mismatch"}', { status: 409 }),
      }),
    )
    const result = await enableAutoMergeOnPr({ prUrl: PR_URL, expectedHeadSha: 'sha1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('MERGE_CONFLICT')
  })

  it('CHECKS_FAILED voor body met "checks not passing"', async () => {
    vi.stubGlobal(
      'fetch',
      mockForgejoWithMerge({
        mergeResponse: () => new Response('checks not passing', { status: 422 }),
      }),
    )
    const result = await enableAutoMergeOnPr({ prUrl: PR_URL, expectedHeadSha: 'sha1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('CHECKS_FAILED')
  })

  it('UNKNOWN voor onverwachte 5xx', async () => {
    vi.stubGlobal(
      'fetch',
      mockForgejoWithMerge({
        mergeResponse: () => new Response('weird gateway issue', { status: 502 }),
      }),
    )
    const result = await enableAutoMergeOnPr({ prUrl: PR_URL, expectedHeadSha: 'sha1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('UNKNOWN')
  })

  it('zonder expectedHeadSha: geen head_commit_id in body', async () => {
    let mergeBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url.endsWith('/api/v1/version')) return new Response('{"version":"15.0.2"}', { status: 200 })
        if (url.endsWith('/swagger.v1.json')) return new Response(JSON.stringify(FIXTURE_V15), { status: 200 })
        if (url.endsWith('/merge') && init.method === 'POST') {
          mergeBody = init.body as string
          return new Response('', { status: 200 })
        }
        return new Response('', { status: 404 })
      }),
    )

    await enableAutoMergeOnPr({ prUrl: PR_URL })

    const parsed = JSON.parse(mergeBody)
    expect(parsed.head_commit_id).toBeUndefined()
  })

  it('no-CI happy path: schedule ok + directe merge ok → mode: merged (1 poging)', async () => {
    const m = mockScheduleThenDirect()
    vi.stubGlobal('fetch', m.fetchMock)
    const result = await enableAutoMergeOnPr({ prUrl: PR_URL, expectedHeadSha: 'sha1' })
    expect(result).toEqual({ ok: true, mode: 'merged' })
    expect(m.directCallCount()).toBe(1)
    expect(m.scheduleBodies).toHaveLength(1)
  })

  it('CI-repo (checks pending): schedule ok + directe merge geweigerd → mode: scheduled (schedule blijft, 3 pogingen)', async () => {
    const m = mockScheduleThenDirect({
      directResponses: [() => new Response('checks not passing', { status: 409 })],
    })
    vi.stubGlobal('fetch', m.fetchMock)
    const result = await enableAutoMergeOnPr({ prUrl: PR_URL, expectedHeadSha: 'sha1', directMergeBackoffMs: 0 })
    expect(result).toEqual({ ok: true, mode: 'scheduled' })
    expect(m.scheduleBodies).toHaveLength(1)
    expect(m.directCallCount()).toBe(3)
  })

  it('schedule geweigerd (401) → surface {ok:false}, GÉÉN directe-merge-poging', async () => {
    const m = mockScheduleThenDirect({
      scheduleResponse: () => new Response('{"message":"token required"}', { status: 401 }),
    })
    vi.stubGlobal('fetch', m.fetchMock)
    const result = await enableAutoMergeOnPr({ prUrl: PR_URL, expectedHeadSha: 'sha1', directMergeBackoffMs: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('GH_AUTH_ERROR')
    expect(m.directCallCount()).toBe(0)
  })

  it('schedule geweigerd (auto-merge disabled op de repo, 422) → AUTO_MERGE_NOT_ALLOWED, GÉÉN directe poging', async () => {
    const m = mockScheduleThenDirect({
      scheduleResponse: () => new Response('auto-merge is not allowed on this repository', { status: 422 }),
    })
    vi.stubGlobal('fetch', m.fetchMock)
    const result = await enableAutoMergeOnPr({ prUrl: PR_URL, expectedHeadSha: 'sha1', directMergeBackoffMs: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('AUTO_MERGE_NOT_ALLOWED')
    expect(m.directCallCount()).toBe(0)
  })

  it('head-move: schedule ok + directe merge 409 head-mismatch → mode: scheduled', async () => {
    const m = mockScheduleThenDirect({
      directResponses: [() => new Response('{"message":"head commit mismatch"}', { status: 409 })],
    })
    vi.stubGlobal('fetch', m.fetchMock)
    const result = await enableAutoMergeOnPr({ prUrl: PR_URL, expectedHeadSha: 'sha1', directMergeBackoffMs: 0 })
    expect(result).toEqual({ ok: true, mode: 'scheduled' })
  })

  it('transient: directe merge faalt op poging 1, slaagt op poging 2 → mode: merged (2 pogingen)', async () => {
    const m = mockScheduleThenDirect({
      directResponses: [
        () => new Response('weird gateway issue', { status: 502 }),
        () => new Response('', { status: 200 }),
      ],
    })
    vi.stubGlobal('fetch', m.fetchMock)
    const result = await enableAutoMergeOnPr({ prUrl: PR_URL, expectedHeadSha: 'sha1', directMergeBackoffMs: 0 })
    expect(result).toEqual({ ok: true, mode: 'merged' })
    expect(m.directCallCount()).toBe(2)
  })

  it('head_commit_id in BÉÍDE bodies; direct-body heeft GÉÉN merge_when_checks_succeed', async () => {
    const m = mockScheduleThenDirect()
    vi.stubGlobal('fetch', m.fetchMock)
    await enableAutoMergeOnPr({ prUrl: PR_URL, expectedHeadSha: 'abc123' })
    expect(m.scheduleBodies[0]).toMatchObject({ Do: 'squash', merge_when_checks_succeed: true, head_commit_id: 'abc123' })
    expect(m.directBodies[0]).toMatchObject({ Do: 'squash', head_commit_id: 'abc123' })
    expect((m.directBodies[0] as Record<string, unknown>).merge_when_checks_succeed).toBeUndefined()
  })

  it('github.com URL → UNKNOWN reason met LEGACY_GITHUB_URL stderr', async () => {
    vi.stubGlobal('fetch', vi.fn())

    const result = await enableAutoMergeOnPr({
      prUrl: 'https://github.com/org/repo/pull/42',
      expectedHeadSha: 'sha1',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.stderr).toContain('Forgejo is leidend')
    }
  })
})
