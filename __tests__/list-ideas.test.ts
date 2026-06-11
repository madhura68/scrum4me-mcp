import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { idea: { findMany: vi.fn().mockResolvedValue([]) } },
}))
vi.mock('../src/auth.js', () => ({ getAuth: vi.fn() }))
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { getAuth } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { handleListIdeas } from '../src/tools/list-ideas.js'

const mockFindMany = prisma.idea.findMany as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  ;(getAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'user-1' })
  ;(userCanAccessProduct as ReturnType<typeof vi.fn>).mockResolvedValue(true)
  mockFindMany.mockResolvedValue([])
})

it('filtert op user + product, default zonder archived', async () => {
  await handleListIdeas({ product_id: 'prod-1' })
  expect(mockFindMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { user_id: 'user-1', product_id: 'prod-1', archived: false },
      take: 50,
    }),
  )
})

it('status-filter en include_archived werken door in de where', async () => {
  await handleListIdeas({ product_id: 'prod-1', status: 'GRILLED', include_archived: true })
  expect(mockFindMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { user_id: 'user-1', product_id: 'prod-1', status: 'GRILLED' },
    }),
  )
})

it('weigert buiten scope (404-stijl)', async () => {
  ;(userCanAccessProduct as ReturnType<typeof vi.fn>).mockResolvedValue(false)
  const res = await handleListIdeas({ product_id: 'prod-x' })
  expect(res.isError).toBe(true)
})
