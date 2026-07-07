import { describe, it, expect } from 'vitest'
import { buildDocsAuditPayload } from '../src/lib/docs-audit-payload.js'

const NOW = new Date('2026-07-04T05:30:00.000Z')
const product = { id: 'p1', name: 'Scrum4Me', repo_url: 'https://git/x', code: 'SCRUM4ME' }

describe('buildDocsAuditPayload', () => {
  it('eerste run: since = 7 dagen terug, is_scrum4me true bij code SCRUM4ME', () => {
    const p = buildDocsAuditPayload({ product, lastJob: null, docIndex: null, now: NOW })
    expect(p.is_scrum4me).toBe(true)
    expect(new Date(p.since).getTime()).toBe(NOW.getTime() - 7 * 24 * 60 * 60 * 1000)
  })

  it('vervolgrun: since = finished_at minus 1u overlap; is_scrum4me false bij ander product', () => {
    const finished = new Date('2026-07-03T05:30:00.000Z')
    const p = buildDocsAuditPayload({
      product: { ...product, code: 'App-3' },
      lastJob: { finished_at: finished, summary: null },
      docIndex: null,
      now: NOW,
    })
    expect(p.is_scrum4me).toBe(false)
    expect(new Date(p.since).getTime()).toBe(finished.getTime() - 60 * 60 * 1000)
  })

  it('repo_url null → lege string; doc_index wordt doorgegeven', () => {
    const p = buildDocsAuditPayload({
      product: { id: 'p2', name: 'X', repo_url: null, code: null },
      lastJob: null,
      docIndex: { folders: [] },
      now: NOW,
    })
    expect(p.product.repo_url).toBe('')
    expect(p.doc_index).toEqual({ folders: [] })
  })
})
