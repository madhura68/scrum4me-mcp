import { describe, it, expect, beforeEach } from 'vitest'
import { clearLeases, registerLease } from '../src/queue/lease-register.js'
import { verifyLocalOwnership } from '../src/queue/ownership.js'

beforeEach(() => clearLeases())

describe('verifyLocalOwnership — §5.4-precedentiematrix', () => {
  it('pending zonder token → ok met expectedClaimedBy null (FIFO-bypass)', () => {
    expect(verifyLocalOwnership({ messageId: 'm', rowStatus: 'pending', claimToken: undefined }))
      .toEqual({ ok: true, expectedClaimedBy: null })
  })

  it('pending mét token → QUEUE_CLAIM_EXPIRED (zombie-afronder)', () => {
    const verdict = verifyLocalOwnership({ messageId: 'm', rowStatus: 'pending', claimToken: 'tok' })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toMatch(/^QUEUE_CLAIM_EXPIRED/)
  })

  it('claimed zonder lokale entry, mét token → QUEUE_CLAIM_EXPIRED (stap a, ook binnen het lease-venster)', () => {
    const verdict = verifyLocalOwnership({ messageId: 'm', rowStatus: 'claimed', claimToken: 'tok' })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toMatch(/^QUEUE_CLAIM_EXPIRED/)
  })

  it('claimed zonder lokale entry, zonder token → QUEUE_NOT_CLAIMER (CLI-claims, §7)', () => {
    const verdict = verifyLocalOwnership({ messageId: 'm', rowStatus: 'claimed', claimToken: undefined })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toMatch(/^QUEUE_NOT_CLAIMER/)
  })

  it('entry aanwezig maar token mismatcht → QUEUE_NOT_CLAIMER (stap b)', () => {
    registerLease('m', { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    const verdict = verifyLocalOwnership({ messageId: 'm', rowStatus: 'claimed', claimToken: 'fout' })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toMatch(/^QUEUE_NOT_CLAIMER/)
  })

  it('entry aanwezig maar token ontbreekt → QUEUE_NOT_CLAIMER (stap b)', () => {
    registerLease('m', { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    const verdict = verifyLocalOwnership({ messageId: 'm', rowStatus: 'claimed', claimToken: undefined })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toMatch(/^QUEUE_NOT_CLAIMER/)
  })

  it('entry + matchend token → ok met de volledige verwachte claimed_by voor stap c', () => {
    registerLease('m', { claimToken: 'tok', claimedBy: 'mcp:inst:tok' })
    expect(verifyLocalOwnership({ messageId: 'm', rowStatus: 'claimed', claimToken: 'tok' }))
      .toEqual({ ok: true, expectedClaimedBy: 'mcp:inst:tok' })
  })
})
