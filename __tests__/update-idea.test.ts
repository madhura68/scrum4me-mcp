import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    product: { findUnique: vi.fn() },
    idea: { findFirst: vi.fn(), update: vi.fn() },
  },
}))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(),
  PermissionDeniedError: class PermissionDeniedError extends Error {
    constructor(message = 'Demo accounts cannot perform write operations') {
      super(message)
      this.name = 'PermissionDeniedError'
    }
  },
}))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess, PermissionDeniedError } from '../src/auth.js'
import { handleUpdateIdea } from '../src/tools/update-idea.js'

const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockProduct = (prisma as unknown as { product: { findUnique: ReturnType<typeof vi.fn> } })
  .product.findUnique
const mockFind = (prisma as unknown as { idea: { findFirst: ReturnType<typeof vi.fn> } })
  .idea.findFirst
const mockUpdate = (prisma as unknown as { idea: { update: ReturnType<typeof vi.fn> } })
  .idea.update

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'user-1', isDemo: false })
  mockProduct.mockResolvedValue({ content_policy: null })
  mockFind.mockResolvedValue({ id: 'idea-1', status: 'DRAFT' })
  mockUpdate.mockResolvedValue({ id: 'idea-1', code: 'IDEA-042', status: 'DRAFT' })
})

it('werkt titel/beschrijving bij (happy path)', async () => {
  const res = await handleUpdateIdea({
    idea_id: 'idea-1',
    product_id: 'prod-1',
    title: 'Nieuwe titel',
    description: 'Nieuwe omschrijving',
  })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(res.content[0].text as string)).toMatchObject({ id: 'idea-1', code: 'IDEA-042' })
  expect(mockUpdate).toHaveBeenCalledWith({
    where: { id: 'idea-1' },
    data: { title: 'Nieuwe titel', description: 'Nieuwe omschrijving' },
    select: { id: true, code: true, status: true },
  })
})

it('eist minstens één van title/description', async () => {
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1' })
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/VALIDATION_ERROR/)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('weigert een verboden veld tegen de product content_policy (AVG)', async () => {
  mockProduct.mockResolvedValue({
    content_policy: { forbiddenFields: ['bsn'], forbiddenFeatureTerms: [], allowedFieldTerms: [] },
  })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', title: 'Voeg een bsn-veld toe' })
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/AVG.*bsn/)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('faalt closed bij een malformed content_policy', async () => {
  mockProduct.mockResolvedValue({ content_policy: { forbiddenFields: 'bsn' } })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', title: 'Iets onschuldigs' })
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/content_policy|configuratie/i)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('weigert een idee buiten product/pool (cross-product/ownership, 404-stijl)', async () => {
  mockFind.mockResolvedValue(null)
  const res = await handleUpdateIdea({ idea_id: 'idea-x', product_id: 'prod-2', title: 'T' })
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/not found/i)
  expect(mockFind).toHaveBeenCalledWith({
    where: { id: 'idea-x', user_id: 'user-1', product_id: 'prod-2' },
    select: { id: true, status: true },
  })
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('weigert bewerken bij een niet-editable status', async () => {
  mockFind.mockResolvedValue({ id: 'idea-1', status: 'GRILLING' })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', title: 'T' })
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/GRILLING/)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('weigert demo-accounts (PERMISSION_DENIED)', async () => {
  mockAuth.mockRejectedValue(new PermissionDeniedError())
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', title: 'T' })
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/PERMISSION_DENIED/)
})
