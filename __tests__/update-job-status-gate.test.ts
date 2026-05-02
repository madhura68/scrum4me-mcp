import { describe, it, expect } from 'vitest'
import { checkVerifyGate } from '../src/tools/update-job-status.js'

const LONG_SUMMARY = 'Refactor touched extra files for type narrowing.'

describe('checkVerifyGate', () => {
  it('rejects when verify_result is null', () => {
    const r = checkVerifyGate(null, false)
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.error).toMatch(/verify_task_against_plan/i)
  })

  it('rejects EMPTY when task is not verify_only', () => {
    const r = checkVerifyGate('EMPTY', false)
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.error).toMatch(/EMPTY/i)
  })

  it('allows EMPTY when task is verify_only', () => {
    expect(checkVerifyGate('EMPTY', true).allowed).toBe(true)
  })

  it('always allows ALIGNED', () => {
    expect(checkVerifyGate('ALIGNED', false, 'ALIGNED').allowed).toBe(true)
    expect(checkVerifyGate('ALIGNED', false, 'ALIGNED_OR_PARTIAL').allowed).toBe(true)
    expect(checkVerifyGate('ALIGNED', false, 'ANY').allowed).toBe(true)
  })

  describe('verify_required=ALIGNED (strict)', () => {
    it('rejects PARTIAL', () => {
      const r = checkVerifyGate('PARTIAL', false, 'ALIGNED', LONG_SUMMARY)
      expect(r.allowed).toBe(false)
      if (!r.allowed) expect(r.error).toMatch(/ALIGNED/)
    })
    it('rejects DIVERGENT', () => {
      const r = checkVerifyGate('DIVERGENT', false, 'ALIGNED', LONG_SUMMARY)
      expect(r.allowed).toBe(false)
    })
  })

  describe('verify_required=ALIGNED_OR_PARTIAL (default — needs summary on drift)', () => {
    it('rejects PARTIAL without summary', () => {
      const r = checkVerifyGate('PARTIAL', false, 'ALIGNED_OR_PARTIAL', undefined)
      expect(r.allowed).toBe(false)
      if (!r.allowed) expect(r.error).toMatch(/summary/i)
    })
    it('rejects PARTIAL with too-short summary', () => {
      const r = checkVerifyGate('PARTIAL', false, 'ALIGNED_OR_PARTIAL', 'short')
      expect(r.allowed).toBe(false)
    })
    it('allows PARTIAL with long summary', () => {
      expect(checkVerifyGate('PARTIAL', false, 'ALIGNED_OR_PARTIAL', LONG_SUMMARY).allowed).toBe(true)
    })
    it('rejects DIVERGENT without summary', () => {
      expect(checkVerifyGate('DIVERGENT', false, 'ALIGNED_OR_PARTIAL', undefined).allowed).toBe(false)
    })
    it('allows DIVERGENT with long summary', () => {
      expect(checkVerifyGate('DIVERGENT', false, 'ALIGNED_OR_PARTIAL', LONG_SUMMARY).allowed).toBe(true)
    })
  })

  describe('verify_required=ANY (refactor escape hatch)', () => {
    it('allows PARTIAL without summary', () => {
      expect(checkVerifyGate('PARTIAL', false, 'ANY').allowed).toBe(true)
    })
    it('allows DIVERGENT without summary', () => {
      expect(checkVerifyGate('DIVERGENT', false, 'ANY').allowed).toBe(true)
    })
    it('still rejects EMPTY (verify_only takes precedence)', () => {
      expect(checkVerifyGate('EMPTY', false, 'ANY').allowed).toBe(false)
    })
  })

  it('default verify_required=ALIGNED_OR_PARTIAL when omitted', () => {
    // No third arg → falls back to ALIGNED_OR_PARTIAL → PARTIAL needs summary
    const r = checkVerifyGate('PARTIAL', false)
    expect(r.allowed).toBe(false)
  })
})
