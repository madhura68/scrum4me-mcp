import { describe, expect, it } from 'vitest'
import { BASE_BACKOFF_MS, MAX_BACKOFF_MS, backoffDelayMs } from '../src/lib/retry-backoff.js'

describe('backoffDelayMs', () => {
  it('grows the ceiling exponentially per retry', () => {
    const full = () => 1
    expect(backoffDelayMs(0, full)).toBe(BASE_BACKOFF_MS)
    expect(backoffDelayMs(1, full)).toBe(BASE_BACKOFF_MS * 2)
    expect(backoffDelayMs(2, full)).toBe(BASE_BACKOFF_MS * 4)
  })

  it('caps the ceiling so a long retry chain cannot stall', () => {
    expect(backoffDelayMs(20, () => 1)).toBe(MAX_BACKOFF_MS)
  })

  // Full jitter: contending losers must not wake up together, which is what
  // turned concurrent creates into lockstep re-collisions.
  it('spreads the delay across the whole ceiling', () => {
    expect(backoffDelayMs(2, () => 0)).toBe(0)
    expect(backoffDelayMs(2, () => 0.5)).toBe(BASE_BACKOFF_MS * 2)
    expect(backoffDelayMs(2, () => 1)).toBe(BASE_BACKOFF_MS * 4)
  })
})
