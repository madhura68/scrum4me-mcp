import { it, expect, vi, beforeEach } from 'vitest'

// Issue-tracker spec §6, MCP-kant. Zelfde contractpunten als de web-executor:
// render uit de POST-lock-read, CAS op forgejo_sync_seq, nooit verwerpen, en
// zonder DIRECT_URL netjes overslaan zodat de web-sweep het overneemt.
vi.mock('../src/prisma.js', () => ({
  prisma: { issue: { findUnique: vi.fn() }, issueLog: { create: vi.fn() } },
}))
vi.mock('../src/db/session-lock.js', () => ({ withIssueSessionLock: vi.fn() }))
vi.mock('../src/git/forgejo-issues.js', () => ({
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  searchIssueByMarker: vi.fn(),
  createIssue: vi.fn(),
  editIssue: vi.fn(),
  setIssueLabels: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { withIssueSessionLock } from '../src/db/session-lock.js'
import {
  listLabels, createLabel, searchIssueByMarker, createIssue, editIssue, setIssueLabels,
} from '../src/git/forgejo-issues.js'
import { syncIssueToForgejo, parseForgejoRepoPath } from '../src/lib/issue-sync.js'
import { ForgejoError } from '../src/git/forgejo-rest.js'

const mockFindUnique = (prisma as unknown as { issue: { findUnique: ReturnType<typeof vi.fn> } }).issue.findUnique
const mockLogCreate = (prisma as unknown as { issueLog: { create: ReturnType<typeof vi.fn> } }).issueLog.create
const mockLock = withIssueSessionLock as ReturnType<typeof vi.fn>

const ISSUE_ID = 'iss-1'
const PRE_READ = { id: ISSUE_ID, product: { repo_url: 'https://git.jp-visser.nl/janpeter/infra.git' } }

function fullRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID, code: 'ISS-3', title: 'S1', description: 'Registratie',
    research_md: null, resolution_md: null, status: 'INVESTIGATING', resolution: null,
    severity: 'S2_CRITICAL', reported_by: 'max2:claude', occurrence_count: 1,
    last_seen_at: new Date('2026-08-16T12:00:00.000Z'),
    created_at: new Date('2026-08-15T09:00:00.000Z'),
    archived: false, forgejo_repo: null, forgejo_number: null, forgejo_sync_seq: 8,
    linked_pbi: null, linked_idea: null,
    product: { name: 'max2', kind: 'SYSTEM', repo_url: 'https://git.jp-visser.nl/janpeter/infra.git' },
    ...overrides,
  }
}

/** Lock-dubbel: draait de callback met een scripted pg-client. */
function lockOk(opts: { casRowCount?: number } = {}) {
  const queries: { sql: string; params?: unknown[] }[] = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params })
      if (sql.includes('forgejo_dirty = false')) return { rows: [], rowCount: opts.casRowCount ?? 1 }
      return { rows: [], rowCount: 1 }
    }),
  }
  mockLock.mockImplementation(async (_id: string, fn: (c: unknown) => Promise<unknown>) => ({
    ok: true, value: await fn(client),
  }))
  return queries
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.FORGEJO_TOKEN = 'test-token'
  process.env.DIRECT_URL = 'postgresql://u:p@localhost:5432/d'
  delete process.env.ISSUE_FORGEJO_SYNC
  mockFindUnique.mockResolvedValue(PRE_READ)
  ;(listLabels as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 1, name: 'severity/s2' }])
  ;(searchIssueByMarker as ReturnType<typeof vi.fn>).mockResolvedValue(null)
  ;(createIssue as ReturnType<typeof vi.fn>).mockResolvedValue({ number: 42 })
  ;(editIssue as ReturnType<typeof vi.fn>).mockResolvedValue({ number: 42 })
  ;(setIssueLabels as ReturnType<typeof vi.fn>).mockResolvedValue({})
})

it('pelt host en .git af in parseForgejoRepoPath', () => {
  expect(parseForgejoRepoPath('https://git.jp-visser.nl/janpeter/infra.git')).toEqual({ owner: 'janpeter', repo: 'infra' })
  expect(parseForgejoRepoPath('https://github.com/org/repo')).toBeNull()
})

it('noodrem ISSUE_FORGEJO_SYNC=off slaat alles over', async () => {
  process.env.ISSUE_FORGEJO_SYNC = 'off'
  await expect(syncIssueToForgejo(ISSUE_ID)).resolves.toMatchObject({ outcome: 'skipped' })
  expect(mockLock).not.toHaveBeenCalled()
})

it('product zonder repo_url ⇒ skipped, geen lock', async () => {
  mockFindUnique.mockResolvedValue({ id: ISSUE_ID, product: { repo_url: null } })
  await expect(syncIssueToForgejo(ISSUE_ID)).resolves.toMatchObject({ outcome: 'skipped' })
  expect(mockLock).not.toHaveBeenCalled()
})

it('zonder DIRECT_URL slaat de MCP inline-sync over — de web-sweep is het vangnet', async () => {
  mockLock.mockResolvedValue({ ok: false, reason: 'no-direct-url' })
  await expect(syncIssueToForgejo(ISSUE_ID)).resolves.toMatchObject({ outcome: 'skipped', reason: 'no-direct-url' })
  expect(createIssue).not.toHaveBeenCalled()
})

it('lock elders ⇒ skipped zonder Forgejo-verkeer', async () => {
  mockLock.mockResolvedValue({ ok: false, reason: 'locked' })
  await expect(syncIssueToForgejo(ISSUE_ID)).resolves.toMatchObject({ outcome: 'skipped', reason: 'locked' })
  expect(createIssue).not.toHaveBeenCalled()
})

it('happy path: marker-zoek leeg ⇒ create ⇒ labels ⇒ CAS met de seq-snapshot', async () => {
  mockFindUnique.mockResolvedValueOnce(PRE_READ).mockResolvedValue(fullRow())
  const queries = lockOk()

  await expect(syncIssueToForgejo(ISSUE_ID)).resolves.toMatchObject({ outcome: 'synced' })

  const created = (createIssue as ReturnType<typeof vi.fn>).mock.calls[0]
  expect(created[2].title).toBe('[max2 ISS-3] S1')
  expect(created[2].body).toContain(`<!-- s4m:issue:${ISSUE_ID} -->`)
  expect(setIssueLabels).toHaveBeenCalledWith('janpeter', 'infra', 42, ['severity/s2', 'host/max2'])

  const cas = queries.find((q) => q.sql.includes('forgejo_dirty = false'))
  expect(cas?.params).toContain(8)
})

it('ontbrekend label wordt idempotent aangemaakt', async () => {
  mockFindUnique.mockResolvedValueOnce(PRE_READ).mockResolvedValue(fullRow())
  ;(listLabels as ReturnType<typeof vi.fn>).mockResolvedValue([])
  lockOk()

  await syncIssueToForgejo(ISSUE_ID)
  const names = (createLabel as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2].name)
  expect(names).toEqual(['severity/s2', 'host/max2'])
})

it('CAS rowCount 0 ⇒ stale, zonder foutregistratie', async () => {
  mockFindUnique.mockResolvedValueOnce(PRE_READ).mockResolvedValue(fullRow())
  const queries = lockOk({ casRowCount: 0 })

  await expect(syncIssueToForgejo(ISSUE_ID)).resolves.toMatchObject({ outcome: 'stale' })
  expect(queries.some((q) => q.sql.includes('left($1, 500)'))).toBe(false)
})

it('Forgejo-fout bij create ⇒ failed met foutregistratie', async () => {
  mockFindUnique.mockResolvedValueOnce(PRE_READ).mockResolvedValue(fullRow())
  const queries = lockOk()
  ;(createIssue as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Forgejo 404'))

  await expect(syncIssueToForgejo(ISSUE_ID)).resolves.toMatchObject({ outcome: 'failed' })
  expect(queries.some((q) => q.sql.includes('left($1, 500)') && q.sql.includes('forgejo_attempted_at'))).toBe(true)
})

it('forgejo_error draagt géén upstream response-body — dat veld gaat over het NOTIFY-kanaal', async () => {
  // Security-review §10: ForgejoError neemt de response-body mee in zijn
  // message. forgejo_error wordt naar elke SSE-client met productoegang
  // gestuurd en in de UI getoond, dus daar hoort alleen status + code in.
  mockFindUnique.mockResolvedValueOnce(PRE_READ).mockResolvedValue(fullRow())
  const queries = lockOk()
  ;(createIssue as ReturnType<typeof vi.fn>).mockRejectedValue(
    new ForgejoError('Forgejo POST /repos/x/y/issues failed: 403 {"message":"geheime interne details"}', {
      code: 'API_ERROR', status: 403, body: '{"message":"geheime interne details"}',
    }),
  )

  await expect(syncIssueToForgejo(ISSUE_ID)).resolves.toMatchObject({ outcome: 'failed' })
  const write = queries.find((q) => q.sql.includes('left($1, 500)'))
  expect(write?.params?.[0]).toBe('Forgejo 403 (API_ERROR)')
  expect(String(write?.params?.[0])).not.toContain('geheime interne details')
})

it('repo-mismatch logt SYNC en maakt een nieuw mirror-issue', async () => {
  mockFindUnique
    .mockResolvedValueOnce(PRE_READ)
    .mockResolvedValue(fullRow({ forgejo_repo: 'janpeter/oud', forgejo_number: 7 }))
  lockOk()

  await expect(syncIssueToForgejo(ISSUE_ID)).resolves.toMatchObject({ outcome: 'synced' })
  expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ type: 'SYNC' }),
  }))
  expect(createIssue).toHaveBeenCalled()
  expect(editIssue).not.toHaveBeenCalled()
})

it('pre-lock/post-lock-race: de gepushte staat komt uit de POST-lock-read', async () => {
  mockFindUnique
    .mockResolvedValueOnce({ ...PRE_READ, title: 'S0' })
    .mockResolvedValue(fullRow({ title: 'S1', forgejo_sync_seq: 8 }))
  const queries = lockOk()

  await syncIssueToForgejo(ISSUE_ID)

  const created = (createIssue as ReturnType<typeof vi.fn>).mock.calls[0]
  expect(created[2].title).toContain('S1')
  const cas = queries.find((q) => q.sql.includes('forgejo_dirty = false'))
  expect(cas?.params).toContain(8)
})

it('post-lock-guard: repo_url verdwenen ná de voorcontrole ⇒ skipped zonder verkeer', async () => {
  mockFindUnique
    .mockResolvedValueOnce(PRE_READ)
    .mockResolvedValue(fullRow({ product: { name: 'max2', kind: 'SYSTEM', repo_url: null } }))
  const queries = lockOk()

  await expect(syncIssueToForgejo(ISSUE_ID)).resolves.toMatchObject({ outcome: 'skipped' })
  expect(createIssue).not.toHaveBeenCalled()
  expect(queries.some((q) => q.sql.includes('left($1, 500)'))).toBe(false)
})
