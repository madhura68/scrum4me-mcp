import { describe, it, expect } from 'vitest'
import { checkVerifyGate } from '../src/tools/update-job-status.js'

describe('checkVerifyGate', () => {
  it('rejects when verify_result is null — agent must verify first', () => {
    const r = checkVerifyGate(null, false)
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.error).toMatch(/verify_task_against_plan/i)
  })

  it('rejects when verify_result is EMPTY and task is not verify_only', () => {
    const r = checkVerifyGate('EMPTY', false)
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.error).toMatch(/EMPTY/i)
      expect(r.error).toMatch(/verify_only/i)
    }
  })

  it('allows when verify_result is EMPTY and task IS verify_only', () => {
    const r = checkVerifyGate('EMPTY', true)
    expect(r.allowed).toBe(true)
  })

  it('allows when verify_result is ALIGNED', () => {
    const r = checkVerifyGate('ALIGNED', false)
    expect(r.allowed).toBe(true)
  })

  it('allows when verify_result is PARTIAL', () => {
    const r = checkVerifyGate('PARTIAL', false)
    expect(r.allowed).toBe(true)
  })

  it('allows when verify_result is DIVERGENT', () => {
    const r = checkVerifyGate('DIVERGENT', false)
    expect(r.allowed).toBe(true)
  })
})
