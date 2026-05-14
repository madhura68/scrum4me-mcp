// Unit-tests voor resolveJobTimestamps — de status-gedreven timestamp-helper
// van update_job_status. Pure functie, geen mocks (zoals update-job-status-gate).

import { describe, it, expect } from 'vitest'
import { resolveJobTimestamps } from '../src/tools/update-job-status.js'

const NOW = new Date('2026-05-14T12:00:00.000Z')
const EARLIER = new Date('2026-05-14T11:00:00.000Z')

describe('resolveJobTimestamps', () => {
  describe('running', () => {
    it('sets started_at when not yet set, no finished_at', () => {
      const r = resolveJobTimestamps('running', { claimed_at: EARLIER, started_at: null }, NOW)
      expect(r.started_at).toBe(NOW)
      expect(r.finished_at).toBeUndefined()
      expect(r.claimed_at).toBeUndefined()
    })

    it('is set-once: does not re-stamp started_at when already set', () => {
      const r = resolveJobTimestamps('running', { claimed_at: EARLIER, started_at: EARLIER }, NOW)
      expect(r.started_at).toBeUndefined()
      expect(r.finished_at).toBeUndefined()
      expect(r.claimed_at).toBeUndefined()
    })
  })

  describe('terminal transitions (done/failed/skipped)', () => {
    it.each(['done', 'failed', 'skipped'] as const)(
      'backfills started_at and sets finished_at for %s when started_at is null',
      (status) => {
        const r = resolveJobTimestamps(status, { claimed_at: EARLIER, started_at: null }, NOW)
        expect(r.started_at).toBe(NOW)
        expect(r.finished_at).toBe(NOW)
        expect(r.claimed_at).toBeUndefined()
      },
    )

    it('only sets finished_at when started_at is already set', () => {
      const r = resolveJobTimestamps('done', { claimed_at: EARLIER, started_at: EARLIER }, NOW)
      expect(r.started_at).toBeUndefined()
      expect(r.finished_at).toBe(NOW)
      expect(r.claimed_at).toBeUndefined()
    })
  })

  describe('claimed_at backfill', () => {
    it.each(['running', 'done', 'failed', 'skipped'] as const)(
      'backfills claimed_at for %s when it is null',
      (status) => {
        const r = resolveJobTimestamps(status, { claimed_at: null, started_at: null }, NOW)
        expect(r.claimed_at).toBe(NOW)
      },
    )

    it('never returns claimed_at when it is already set', () => {
      const r = resolveJobTimestamps('done', { claimed_at: EARLIER, started_at: EARLIER }, NOW)
      expect(r.claimed_at).toBeUndefined()
    })
  })

  it('returns only finished_at when all timestamps are already set and status is terminal', () => {
    const r = resolveJobTimestamps('failed', { claimed_at: EARLIER, started_at: EARLIER }, NOW)
    expect(r).toEqual({ finished_at: NOW })
  })

  it('defaults now to a fresh Date when omitted', () => {
    const before = Date.now()
    const r = resolveJobTimestamps('running', { claimed_at: EARLIER, started_at: null })
    const after = Date.now()
    expect(r.started_at).toBeInstanceOf(Date)
    expect(r.started_at!.getTime()).toBeGreaterThanOrEqual(before)
    expect(r.started_at!.getTime()).toBeLessThanOrEqual(after)
  })
})
