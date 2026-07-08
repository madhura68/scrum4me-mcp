import { describe, it, expect } from 'vitest'

import { parseLoopRound, loopKey, appendPlanReviewRound } from '../src/lib/idea-plan-loop.js'

describe('parseLoopRound', () => {
  it('null/undefined → 0', () => {
    expect(parseLoopRound(null)).toBe(0)
    expect(parseLoopRound(undefined)).toBe(0)
  })
  it('loop-key → ronde-nummer', () => {
    expect(parseLoopRound('idea:abc:plan-loop:r3')).toBe(3)
    expect(parseLoopRound('idea:xyz:plan-loop:r1')).toBe(1)
  })
  it('vreemde key → 0', () => {
    expect(parseLoopRound('auto:pr:owner/repo#1@sha')).toBe(0)
    expect(parseLoopRound('verify-after-implementation')).toBe(0)
  })
})

describe('loopKey', () => {
  it('bouwt een rondegebonden key', () => {
    expect(loopKey('abc', 2)).toBe('idea:abc:plan-loop:r2')
  })
  it('round-trip met parseLoopRound', () => {
    expect(parseLoopRound(loopKey('id1', 5))).toBe(5)
  })
})

describe('appendPlanReviewRound', () => {
  it('mapt CHANGES_REQUESTED → pending approval + severity major→error', () => {
    const log = appendPlanReviewRound(null, {
      round: 1,
      verdict: 'CHANGES_REQUESTED',
      model: 'codex',
      findings: [{ severity: 'major', message: 'X ontbreekt', ref: 'sectie 2' }],
      summary: 'NO-GO',
      timestamp: '2026-07-07T00:00:00Z',
    })
    expect(log.rounds).toHaveLength(1)
    expect(log.approval.status).toBe('pending')
    expect(log.rounds[0].issues[0].severity).toBe('error')
    expect(log.rounds[0].score).toBe(50)
    expect(log.rounds[0].model).toBe('codex')
  })

  it('mapt APPROVED → approved + score 100 + converged', () => {
    const log = appendPlanReviewRound(null, {
      round: 2,
      verdict: 'APPROVED',
      model: 'codex',
      findings: [],
      summary: 'GO',
      timestamp: '2026-07-07T00:00:00Z',
    })
    expect(log.approval.status).toBe('approved')
    expect(log.rounds[0].score).toBe(100)
    expect(log.rounds[0].converged).toBe(true)
  })

  it('mapt REJECTED → rejected + score 0', () => {
    const log = appendPlanReviewRound(null, {
      round: 1,
      verdict: 'REJECTED',
      model: 'codex',
      findings: [{ severity: 'blocker', message: 'fout' }],
      summary: 'afgewezen',
      timestamp: '2026-07-07T00:00:00Z',
    })
    expect(log.approval.status).toBe('rejected')
    expect(log.rounds[0].score).toBe(0)
    expect(log.rounds[0].issues[0].severity).toBe('error')
  })

  it('appendt aan bestaande rondes', () => {
    const first = appendPlanReviewRound(null, {
      round: 1, verdict: 'CHANGES_REQUESTED', model: 'codex', findings: [], summary: 'r1',
      timestamp: '2026-07-07T00:00:00Z',
    })
    const second = appendPlanReviewRound(first, {
      round: 2, verdict: 'APPROVED', model: 'codex', findings: [], summary: 'r2',
      timestamp: '2026-07-07T01:00:00Z',
    })
    expect(second.rounds).toHaveLength(2)
    expect(second.rounds[1].round).toBe(2)
    expect(second.approval.status).toBe('approved')
  })

  it('minor-severity → warning; overig → info', () => {
    const log = appendPlanReviewRound(null, {
      round: 1, verdict: 'CHANGES_REQUESTED', model: 'codex',
      findings: [{ severity: 'minor', message: 'nit' }, { severity: 'note', message: 'fyi' }],
      summary: 's', timestamp: '2026-07-07T00:00:00Z',
    })
    expect(log.rounds[0].issues[0].severity).toBe('warning')
    expect(log.rounds[0].issues[1].severity).toBe('info')
  })
})
