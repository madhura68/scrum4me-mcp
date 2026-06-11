import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { $transaction: vi.fn() },
}))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(),
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

const mockTx = prisma.$transaction as ReturnType<typeof vi.fn>
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockAccess = userCanAccessProduct as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'user-1', isDemo: false })
  mockAccess.mockResolvedValue(true)
  mockTx.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ idea: { create: vi.fn().mockResolvedValue({ id: 'idea-1', code: 'IDEA-042' }) } }),
  )
})

it('maakt een DRAFT-idea met gegenereerde code', async () => {
  const res = await handleCreateIdea({ product_id: 'prod-1', title: 'T', description: 'D' })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(res.content[0].text as string)).toMatchObject({ code: 'IDEA-042' })
  // tx-doorgifte: code-generatie moet binnen dezelfde transactie lopen
  expect(nextIdeaCode).toHaveBeenCalledWith('user-1', expect.objectContaining({ idea: expect.anything() }))
})

it('weigert een product buiten toegang/scope (404-stijl)', async () => {
  mockAccess.mockResolvedValue(false)
  const res = await handleCreateIdea({ product_id: 'prod-x', title: 'T' })
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/not found or not accessible/)
})
