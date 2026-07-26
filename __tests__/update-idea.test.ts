import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    product: { findUnique: vi.fn() },
    idea: { findFirst: vi.fn(), update: vi.fn() },
    ideaChatMessage: { create: vi.fn() },
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
import { toolText } from './helpers/tool-result.js'

const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockProduct = (prisma as unknown as { product: { findUnique: ReturnType<typeof vi.fn> } })
  .product.findUnique
const mockFind = (prisma as unknown as { idea: { findFirst: ReturnType<typeof vi.fn> } })
  .idea.findFirst
const mockUpdate = (prisma as unknown as { idea: { update: ReturnType<typeof vi.fn> } })
  .idea.update
const mockChatMessage = (prisma as unknown as {
  ideaChatMessage: { create: ReturnType<typeof vi.fn> }
}).ideaChatMessage.create

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'user-1', isDemo: false })
  mockProduct.mockResolvedValue({ content_policy: null })
  mockFind.mockResolvedValue({ id: 'idea-1', status: 'DRAFT' })
  mockUpdate.mockResolvedValue({ id: 'idea-1', code: 'IDEA-042', status: 'DRAFT' })
  mockChatMessage.mockResolvedValue({ id: 'msg-1' })
})

it('werkt titel/beschrijving bij (happy path)', async () => {
  const res = await handleUpdateIdea({
    idea_id: 'idea-1',
    product_id: 'prod-1',
    title: 'Nieuwe titel',
    description: 'Nieuwe omschrijving',
  })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(toolText(res))).toMatchObject({ id: 'idea-1', code: 'IDEA-042' })
  expect(mockUpdate).toHaveBeenCalledWith({
    where: { id: 'idea-1' },
    data: { title: 'Nieuwe titel', description: 'Nieuwe omschrijving' },
    select: { id: true, code: true, status: true },
  })
  // M17 idea-chat: doc-update zichtbaar als SYSTEM/DOC_UPDATE-kanaalbericht.
  expect(mockChatMessage).toHaveBeenCalledWith({
    data: {
      idea_id: 'idea-1',
      role: 'SYSTEM',
      kind: 'DOC_UPDATE',
      content: 'Beschrijving bijgewerkt door de agent',
      metadata: { fields: ['title', 'description'] },
    },
  })
})

it('een falende kanaalbericht-write laat de idea-update slagen (best-effort)', async () => {
  mockChatMessage.mockRejectedValue(new Error('db weg'))
  const res = await handleUpdateIdea({
    idea_id: 'idea-1',
    product_id: 'prod-1',
    title: 'Nieuwe titel',
  })
  expect(res.isError).toBeFalsy()
  expect(mockUpdate).toHaveBeenCalled()
})

it('eist minstens één van title/description', async () => {
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/VALIDATION_ERROR/)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('weigert een verboden veld tegen de product content_policy (AVG)', async () => {
  mockProduct.mockResolvedValue({
    content_policy: { forbiddenFields: ['bsn'], forbiddenFeatureTerms: [], allowedFieldTerms: [] },
  })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', title: 'Voeg een bsn-veld toe' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/AVG.*bsn/)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('faalt closed bij een malformed content_policy', async () => {
  mockProduct.mockResolvedValue({ content_policy: { forbiddenFields: 'bsn' } })
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', title: 'Iets onschuldigs' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/content_policy|configuratie/i)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('weigert een idee buiten product/pool (cross-product/ownership, 404-stijl)', async () => {
  mockFind.mockResolvedValue(null)
  const res = await handleUpdateIdea({ idea_id: 'idea-x', product_id: 'prod-2', title: 'T' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/not found/i)
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
  expect(toolText(res)).toMatch(/GRILLING/)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('weigert demo-accounts (PERMISSION_DENIED)', async () => {
  mockAuth.mockRejectedValue(new PermissionDeniedError())
  const res = await handleUpdateIdea({ idea_id: 'idea-1', product_id: 'prod-1', title: 'T' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/PERMISSION_DENIED/)
})
