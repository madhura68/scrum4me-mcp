import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { product: { findUnique: vi.fn() }, $transaction: vi.fn(), idea: { create: vi.fn() } },
}))
vi.mock('../src/auth.js', () => ({ requireWriteAccess: vi.fn() }))
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { handleCreateIdea } from '../src/tools/create-idea.js'

const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockAccess = userCanAccessProduct as ReturnType<typeof vi.fn>
const mockProduct = (prisma as unknown as { product: { findUnique: ReturnType<typeof vi.fn> } }).product.findUnique

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'user-1', isDemo: false })
  mockAccess.mockResolvedValue(true)
  mockProduct.mockResolvedValue({ content_policy: { forbiddenFields: ['bsn'], forbiddenFeatureTerms: [], allowedFieldTerms: [] } })
})

it('weigert een verboden veld (AVG) bij create_idea — geen ongated-create-venster', async () => {
  const res = await handleCreateIdea({ product_id: 'prod-1', title: 'Voeg een bsn-veld toe' })
  expect(mockProduct).toHaveBeenCalled() // gate aanwezig: content_policy wordt geladen
  expect(res.isError).toBe(true)
})
