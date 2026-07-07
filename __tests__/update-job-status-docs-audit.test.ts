// M19: unit-tests voor de DOCS_AUDIT-terminal-lifecycle in update_job_status.
// Volle handler-integratie hangt aan tientallen mocks — hier testen we de
// geëxporteerde pure gate (checkDocsAuditTerminal) en de herbruikbare
// applyDocsAuditTerminalUpdate (atomaire guard + server-afgedwongen cursor).
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('checkDocsAuditTerminal (pure gate)', () => {
  it('staat DONE/FAILED toe voor SYSTEM én MANUAL', async () => {
    const { checkDocsAuditTerminal } = await import('../src/tools/update-job-status.js')
    for (const status of ['done', 'failed'] as const) {
      expect(
        checkDocsAuditTerminal({ status, source: 'SYSTEM', skipReason: null, processedUntil: null, capped: false }).ok,
      ).toBe(true)
      expect(
        checkDocsAuditTerminal({ status, source: 'MANUAL', skipReason: null, processedUntil: null, capped: false }).ok,
      ).toBe(true)
    }
  })

  it('SKIPPED vereist een niet-lege skipReason', async () => {
    const { checkDocsAuditTerminal } = await import('../src/tools/update-job-status.js')
    expect(
      checkDocsAuditTerminal({ status: 'skipped', source: 'SYSTEM', skipReason: 'no_merges_since_cursor', processedUntil: null, capped: false }).ok,
    ).toBe(true)
    expect(
      checkDocsAuditTerminal({ status: 'skipped', source: 'SYSTEM', skipReason: null, processedUntil: null, capped: false }).ok,
    ).toBe(false)
    expect(
      checkDocsAuditTerminal({ status: 'skipped', source: 'SYSTEM', skipReason: '   ', processedUntil: null, capped: false }).ok,
    ).toBe(false)
  })

  it('capped vereist een geldige ISO processed_until', async () => {
    const { checkDocsAuditTerminal } = await import('../src/tools/update-job-status.js')
    expect(
      checkDocsAuditTerminal({ status: 'done', source: 'SYSTEM', skipReason: null, processedUntil: null, capped: true }).ok,
    ).toBe(false)
    expect(
      checkDocsAuditTerminal({ status: 'done', source: 'SYSTEM', skipReason: null, processedUntil: 'geen-datum', capped: true }).ok,
    ).toBe(false)
    expect(
      checkDocsAuditTerminal({ status: 'done', source: 'SYSTEM', skipReason: null, processedUntil: '2026-07-02T12:00:00.000Z', capped: true }).ok,
    ).toBe(true)
  })

  it('weigert een onbekende source (bv. COPILOT)', async () => {
    const { checkDocsAuditTerminal } = await import('../src/tools/update-job-status.js')
    expect(
      checkDocsAuditTerminal({ status: 'done', source: 'COPILOT', skipReason: null, processedUntil: null, capped: false }).ok,
    ).toBe(false)
  })
})

vi.mock('../src/prisma.js', () => ({
  prisma: { claudeJob: { updateMany: vi.fn() } },
}))

import { prisma } from '../src/prisma.js'
import { applyDocsAuditTerminalUpdate } from '../src/tools/update-job-status.js'

const mockPrisma = prisma as unknown as { claudeJob: { updateMany: ReturnType<typeof vi.fn> } }

describe('applyDocsAuditTerminalUpdate (atomaire guard + server-cursor)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('DONE happy path: atomaire WHERE met álle invarianten; ok', async () => {
    mockPrisma.claudeJob.updateMany.mockResolvedValue({ count: 1 })
    const res = await applyDocsAuditTerminalUpdate({
      jobId: 'j1', callerTokenId: 'tok', status: 'done', source: 'SYSTEM',
      summary: 'klaar', skipReason: null, processedUntil: null, capped: false,
    })
    expect(res).toEqual({ ok: true, status: 'DONE' })
    expect(mockPrisma.claudeJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'j1',
          kind: 'DOCS_AUDIT',
          claimed_by_token_id: 'tok',
          status: { in: ['CLAIMED', 'RUNNING'] },
        }),
      }),
    )
  })

  it('gecapte DONE schrijft de server-cursor in de summary', async () => {
    mockPrisma.claudeJob.updateMany.mockResolvedValue({ count: 1 })
    await applyDocsAuditTerminalUpdate({
      jobId: 'j1', callerTokenId: 'tok', status: 'done', source: 'SYSTEM',
      summary: 'verwerkt 30 PRs', skipReason: null, processedUntil: '2026-07-02T12:00:00.000Z', capped: true,
    })
    const call = mockPrisma.claudeJob.updateMany.mock.calls[0][0] as { data: { summary: string } }
    expect(call.data.summary).toContain('docs_audit_cursor=2026-07-02T12:00:00.000Z')
  })

  it('0 rijen geraakt (stale token / al terminaal / CANCELLED) → reject', async () => {
    mockPrisma.claudeJob.updateMany.mockResolvedValue({ count: 0 })
    const res = await applyDocsAuditTerminalUpdate({
      jobId: 'j1', callerTokenId: 'stale-token', status: 'done', source: 'SYSTEM',
      summary: null, skipReason: null, processedUntil: null, capped: false,
    })
    expect(res.ok).toBe(false)
  })

  it('capped zonder geldige cursor → reject vóór de DB-call', async () => {
    const res = await applyDocsAuditTerminalUpdate({
      jobId: 'j1', callerTokenId: 'tok', status: 'done', source: 'SYSTEM',
      summary: null, skipReason: null, processedUntil: null, capped: true,
    })
    expect(res.ok).toBe(false)
    expect(mockPrisma.claudeJob.updateMany).not.toHaveBeenCalled()
  })
})
