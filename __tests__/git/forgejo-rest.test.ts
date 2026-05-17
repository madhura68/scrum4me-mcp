import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import {
  ForgejoError,
  callForgejo,
  checkSwaggerSupportsAutoMerge,
  classifyForgejoError,
  clearDiscoveryCache,
  discoverForgejo,
  encodePathSegment,
  forgejoFetch,
  getApiBaseUrl,
  getForgejoHost,
  getForgejoHosts,
  getForgejoToken,
  parseForgejoPrUrl,
  parseForgejoRemoteUrl,
  redactToken,
  requireToken,
} from '../../src/git/forgejo-rest.js'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  // Reset env voor elk testgeval om env-leakage te voorkomen.
  process.env.FORGEJO_HOST = 'git.jp-visser.nl'
  delete process.env.FORGEJO_HOSTS
  delete process.env.FORGEJO_TOKEN
  clearDiscoveryCache()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// =========================================================================
// Config
// =========================================================================

describe('config', () => {
  it('getForgejoHost defaults to git.jp-visser.nl', () => {
    delete process.env.FORGEJO_HOST
    expect(getForgejoHost()).toBe('git.jp-visser.nl')
  })

  it('FORGEJO_HOST override werkt', () => {
    process.env.FORGEJO_HOST = 'forge.example.com'
    expect(getForgejoHost()).toBe('forge.example.com')
  })

  it('getForgejoHosts ondersteunt comma-sep whitelist', () => {
    process.env.FORGEJO_HOSTS = 'a.example.com, b.example.com,c.example.com'
    expect(getForgejoHosts()).toEqual(['a.example.com', 'b.example.com', 'c.example.com'])
  })

  it('getForgejoHosts valt terug op FORGEJO_HOST wanneer FORGEJO_HOSTS leeg', () => {
    process.env.FORGEJO_HOST = 'forge.example.com'
    expect(getForgejoHosts()).toEqual(['forge.example.com'])
  })

  it('getApiBaseUrl gebruikt /api/v1 prefix', () => {
    expect(getApiBaseUrl()).toBe('https://git.jp-visser.nl/api/v1')
    expect(getApiBaseUrl('other.example.com')).toBe('https://other.example.com/api/v1')
  })
})

// =========================================================================
// URL parsers — remote
// =========================================================================

describe('parseForgejoRemoteUrl', () => {
  it('parses HTTPS URL met .git suffix', () => {
    expect(parseForgejoRemoteUrl('https://git.jp-visser.nl/scrum/mcp.git')).toEqual({
      host: 'git.jp-visser.nl',
      owner: 'scrum',
      repo: 'mcp',
    })
  })

  it('parses HTTPS URL zonder .git suffix', () => {
    expect(parseForgejoRemoteUrl('https://git.jp-visser.nl/scrum/mcp')).toEqual({
      host: 'git.jp-visser.nl',
      owner: 'scrum',
      repo: 'mcp',
    })
  })

  it('parses SCP-stijl SSH URL', () => {
    expect(parseForgejoRemoteUrl('git@git.jp-visser.nl:scrum/mcp.git')).toEqual({
      host: 'git.jp-visser.nl',
      owner: 'scrum',
      repo: 'mcp',
    })
  })

  it('parses ssh:// URL', () => {
    expect(parseForgejoRemoteUrl('ssh://git@git.jp-visser.nl/scrum/mcp.git')).toEqual({
      host: 'git.jp-visser.nl',
      owner: 'scrum',
      repo: 'mcp',
    })
  })

  it('LEGACY_GITHUB_URL voor github.com HTTPS', () => {
    expect(() => parseForgejoRemoteUrl('https://github.com/org/repo.git')).toThrow(
      expect.objectContaining({ code: 'LEGACY_GITHUB_URL' }),
    )
  })

  it('LEGACY_GITHUB_URL voor github.com SSH', () => {
    expect(() => parseForgejoRemoteUrl('git@github.com:org/repo.git')).toThrow(
      expect.objectContaining({ code: 'LEGACY_GITHUB_URL' }),
    )
  })

  it('PARSE_ERROR voor host niet in whitelist', () => {
    expect(() => parseForgejoRemoteUrl('https://other.example.com/scrum/mcp.git')).toThrow(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    )
  })

  it('PARSE_ERROR voor URL zonder owner/repo', () => {
    expect(() => parseForgejoRemoteUrl('https://git.jp-visser.nl/onlyone.git')).toThrow(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    )
  })
})

// =========================================================================
// URL parsers — PR
// =========================================================================

describe('parseForgejoPrUrl', () => {
  it('parses Forgejo /pulls/N URL', () => {
    expect(parseForgejoPrUrl('https://git.jp-visser.nl/scrum/mcp/pulls/42')).toEqual({
      host: 'git.jp-visser.nl',
      owner: 'scrum',
      repo: 'mcp',
      index: 42,
    })
  })

  it('parses trailing slash variant', () => {
    expect(parseForgejoPrUrl('https://git.jp-visser.nl/scrum/mcp/pulls/42/')).toMatchObject({
      index: 42,
    })
  })

  it('LEGACY_GITHUB_URL voor github.com /pull/N', () => {
    expect(() => parseForgejoPrUrl('https://github.com/org/repo/pull/42')).toThrow(
      expect.objectContaining({ code: 'LEGACY_GITHUB_URL' }),
    )
  })

  it('PARSE_ERROR voor /pull/N (GitHub stijl op Forgejo-host)', () => {
    expect(() => parseForgejoPrUrl('https://git.jp-visser.nl/scrum/mcp/pull/42')).toThrow(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    )
  })

  it('PARSE_ERROR voor host niet in whitelist', () => {
    expect(() => parseForgejoPrUrl('https://other.example.com/scrum/mcp/pulls/1')).toThrow(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    )
  })
})

// =========================================================================
// Encoding
// =========================================================================

describe('encodePathSegment', () => {
  it('encodet slashes voor URL-pad', () => {
    expect(encodePathSegment('feat/foo/bar')).toBe('feat%2Ffoo%2Fbar')
  })

  it('encodet spaties en speciale tekens', () => {
    expect(encodePathSegment('owner name')).toBe('owner%20name')
  })

  it('laat veilige tekens ongemoeid', () => {
    expect(encodePathSegment('simple-name')).toBe('simple-name')
  })
})

// =========================================================================
// Token management
// =========================================================================

describe('token management', () => {
  it('getForgejoToken retourneert undefined wanneer env leeg', () => {
    delete process.env.FORGEJO_TOKEN
    expect(getForgejoToken()).toBeUndefined()
  })

  it('getForgejoToken retourneert getrimde waarde', () => {
    process.env.FORGEJO_TOKEN = '  secret-token  '
    expect(getForgejoToken()).toBe('secret-token')
  })

  it('requireToken throws FORGEJO_AUTH_REQUIRED wanneer env leeg', () => {
    delete process.env.FORGEJO_TOKEN
    expect(() => requireToken()).toThrow(
      expect.objectContaining({ code: 'FORGEJO_AUTH_REQUIRED' }),
    )
  })

  it('requireToken retourneert token wanneer gezet', () => {
    process.env.FORGEJO_TOKEN = 'abc'
    expect(requireToken()).toBe('abc')
  })

  it('redactToken vervangt token-waarde in text', () => {
    process.env.FORGEJO_TOKEN = 'secret-abc-123'
    expect(redactToken('Failed with token=secret-abc-123 returned 401')).toBe(
      'Failed with token=<REDACTED> returned 401',
    )
  })

  it('redactToken is no-op zonder token', () => {
    delete process.env.FORGEJO_TOKEN
    expect(redactToken('Failed with token=xyz returned 401')).toBe(
      'Failed with token=xyz returned 401',
    )
  })
})

// =========================================================================
// Fetch wrapper
// =========================================================================

describe('forgejoFetch', () => {
  it('voegt Authorization: token <…> toe wanneer token gezet', async () => {
    process.env.FORGEJO_TOKEN = 'secret-abc'
    let capturedInit: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedInit = init
        return new Response('{}', { status: 200 })
      }),
    )

    await forgejoFetch('/repos/owner/repo')
    const headers = capturedInit?.headers as Headers
    expect(headers.get('Authorization')).toBe('token secret-abc')
    expect(headers.get('Accept')).toBe('application/json')
  })

  it('weglaat Authorization wanneer geen token (read-only)', async () => {
    delete process.env.FORGEJO_TOKEN
    let capturedInit: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedInit = init
        return new Response('{}', { status: 200 })
      }),
    )

    await forgejoFetch('/repos/owner/repo')
    const headers = capturedInit?.headers as Headers
    expect(headers.get('Authorization')).toBeNull()
  })

  it('write=true throws FORGEJO_AUTH_REQUIRED zonder token', async () => {
    delete process.env.FORGEJO_TOKEN
    await expect(forgejoFetch('/repos/owner/repo', { write: true, method: 'POST' })).rejects.toThrow(
      expect.objectContaining({ code: 'FORGEJO_AUTH_REQUIRED' }),
    )
  })

  it('serializes json body met Content-Type', async () => {
    process.env.FORGEJO_TOKEN = 'tok'
    let capturedInit: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedInit = init
        return new Response('{}', { status: 200 })
      }),
    )

    await forgejoFetch('/x', { write: true, method: 'POST', json: { head: 'feat/foo/bar', base: 'main' } })

    const headers = capturedInit?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(capturedInit?.body).toBe('{"head":"feat/foo/bar","base":"main"}')
  })

  it('prefix /api/v1 wordt toegevoegd voor relatieve paden', async () => {
    let capturedUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url
        return new Response('{}', { status: 200 })
      }),
    )

    await forgejoFetch('/repos/owner/repo')
    expect(capturedUrl).toBe('https://git.jp-visser.nl/api/v1/repos/owner/repo')
  })

  it('absolute URLs blijven ongemoeid (voor swagger.v1.json fetch)', async () => {
    let capturedUrl = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url
        return new Response('{}', { status: 200 })
      }),
    )

    await forgejoFetch('https://git.jp-visser.nl/swagger.v1.json')
    expect(capturedUrl).toBe('https://git.jp-visser.nl/swagger.v1.json')
  })

  it('network failure → ForgejoError NETWORK_ERROR met token redacted', async () => {
    process.env.FORGEJO_TOKEN = 'secret-abc'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED secret-abc')
      }),
    )

    await expect(forgejoFetch('/x')).rejects.toThrow(
      expect.objectContaining({ code: 'NETWORK_ERROR' }),
    )

    try {
      await forgejoFetch('/x')
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-abc')
      expect((err as Error).message).toContain('<REDACTED>')
    }
  })
})

// =========================================================================
// callForgejo (high-level wrapper)
// =========================================================================

describe('callForgejo', () => {
  it('parsed JSON op 2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"id":42,"title":"hi"}', { status: 200 })),
    )

    const result = await callForgejo<{ id: number; title: string }>('/x')
    expect(result).toEqual({ id: 42, title: 'hi' })
  })

  it('returned undefined op lege 2xx body', async () => {
    // 204-status mag geen body hebben in fetch-spec; we testen daarom een 200 met
    // lege body — die representeert hetzelfde "geen content" geval voor onze caller.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
    const result = await callForgejo('/x')
    expect(result).toBeUndefined()
  })

  it('401 → ForgejoError FORGEJO_AUTH_REQUIRED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"token required"}', { status: 401 })),
    )

    await expect(callForgejo('/x')).rejects.toThrow(
      expect.objectContaining({ code: 'FORGEJO_AUTH_REQUIRED', status: 401 }),
    )
  })

  it('409 → ForgejoError FORGEJO_CONFLICT met autoMergeReason MERGE_CONFLICT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"head commit mismatch"}', { status: 409 })),
    )

    try {
      await callForgejo('/x')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ForgejoError)
      const fe = err as ForgejoError
      expect(fe.code).toBe('FORGEJO_CONFLICT')
      expect(fe.autoMergeReason).toBe('MERGE_CONFLICT')
    }
  })

  it('500 → API_ERROR met classifier autoMergeReason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('checks not passing', { status: 500 })),
    )

    try {
      await callForgejo('/x')
      throw new Error('expected throw')
    } catch (err) {
      const fe = err as ForgejoError
      expect(fe.code).toBe('API_ERROR')
      expect(fe.autoMergeReason).toBe('CHECKS_FAILED')
    }
  })

  it('PARSE_ERROR bij ongeldige JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not-json{', { status: 200 })),
    )

    await expect(callForgejo('/x')).rejects.toThrow(
      expect.objectContaining({ code: 'PARSE_ERROR' }),
    )
  })

  it('token wordt niet in error-bodies gelekt', async () => {
    process.env.FORGEJO_TOKEN = 'secret-abc'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('error met token secret-abc in body', { status: 500 })),
    )

    try {
      await callForgejo('/x')
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-abc')
    }
  })
})

// =========================================================================
// classifyForgejoError
// =========================================================================

describe('classifyForgejoError', () => {
  it('401 → GH_AUTH_ERROR', () => {
    expect(classifyForgejoError(401, '')).toBe('GH_AUTH_ERROR')
  })

  it('403 → GH_AUTH_ERROR', () => {
    expect(classifyForgejoError(403, 'forbidden')).toBe('GH_AUTH_ERROR')
  })

  it('409 → MERGE_CONFLICT', () => {
    expect(classifyForgejoError(409, '')).toBe('MERGE_CONFLICT')
  })

  it('body "head commit mismatch" → MERGE_CONFLICT', () => {
    expect(classifyForgejoError(422, 'head commit mismatch')).toBe('MERGE_CONFLICT')
  })

  it('body "dirty" → MERGE_CONFLICT', () => {
    expect(classifyForgejoError(422, 'pull request is dirty')).toBe('MERGE_CONFLICT')
  })

  it('body "checks not passing" → CHECKS_FAILED', () => {
    expect(classifyForgejoError(422, 'checks not passing')).toBe('CHECKS_FAILED')
  })

  it('body "auto-merge not allowed" → AUTO_MERGE_NOT_ALLOWED', () => {
    expect(classifyForgejoError(422, 'auto-merge is not allowed')).toBe('AUTO_MERGE_NOT_ALLOWED')
  })

  it('unknown → UNKNOWN', () => {
    expect(classifyForgejoError(500, 'random server error')).toBe('UNKNOWN')
  })
})

// =========================================================================
// Discovery
// =========================================================================

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'forgejo', 'v15.0.2.json')
const FIXTURE_V15 = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

describe('checkSwaggerSupportsAutoMerge', () => {
  it('TRUE voor v15.0.2 fixture (heeft merge_when_checks_succeed)', () => {
    expect(checkSwaggerSupportsAutoMerge(FIXTURE_V15)).toBe(true)
  })

  it('FALSE wanneer definitions ontbreken', () => {
    expect(checkSwaggerSupportsAutoMerge({})).toBe(false)
  })

  it('FALSE wanneer MergePullRequestOption ontbreekt', () => {
    expect(checkSwaggerSupportsAutoMerge({ definitions: {} })).toBe(false)
  })

  it('FALSE wanneer merge_when_checks_succeed niet in properties zit', () => {
    expect(
      checkSwaggerSupportsAutoMerge({
        definitions: { MergePullRequestOption: { properties: { Do: {} } } },
      }),
    ).toBe(false)
  })
})

describe('discoverForgejo', () => {
  it('cached binnen één host', async () => {
    let versionCalls = 0
    let swaggerCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/version')) {
          versionCalls++
          return new Response('{"version":"15.0.2+gitea-1.22.0"}', { status: 200 })
        }
        if (url.endsWith('/swagger.v1.json')) {
          swaggerCalls++
          return new Response(JSON.stringify(FIXTURE_V15), { status: 200 })
        }
        return new Response('', { status: 404 })
      }),
    )

    const a = await discoverForgejo('git.jp-visser.nl')
    const b = await discoverForgejo('git.jp-visser.nl')

    expect(a).toEqual({ version: '15.0.2+gitea-1.22.0', supportsAutoMerge: true })
    expect(b).toBe(a) // same Promise resolution
    expect(versionCalls).toBe(1)
    expect(swaggerCalls).toBe(1)
  })

  it('na netwerkfout retry (cache wordt geleegd)', async () => {
    let attempt = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/version')) {
          attempt++
          if (attempt === 1) throw new Error('transient')
          return new Response('{"version":"15.0.2"}', { status: 200 })
        }
        if (url.endsWith('/swagger.v1.json')) {
          return new Response(JSON.stringify(FIXTURE_V15), { status: 200 })
        }
        return new Response('', { status: 404 })
      }),
    )

    await expect(discoverForgejo('git.jp-visser.nl')).rejects.toThrow()
    const ok = await discoverForgejo('git.jp-visser.nl')
    expect(ok.version).toBe('15.0.2')
  })
})
