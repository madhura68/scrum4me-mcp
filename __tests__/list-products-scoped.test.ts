// __tests__/list-products-scoped.test.ts
import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { product: { findMany: vi.fn() } },
}))
vi.mock('../src/auth.js', () => ({
  getAuth: vi.fn(),
  getTokenScopedProducts: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { getAuth } from '../src/auth.js'
import { handleListProducts } from '../src/tools/list-products.js'

const mockFindMany = prisma.product.findMany as ReturnType<typeof vi.fn>
const mockGetAuth = getAuth as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mockFindMany.mockResolvedValue([])
})

it('scoped token → where bevat id-in-scope-filter', async () => {
  mockGetAuth.mockResolvedValue({ userId: 'user-1', scopedProducts: ['prod-1', 'prod-2'] })
  await handleListProducts()
  expect(mockFindMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ id: { in: ['prod-1', 'prod-2'] } }),
    }),
  )
})

it('ongescopet token → geen id-filter', async () => {
  mockGetAuth.mockResolvedValue({ userId: 'user-1', scopedProducts: [] })
  await handleListProducts()
  const arg = mockFindMany.mock.calls[0][0]
  expect(arg.where.id).toBeUndefined()
})
