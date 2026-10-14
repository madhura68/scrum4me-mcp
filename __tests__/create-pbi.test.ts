import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toolText } from './helpers/tool-result.js'
import type { AnyMock } from './helpers/mocks.js'

vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn().mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' }),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/access.js', () => ({
  userCanAccessProduct: vi.fn().mockResolvedValue(true),
}))
// executePpeMutation doorlussen zodat we het request kunnen inspecteren dat
// in de PPE payload_hash terechtkomt, zonder controller-database.
vi.mock('../src/lib/ppe-operation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ppe-operation.js')>()),
  executePpeMutation: vi.fn((input: { mutate: () => Promise<unknown> }) => input.mutate()),
}))

const { tx, root } = vi.hoisted(() => {
  const transactionClient = {
    pbi: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    pbiDoc: { upsert: vi.fn() },
    idea: { updateMany: vi.fn() },
  }
  const prismaClient = {
    productDoc: { findMany: vi.fn() },
    productDocRevision: { findUnique: vi.fn() },
    idea: { findFirst: vi.fn(), updateMany: vi.fn() },
    ideaProduct: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  }
  return { tx: transactionClient, root: prismaClient }
})

vi.mock('../src/prisma.js', () => ({ prisma: root }))

import { handleCreatePbi } from '../src/tools/create-pbi.js'
import { executePpeMutation } from '../src/lib/ppe-operation.js'

const mockExecutePpeMutation = executePpeMutation as unknown as AnyMock

const PRODUCT_ID = 'prod-1'
const IDEA_ID = 'idea-1'

beforeEach(() => {
  vi.clearAllMocks()
  root.productDoc.findMany.mockResolvedValue([])
  root.idea.findFirst.mockResolvedValue({ product_id: PRODUCT_ID })
  root.ideaProduct.findUnique.mockResolvedValue(null)
  tx.pbi.findMany.mockResolvedValue([])
  tx.pbi.findFirst.mockResolvedValue({ sort_order: 3 })
  tx.pbi.create.mockResolvedValue({ id: 'pbi-1', code: 'PBI-1', title: 'PBI', sort_order: 4 })
  tx.idea.updateMany.mockResolvedValue({ count: 1 })
  root.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
})

function parse(result: Awaited<ReturnType<typeof handleCreatePbi>>) {
  return JSON.parse(toolText(result))
}

describe('handleCreatePbi zonder idea_id', () => {
  it('raakt geen idee aan en geeft geen idea_link terug', async () => {
    const result = await handleCreatePbi({ product_id: PRODUCT_ID, title: 'PBI', priority: 2 })

    expect(root.idea.findFirst).not.toHaveBeenCalled()
    expect(root.ideaProduct.findUnique).not.toHaveBeenCalled()
    expect(tx.idea.updateMany).not.toHaveBeenCalled()
    expect(root.idea.updateMany).not.toHaveBeenCalled()
    const parsed = parse(result)
    expect(parsed.id).toBe('pbi-1')
    expect(parsed).not.toHaveProperty('idea_link')
  })

  it('houdt het PPE-request gelijk: geen idea_id-key', async () => {
    await handleCreatePbi({ product_id: PRODUCT_ID, title: 'PBI', priority: 2 })

    const request = mockExecutePpeMutation.mock.calls[0][0].request
    expect(request).toEqual({
      product_id: PRODUCT_ID, title: 'PBI', description: null, priority: 2,
      source_docs: null, ceremony_object_key: null,
    })
    expect('idea_id' in request).toBe(false)
  })
})

describe('handleCreatePbi met idea_id', () => {
  it('koppelt ideas.pbi_id als die leeg is', async () => {
    const result = await handleCreatePbi({ product_id: PRODUCT_ID, title: 'PBI', priority: 2, idea_id: IDEA_ID })

    expect(root.idea.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: IDEA_ID, user_id: 'user-1' },
    }))
    expect(tx.idea.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.idea.updateMany).toHaveBeenCalledWith({
      where: { id: IDEA_ID, pbi_id: null },
      data: { pbi_id: 'pbi-1' },
    })
    expect(parse(result).idea_link).toEqual({ idea_id: IDEA_ID, field: 'pbi_id', outcome: 'set' })
  })

  it('overschrijft een bestaande koppeling niet, maar maakt de PBI wel aan', async () => {
    tx.idea.updateMany.mockResolvedValue({ count: 0 })

    const result = await handleCreatePbi({ product_id: PRODUCT_ID, title: 'PBI', priority: 2, idea_id: IDEA_ID })

    expect(tx.pbi.create).toHaveBeenCalledTimes(1)
    const parsed = parse(result)
    expect(parsed.id).toBe('pbi-1')
    expect(parsed.idea_link).toEqual({ idea_id: IDEA_ID, field: 'pbi_id', outcome: 'skipped_existing' })
  })

  it('zet idea_id in het PPE-request als die is meegegeven', async () => {
    await handleCreatePbi({ product_id: PRODUCT_ID, title: 'PBI', priority: 2, idea_id: IDEA_ID })

    expect(mockExecutePpeMutation.mock.calls[0][0].request.idea_id).toBe(IDEA_ID)
  })

  it('weigert een vreemd of onbekend idee zonder iets aan te maken', async () => {
    root.idea.findFirst.mockResolvedValue(null)

    const result = await handleCreatePbi({ product_id: PRODUCT_ID, title: 'PBI', priority: 2, idea_id: IDEA_ID })

    expect(result.isError).toBe(true)
    expect(toolText(result)).toMatch(/not found or not accessible/)
    expect(tx.pbi.create).not.toHaveBeenCalled()
    expect(mockExecutePpeMutation).not.toHaveBeenCalled()
  })

  it('weigert een product dat primair noch secundair bij het idee hoort', async () => {
    root.idea.findFirst.mockResolvedValue({ product_id: 'other-product' })
    root.ideaProduct.findUnique.mockResolvedValue(null)

    const result = await handleCreatePbi({ product_id: PRODUCT_ID, title: 'PBI', priority: 2, idea_id: IDEA_ID })

    expect(result.isError).toBe(true)
    expect(toolText(result)).toMatch(/does not belong to product/)
    expect(root.ideaProduct.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { idea_id_product_id: { idea_id: IDEA_ID, product_id: PRODUCT_ID } },
    }))
    expect(tx.pbi.create).not.toHaveBeenCalled()
  })

  it('accepteert een secundair product (idea_products-rij)', async () => {
    root.idea.findFirst.mockResolvedValue({ product_id: 'other-product' })
    root.ideaProduct.findUnique.mockResolvedValue({ id: 'ip-1' })

    const result = await handleCreatePbi({ product_id: PRODUCT_ID, title: 'PBI', priority: 2, idea_id: IDEA_ID })

    expect(result.isError).toBeFalsy()
    expect(tx.pbi.create).toHaveBeenCalledTimes(1)
    expect(parse(result).idea_link.outcome).toBe('set')
  })
})
