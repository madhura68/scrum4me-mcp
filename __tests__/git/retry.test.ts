import { describe, it, expect, vi } from 'vitest'
import { withRetry, isTransientGitError } from '../../src/git/retry.js'

describe('isTransientGitError', () => {
  it.each([
    'fatal: Unable to create .../index.lock: File exists',
    'fatal: could not lock config file',
    'fatal: unable to access ...: Could not resolve host: origin',
    'error: RPC failed; ... early EOF',
    'ssh: connect to host ...: Connection timed out',
  ])('matches transient: %s', (msg) => {
    expect(isTransientGitError(new Error(msg))).toBe(true)
  })

  it('does not match a permanent error', () => {
    expect(isTransientGitError(new Error('fatal: a branch named X already exists'))).toBe(false)
  })
})

describe('withRetry', () => {
  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    expect(await withRetry(fn, { baseDelayMs: 0 })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries a retryable error then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('index.lock'))
      .mockResolvedValue('ok')
    const onRetry = vi.fn()
    const result = await withRetry(fn, { baseDelayMs: 0, isRetryable: isTransientGitError, onRetry })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('gives up after `retries` attempts and throws the last error', async () => {
    const err = new Error('index.lock')
    const fn = vi.fn().mockRejectedValue(err)
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 0 })).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry when isRetryable returns false', async () => {
    const err = new Error('permanent')
    const fn = vi.fn().mockRejectedValue(err)
    await expect(withRetry(fn, { baseDelayMs: 0, isRetryable: () => false })).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
