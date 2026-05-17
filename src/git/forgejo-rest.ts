// Forgejo REST-laag voor PR-automatisering. Vervangt de GitHub-CLI subprocess
// calls in pr.ts door directe fetch() naar https://<FORGEJO_HOST>/api/v1.
//
// Bewust géén native draft-codepad: Forgejo 15.0.2 op git.jp-visser.nl heeft
// geen `draft`-veld in POST /pulls en geen ready-transition endpoint. Sprint-
// mode draft = title-prefix `WIP: `. Wanneer een toekomstige Forgejo-versie
// wel native draft levert kan dat hier additief worden ingebouwd; discovery
// houdt momenteel alleen de auto-merge-feature in de gaten.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// =========================================================================
// Config
// =========================================================================

const DEFAULT_HOST = 'git.jp-visser.nl'

export function getForgejoHost(): string {
  return process.env.FORGEJO_HOST?.trim() || DEFAULT_HOST
}

export function getForgejoHosts(): string[] {
  const raw = process.env.FORGEJO_HOSTS?.trim()
  if (raw) {
    return raw.split(',').map((h) => h.trim()).filter(Boolean)
  }
  return [getForgejoHost()]
}

export function getApiBaseUrl(host?: string): string {
  return `https://${host ?? getForgejoHost()}/api/v1`
}

// =========================================================================
// Typed errors
// =========================================================================

export type AutoMergeFailReason =
  | 'CHECKS_FAILED'
  | 'MERGE_CONFLICT'
  | 'GH_AUTH_ERROR' // historische naam — bewust behouden voor caller-compat
  | 'AUTO_MERGE_NOT_ALLOWED'
  | 'UNKNOWN'

export type ForgejoErrorCode =
  | 'LEGACY_GITHUB_URL'
  | 'FORGEJO_AUTH_REQUIRED'
  | 'FORGEJO_SCHEMA_UNSUPPORTED'
  | 'FORGEJO_CONFLICT'
  | 'PARSE_ERROR'
  | 'API_ERROR'
  | 'NETWORK_ERROR'

export class ForgejoError extends Error {
  readonly code: ForgejoErrorCode
  readonly status?: number
  readonly body?: string
  readonly autoMergeReason?: AutoMergeFailReason

  constructor(
    message: string,
    opts: {
      code: ForgejoErrorCode
      status?: number
      body?: string
      autoMergeReason?: AutoMergeFailReason
    },
  ) {
    super(message)
    this.name = 'ForgejoError'
    this.code = opts.code
    this.status = opts.status
    this.body = opts.body
    this.autoMergeReason = opts.autoMergeReason
  }
}

// =========================================================================
// URL parsers
// =========================================================================

export type ForgejoRepoRef = {
  host: string
  owner: string
  repo: string
}

export type ForgejoPrRef = ForgejoRepoRef & {
  index: number
}

/**
 * Parse een git remote URL naar `{host, owner, repo}`. Ondersteunt:
 *  - https://host/owner/repo(.git)
 *  - git@host:owner/repo(.git)
 *  - ssh://git@host/owner/repo(.git)
 *
 * Throws ForgejoError('LEGACY_GITHUB_URL') voor github.com URLs zodat callers
 * een typed fallback kunnen geven i.p.v. half-half werken op de mirror.
 */
export function parseForgejoRemoteUrl(url: string): ForgejoRepoRef {
  const trimmed = url.trim()

  if (/^https?:\/\/github\.com\//i.test(trimmed) || /^git@github\.com:/i.test(trimmed)) {
    throw new ForgejoError(
      `github.com remote (${trimmed}) — Forgejo is leidend; configureer origin op een Forgejo-host`,
      { code: 'LEGACY_GITHUB_URL' },
    )
  }

  let host: string
  let path: string

  const httpsMatch = trimmed.match(/^https?:\/\/([^/]+)\/(.+)$/)
  const sshScpMatch = trimmed.match(/^[^@]+@([^:]+):(.+)$/)
  const sshUrlMatch = trimmed.match(/^ssh:\/\/[^@]+@([^/]+)\/(.+)$/)

  if (httpsMatch) {
    host = httpsMatch[1]!
    path = httpsMatch[2]!
  } else if (sshUrlMatch) {
    host = sshUrlMatch[1]!
    path = sshUrlMatch[2]!
  } else if (sshScpMatch) {
    host = sshScpMatch[1]!
    path = sshScpMatch[2]!
  } else {
    throw new ForgejoError(`unparseable remote URL: ${trimmed}`, { code: 'PARSE_ERROR' })
  }

  assertHostAllowed(host, trimmed)

  // Strip .git suffix + optionele trailing slash
  const cleanPath = path.replace(/\.git\/?$/, '').replace(/\/+$/, '')
  const segments = cleanPath.split('/').filter(Boolean)
  if (segments.length < 2) {
    throw new ForgejoError(`remote URL mist owner/repo: ${trimmed}`, { code: 'PARSE_ERROR' })
  }

  // Owner + repo zijn de laatste twee segmenten (Forgejo ondersteunt geen sub-orgs in pad).
  const repo = segments[segments.length - 1]!
  const owner = segments[segments.length - 2]!

  return { host, owner, repo }
}

/**
 * Parse een Forgejo PR URL `https://host/owner/repo/pulls/N` naar
 * `{host, owner, repo, index}`. github.com URLs gooien LEGACY_GITHUB_URL.
 */
export function parseForgejoPrUrl(url: string): ForgejoPrRef {
  const trimmed = url.trim()

  if (/^https?:\/\/github\.com\//i.test(trimmed)) {
    throw new ForgejoError(
      `github.com PR URL (${trimmed}) — Forgejo is leidend; gebruik de mirror-PR op de Forgejo-host`,
      { code: 'LEGACY_GITHUB_URL' },
    )
  }

  const match = trimmed.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/?$/)
  if (!match) {
    throw new ForgejoError(
      `unparseable Forgejo PR URL: ${trimmed} (verwacht https://host/owner/repo/pulls/N)`,
      { code: 'PARSE_ERROR' },
    )
  }

  const host = match[1]!
  assertHostAllowed(host, trimmed)

  return {
    host,
    owner: match[2]!,
    repo: match[3]!,
    index: parseInt(match[4]!, 10),
  }
}

function assertHostAllowed(host: string, original: string): void {
  const allowed = getForgejoHosts()
  if (!allowed.includes(host)) {
    throw new ForgejoError(
      `host ${host} niet in FORGEJO_HOSTS whitelist (${allowed.join(', ')}): ${original}`,
      { code: 'PARSE_ERROR' },
    )
  }
}

// =========================================================================
// Encoding helpers
//
// REGEL: URL-segmenten encoderen; JSON-body refs (head/base) RAW laten.
// Forgejo doet zelf ref-matching op body-refs; encoding leidt tot mismatch
// (bijvoorbeeld voor branchnamen met slashes als `feat/foo/bar`).
// =========================================================================

export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment)
}

// =========================================================================
// Token management
//
// Lazy: read-only acties proberen eerst zonder token (publieke repos); write
// vereist een token, anders typed FORGEJO_AUTH_REQUIRED. Tokenwaarde mag
// NOOIT in logs of error messages voorkomen — gebruik redactToken().
// =========================================================================

export function getForgejoToken(): string | undefined {
  return process.env.FORGEJO_TOKEN?.trim() || undefined
}

export function requireToken(): string {
  const t = getForgejoToken()
  if (!t) {
    throw new ForgejoError(
      'FORGEJO_TOKEN niet gezet — vereist voor write-operatie',
      { code: 'FORGEJO_AUTH_REQUIRED' },
    )
  }
  return t
}

export function redactToken(text: string): string {
  const t = getForgejoToken()
  if (!t) return text
  return text.split(t).join('<REDACTED>')
}

// =========================================================================
// Fetch wrapper
// =========================================================================

export type ForgejoRequestInit = Omit<RequestInit, 'body'> & {
  /** Indien write=true: requireToken(). Default false (read-only OK zonder token). */
  write?: boolean
  /** JSON body — wordt automatisch gestringified met Content-Type header. */
  json?: unknown
  /** Custom host override (default: getForgejoHost()). */
  host?: string
}

/**
 * Lage-niveau fetch tegen `https://<host>/api/v1<path>`. Voegt Authorization
 * header toe wanneer token beschikbaar (of throws FORGEJO_AUTH_REQUIRED bij
 * write zonder token). Retourneert de raw Response zodat callers status en
 * body zelf kunnen interpreteren.
 */
export async function forgejoFetch(
  pathOrUrl: string,
  init: ForgejoRequestInit = {},
): Promise<Response> {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${getApiBaseUrl(init.host)}${pathOrUrl}`

  const headers = new Headers(init.headers)
  const token = init.write ? requireToken() : getForgejoToken()
  if (token) {
    headers.set('Authorization', `token ${token}`)
  }
  headers.set('Accept', 'application/json')

  let body: string | undefined
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(init.json)
  }

  try {
    return await fetch(url, { ...init, headers, body })
  } catch (err) {
    const msg = (err as Error).message || String(err)
    throw new ForgejoError(`Forgejo network error: ${redactToken(msg).slice(0, 300)}`, {
      code: 'NETWORK_ERROR',
    })
  }
}

/**
 * High-level helper: doet de fetch + parsed body, throws ForgejoError met
 * code 'API_ERROR' / 'FORGEJO_AUTH_REQUIRED' / 'FORGEJO_CONFLICT' bij non-2xx.
 */
export async function callForgejo<T = unknown>(
  pathOrUrl: string,
  init: ForgejoRequestInit = {},
): Promise<T> {
  const response = await forgejoFetch(pathOrUrl, init)
  const bodyText = await response.text()

  if (!response.ok) {
    const safeBody = redactToken(bodyText).slice(0, 500)
    if (response.status === 401) {
      throw new ForgejoError(
        `Forgejo 401: ${safeBody}`,
        {
          code: 'FORGEJO_AUTH_REQUIRED',
          status: 401,
          body: bodyText,
          autoMergeReason: 'GH_AUTH_ERROR',
        },
      )
    }
    if (response.status === 409) {
      throw new ForgejoError(
        `Forgejo 409 conflict: ${safeBody}`,
        {
          code: 'FORGEJO_CONFLICT',
          status: 409,
          body: bodyText,
          autoMergeReason: 'MERGE_CONFLICT',
        },
      )
    }
    throw new ForgejoError(
      `Forgejo ${init.method ?? 'GET'} ${pathOrUrl} failed: ${response.status} ${safeBody}`,
      {
        code: 'API_ERROR',
        status: response.status,
        body: bodyText,
        autoMergeReason: classifyForgejoError(response.status, bodyText),
      },
    )
  }

  if (!bodyText) return undefined as T
  try {
    return JSON.parse(bodyText) as T
  } catch {
    throw new ForgejoError(`unparseable JSON from Forgejo: ${bodyText.slice(0, 200)}`, {
      code: 'PARSE_ERROR',
      body: bodyText,
    })
  }
}

// =========================================================================
// Error classifier
//
// Best-effort mapping van Forgejo response naar AutoMergeFailReason. Wordt
// gebruikt door pr.ts wanneer enableAutoMergeOnPr faalt zodat de bestaande
// flow/effects.ts caller dezelfde reason-strings ziet als vroeger.
// =========================================================================

export function classifyForgejoError(status: number, body: string): AutoMergeFailReason {
  if (status === 401 || status === 403) return 'GH_AUTH_ERROR'
  if (status === 409) return 'MERGE_CONFLICT'

  const lower = body.toLowerCase()
  if (/conflict|not in mergeable state|dirty|head commit mismatch|head_commit_id/i.test(body)) {
    return 'MERGE_CONFLICT'
  }
  if (/checks? (?:not )?(?:failed|passing)|status check|required check/i.test(body)) {
    return 'CHECKS_FAILED'
  }
  if (/authentication|token|permission denied|forbidden|unauthorized/i.test(body)) {
    return 'GH_AUTH_ERROR'
  }
  if (/auto-?merge|not allowed|disabled|merge_when_checks_succeed/i.test(lower)) {
    return 'AUTO_MERGE_NOT_ALLOWED'
  }
  return 'UNKNOWN'
}

// =========================================================================
// Remote URL detection (worktree → repo ref)
// =========================================================================

export async function getRepoRefFromWorktree(worktreePath: string): Promise<ForgejoRepoRef> {
  try {
    const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], {
      cwd: worktreePath,
    })
    return parseForgejoRemoteUrl(stdout.trim())
  } catch (err) {
    if (err instanceof ForgejoError) throw err
    const msg = (err as Error).message || String(err)
    throw new ForgejoError(
      `git remote get-url origin failed in ${worktreePath}: ${msg.slice(0, 200)}`,
      { code: 'PARSE_ERROR' },
    )
  }
}

// =========================================================================
// Discovery
//
// Minimaal: version-check + detectie van merge_when_checks_succeed-veld.
// Géén draft-detectie (Forgejo 15.0.2 heeft het niet; future-proofing is
// out of scope tot een Forgejo-upgrade landt). Cached per host om herhaalde
// fetches te voorkomen.
// =========================================================================

export type ForgejoDiscovery = {
  version: string
  supportsAutoMerge: boolean
}

const discoveryCache = new Map<string, Promise<ForgejoDiscovery>>()

export async function discoverForgejo(host?: string): Promise<ForgejoDiscovery> {
  const h = host ?? getForgejoHost()
  const cached = discoveryCache.get(h)
  if (cached) return cached

  const promise = (async (): Promise<ForgejoDiscovery> => {
    const version = await fetchForgejoVersion(h)
    const swagger = await fetchSwagger(h)
    return {
      version,
      supportsAutoMerge: checkSwaggerSupportsAutoMerge(swagger),
    }
  })()

  discoveryCache.set(h, promise)
  try {
    return await promise
  } catch (err) {
    discoveryCache.delete(h) // laat retry toe na transient netwerkfout
    throw err
  }
}

/** Test-only: leeg de discovery-cache. */
export function clearDiscoveryCache(): void {
  discoveryCache.clear()
}

export async function fetchForgejoVersion(host?: string): Promise<string> {
  const data = await callForgejo<{ version?: string }>('/version', { host })
  if (!data?.version) {
    throw new ForgejoError(`Forgejo /version response zonder version-veld`, {
      code: 'FORGEJO_SCHEMA_UNSUPPORTED',
    })
  }
  return data.version
}

export async function fetchSwagger(host?: string): Promise<unknown> {
  const h = host ?? getForgejoHost()
  const response = await forgejoFetch(`https://${h}/swagger.v1.json`)
  if (!response.ok) {
    throw new ForgejoError(`swagger.v1.json fetch failed: ${response.status}`, {
      code: 'FORGEJO_SCHEMA_UNSUPPORTED',
      status: response.status,
    })
  }
  return await response.json()
}

/**
 * Detecteer of MergePullRequestOption het veld `merge_when_checks_succeed`
 * heeft. Wanneer niet: auto-merge moet `AUTO_MERGE_NOT_ALLOWED` returnen
 * i.p.v. direct te mergen.
 */
export function checkSwaggerSupportsAutoMerge(swagger: unknown): boolean {
  const definitions = (swagger as { definitions?: Record<string, unknown> })?.definitions
  if (!definitions) return false
  const mergeOption = definitions['MergePullRequestOption'] as
    | { properties?: Record<string, unknown> }
    | undefined
  if (!mergeOption?.properties) return false
  return 'merge_when_checks_succeed' in mergeOption.properties
}
