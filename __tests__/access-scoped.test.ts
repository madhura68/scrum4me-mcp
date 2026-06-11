// __tests__/access-scoped.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { product: { findFirst: vi.fn() } },
}))
vi.mock('../src/auth.js', () => ({
  getTokenScopedProducts: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { getTokenScopedProducts } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'

const mockFindFirst = prisma.product.findFirst as ReturnType<typeof vi.fn>
const mockScope = getTokenScopedProducts as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mockFindFirst.mockResolvedValue({ id: 'prod-1' })
})

describe('userCanAccessProduct — token-scope (IDEA-118)', () => {
  it('ongescopet token: bestaand gedrag (member-check beslist)', async () => {
    mockScope.mockResolvedValue([])
    await expect(userCanAccessProduct('prod-1', 'user-1')).resolves.toBe(true)
  })

  it('scoped token: product binnen scope → member-check beslist', async () => {
    mockScope.mockResolvedValue(['prod-1'])
    await expect(userCanAccessProduct('prod-1', 'user-1')).resolves.toBe(true)
  })

  it('scoped token: product buiten scope → false, zónder DB-query', async () => {
    mockScope.mockResolvedValue(['prod-1'])
    await expect(userCanAccessProduct('prod-2', 'user-1')).resolves.toBe(false)
    expect(mockFindFirst).not.toHaveBeenCalled()
  })
})
