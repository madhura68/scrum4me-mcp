import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  jobChangedPayload,
  notifyJobChanged,
  notifyJobChangedPrisma,
  JOB_NOTIFY_MAX_BYTES,
  type JobNotifyRow,
} from '../../src/lib/job-notify.js'

const BASE: JobNotifyRow = { id: 'job-1', user_id: 'user-1', product_id: 'prod-1', kind: 'TASK_IMPLEMENTATION', status: 'DONE' }
const size = (p: unknown) => Buffer.byteLength(JSON.stringify(p), 'utf8')

describe('jobChangedPayload — vorm', () => {
  it('laat null-velden weg en zet runtime/source-defaults', () => {
    const p = jobChangedPayload({
      ...BASE, runtime: null, source: null, branch: null, pushed_at: null, pr_url: null,
      verify_result: null, summary: null, error: null, task_id: null, idea_id: null,
    })
    expect(p).toEqual({
      type: 'claude_job_status_changed', job_id: 'job-1', user_id: 'user-1', product_id: 'prod-1',
      kind: 'TASK_IMPLEMENTATION', status: 'DONE', runtime: 'CLAUDE', source: 'SYSTEM',
    })
    expect(Object.keys(p)).not.toContain('task_id')
  })

  it('zet verify_result lowercase, pushed_at als ISO en task_id/idea_id alleen indien gezet', () => {
    const p = jobChangedPayload({
      ...BASE, runtime: 'HARNESS', source: 'COPILOT', branch: 'feat/x', pushed_at: new Date('2026-10-09T10:00:00Z'),
      pr_url: 'https://x/pr/1', verify_result: 'ALIGNED', summary: 's', error: 'e', task_id: 't-1',
    })
    expect(p).toMatchObject({
      runtime: 'HARNESS', source: 'COPILOT', branch: 'feat/x', pushed_at: '2026-10-09T10:00:00.000Z',
      pr_url: 'https://x/pr/1', verify_result: 'aligned', summary: 's', error: 'e', task_id: 't-1',
    })
    expect(p).not.toHaveProperty('idea_id')
  })

  it('geeft claims hetzelfde type claude_job_status_changed met status CLAIMED', () => {
    expect(jobChangedPayload({ ...BASE, status: 'CLAIMED' })).toMatchObject({
      type: 'claude_job_status_changed', status: 'CLAIMED',
    })
  })
})

describe('jobChangedPayload — bytebudget', () => {
  const cases: Array<[string, () => string]> = [
    ['control-tekens (6 bytes per teken in JSON)', () => '\u0001'.repeat(2000)],
    ['4-byte emoji', () => '😀'.repeat(3000)],
    // Een gesplitst surrogate-paar: een los hoog surrogaat aan het eind.
    ['gesplitst surrogate-paar', () => 'a'.repeat(7000) + '\uD83D'],
  ]

  it.each(cases)('houdt het envelope <= 7500 bytes met summary én error vol van %s', (_t, make) => {
    const row: JobNotifyRow = { ...BASE, summary: make(), error: make() }
    // Bewaker: de onbewerkte invoer is echt te groot (pg_notify faalt vanaf 8000).
    expect(size({ summary: row.summary, error: row.error })).toBeGreaterThan(8000)

    const p = jobChangedPayload(row)

    expect(size(p)).toBeLessThanOrEqual(JOB_NOTIFY_MAX_BYTES)
    expect(p).toMatchObject({ job_id: 'job-1', user_id: 'user-1', product_id: 'prod-1', kind: 'TASK_IMPLEMENTATION', status: 'DONE' })
    expect(() => JSON.parse(JSON.stringify(p))).not.toThrow()
    // Geen gesplitst surrogaat achtergelaten door het inkorten.
    for (const f of ['summary', 'error'] as const) {
      const v = p[f]
      if (typeof v === 'string') expect(Array.from(v).join('')).toBe(v)
    }
  })

  it('knipt eerst summary en error, en pas daarna (zo nodig) branch en dan pr_url', () => {
    const big = 'x'.repeat(9000)
    // branch alleen is al groot genoeg om het envelope te laten ontsnappen als summary/error weg zijn.
    const p = jobChangedPayload({ ...BASE, summary: big, error: big, branch: 'b'.repeat(4000), pr_url: 'u'.repeat(4000) })
    expect(size(p)).toBeLessThanOrEqual(JOB_NOTIFY_MAX_BYTES)
    expect(p).not.toHaveProperty('summary')
    expect(p).not.toHaveProperty('error')
    expect(p).not.toHaveProperty('branch')
    expect(p).toHaveProperty('pr_url') // pr_url pas als branch weglaten niet volstond

    const q = jobChangedPayload({ ...BASE, summary: big, branch: 'b'.repeat(4000), pr_url: 'u'.repeat(8000) })
    expect(size(q)).toBeLessThanOrEqual(JOB_NOTIFY_MAX_BYTES)
    expect(q).not.toHaveProperty('branch')
    expect(q).not.toHaveProperty('pr_url')
    expect(p).toMatchObject({ job_id: 'job-1', status: 'DONE', runtime: 'CLAUDE', source: 'SYSTEM' })
  })

  it('laat branch/pr_url staan als inkorten van summary en error volstaat', () => {
    const p = jobChangedPayload({ ...BASE, summary: 'x'.repeat(9000), branch: 'feat/x', pr_url: 'https://x/pr/1' })
    expect(size(p)).toBeLessThanOrEqual(JOB_NOTIFY_MAX_BYTES)
    expect(p).toMatchObject({ branch: 'feat/x', pr_url: 'https://x/pr/1' })
  })
})

describe('notifyJobChanged (PoolClient)', () => {
  it('leest de rij en stuurt pg_notify op dezelfde client; ontbrekende rij is een no-op', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ ...BASE, status: 'CLAIMED' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    await notifyJobChanged({ query } as never, 'job-1')
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1][0]).toContain('pg_notify')
    expect(query.mock.calls[1][1][0]).toBe('scrum4me_changes')
    expect(JSON.parse(query.mock.calls[1][1][1])).toMatchObject({ job_id: 'job-1', status: 'CLAIMED' })

    query.mockClear()
    await notifyJobChanged({ query } as never, 'weg')
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe('notifyJobChangedPrisma', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined) })
  afterEach(() => warn.mockRestore())

  const client = (overrides: Record<string, unknown> = {}) => ({
    claudeJob: { findUnique: vi.fn().mockResolvedValue({ ...BASE }) },
    $executeRaw: vi.fn().mockResolvedValue(1),
    ...overrides,
  })

  it('stuurt de payload via client.$executeRaw', async () => {
    const c = client()
    await notifyJobChangedPrisma(c as never, 'job-1')
    expect(c.$executeRaw).toHaveBeenCalledTimes(1)
    const [strings, channel, payload] = c.$executeRaw.mock.calls[0] as [string[], string, string]
    expect(strings.join('?')).toContain('pg_notify')
    expect(channel).toBe('scrum4me_changes')
    expect(JSON.parse(payload)).toMatchObject({ type: 'claude_job_status_changed', job_id: 'job-1' })
  })

  it('doet niets als de rij ontbreekt', async () => {
    const c = client({ claudeJob: { findUnique: vi.fn().mockResolvedValue(null) } })
    await notifyJobChangedPrisma(c as never, 'weg')
    expect(c.$executeRaw).not.toHaveBeenCalled()
  })

  it('bestEffort: een falende $executeRaw wordt gelogd en niet gerethrowd', async () => {
    const c = client({ $executeRaw: vi.fn().mockRejectedValue(new Error('boem')) })
    await expect(notifyJobChangedPrisma(c as never, 'job-1', { bestEffort: true })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('zonder bestEffort (binnen een tx) gooit de fout door', async () => {
    const c = client({ $executeRaw: vi.fn().mockRejectedValue(new Error('boem')) })
    await expect(notifyJobChangedPrisma(c as never, 'job-1')).rejects.toThrow('boem')
  })
})

describe('update_job_status gebruikt dezelfde builder', () => {
  it('bouwt de hoofd-notify via jobChangedPayload i.p.v. een inline object', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('../../src/tools/update-job-status.ts', import.meta.url), 'utf8')
    expect(src).toContain("from '../lib/job-notify.js'")
    expect(src).toContain('jobChangedPayload({ ...job, ...updated })')
  })
})
