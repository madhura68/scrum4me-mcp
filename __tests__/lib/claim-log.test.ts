import { describe, it, expect, vi, afterEach } from 'vitest'
import { claimLog } from '../../src/lib/claim-log.js'

afterEach(() => vi.restoreAllMocks())

describe('claimLog', () => {
  it('writes a JSON line to stderr with scope, event and fields', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    claimLog('repoRoot.resolved', { productId: 'p1', via: 'product-env' })
    expect(spy).toHaveBeenCalledOnce()
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({
      scope: 'claim',
      event: 'repoRoot.resolved',
      productId: 'p1',
      via: 'product-env',
    })
  })
})
