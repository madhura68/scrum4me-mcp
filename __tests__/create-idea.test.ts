import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { $transaction: vi.fn(), product: { findUnique: vi.fn() } },
}))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/access.js', () => ({
  userCanAccessProduct: vi.fn(),
}))
vi.mock('../src/lib/idea-code.js', () => ({
  nextIdeaCode: vi.fn().mockResolvedValue('IDEA-042'),
}))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { handleCreateIdea } from '../src/tools/create-idea.js'
import { nextIdeaCode } from '../src/lib/idea-code.js'
import { toolText } from './helpers/tool-result.js'

const mockTx = prisma.$transaction as ReturnType<typeof vi.fn>
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockAccess = userCanAccessProduct as ReturnType<typeof vi.fn>
const mockProduct = (prisma as unknown as { product: { findUnique: ReturnType<typeof vi.fn> } }).product
  .findUnique

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'user-1', isDemo: false })
  mockAccess.mockResolvedValue(true)
  mockProduct.mockResolvedValue({ content_policy: null })
  mockTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ idea: { create: vi.fn().mockResolvedValue({ id: 'idea-1', code: 'IDEA-042' }) } }),
  )
})

it('maakt een DRAFT-idea met gegenereerde code', async () => {
  const res = await handleCreateIdea({ product_id: 'prod-1', title: 'T', description: 'D' })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(toolText(res))).toMatchObject({ code: 'IDEA-042' })
  // tx-doorgifte: code-generatie moet binnen dezelfde transactie lopen
  expect(nextIdeaCode).toHaveBeenCalledWith('user-1', expect.objectContaining({ idea: expect.anything() }))
})

it('accepteert een beschrijving van precies 64.000 tekens', async () => {
  const res = await handleCreateIdea({
    product_id: 'prod-1',
    title: 'Groot idee',
    description: 'x'.repeat(64_000),
  })

  expect(res.isError).toBeFalsy()
})

it('weigert 64.001 tekens met een bruikbare grensmelding', async () => {
  const res = await handleCreateIdea({
    product_id: 'prod-1',
    title: 'Te groot idee',
    description: 'x'.repeat(64_001),
  })

  expect(res.isError).toBe(true)
  expect(toolText(res)).toContain(
    'Beschrijving bevat 64.001 tekens; verwijder 1 teken. Maximaal 64.000 toegestaan.',
  )
  expect(mockTx).not.toHaveBeenCalled()
})

it('telt een emoji als één teken op de grens van 64.000', async () => {
  const res = await handleCreateIdea({
    product_id: 'prod-1',
    title: 'Unicode-idee',
    description: `${'x'.repeat(63_999)}😀`,
  })

  expect(res.isError).toBeFalsy()
})

it('meldt Unicode-overloop in tekens in plaats van UTF-16-eenheden', async () => {
  const res = await handleCreateIdea({
    product_id: 'prod-1',
    title: 'Te groot Unicode-idee',
    description: `${'x'.repeat(64_000)}😀`,
  })

  expect(res.isError).toBe(true)
  expect(toolText(res)).toContain(
    'Beschrijving bevat 64.001 tekens; verwijder 1 teken. Maximaal 64.000 toegestaan.',
  )
  expect(mockTx).not.toHaveBeenCalled()
})

it('weigert een product buiten toegang/scope (404-stijl)', async () => {
  mockAccess.mockResolvedValue(false)
  const res = await handleCreateIdea({ product_id: 'prod-x', title: 'T' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/not found or not accessible/)
})

it('weigert een verboden veld tegen de product content_policy (AVG)', async () => {
  mockProduct.mockResolvedValue({
    content_policy: { forbiddenFields: ['bsn'], forbiddenFeatureTerms: [], allowedFieldTerms: [] },
  })
  const res = await handleCreateIdea({ product_id: 'prod-1', title: 'Voeg een bsn-veld toe' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/AVG.*bsn/)
})

it('staat toe wanneer het product geen content_policy heeft', async () => {
  mockProduct.mockResolvedValue({ content_policy: null })
  const res = await handleCreateIdea({ product_id: 'prod-1', title: 'Hernoem de statuskolom' })
  expect(res.isError).toBeFalsy()
})

it('faalt closed bij een malformed content_policy', async () => {
  mockProduct.mockResolvedValue({ content_policy: { forbiddenFields: 'bsn' } })
  const res = await handleCreateIdea({ product_id: 'prod-1', title: 'Iets onschuldigs' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/content_policy|configuratie/i)
})
