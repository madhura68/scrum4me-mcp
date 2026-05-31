import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/prisma.js', () => ({
  prisma: {
    product: { findUnique: vi.fn() },
    productDoc: { findMany: vi.fn() },
  },
}))

import { prisma } from '../../src/prisma.js'
import { buildDocIndex, DOC_INDEX_FOLDER_CAP } from '../../src/lib/doc-index.js'

const P = prisma as unknown as {
  product: { findUnique: ReturnType<typeof vi.fn> }
  productDoc: { findMany: ReturnType<typeof vi.fn> }
}

beforeEach(() => vi.clearAllMocks())

describe('buildDocIndex', () => {
  it('returns null when the product has no enabled folders', async () => {
    P.product.findUnique.mockResolvedValueOnce({ enabled_doc_folders: [] })
    expect(await buildDocIndex('p1')).toBeNull()
    expect(P.productDoc.findMany).not.toHaveBeenCalled()
  })

  it('returns null when the product has no active docs', async () => {
    P.product.findUnique.mockResolvedValueOnce({ enabled_doc_folders: ['PATTERNS'] })
    P.productDoc.findMany.mockResolvedValueOnce([])
    expect(await buildDocIndex('p1')).toBeNull()
  })

  it('groups docs per folder with description, doc_count and api folder name', async () => {
    P.product.findUnique.mockResolvedValueOnce({ enabled_doc_folders: ['PATTERNS', 'ADR'] })
    P.productDoc.findMany.mockResolvedValueOnce([
      { folder: 'ADR', slug: 'use-pg', title: 'Use Postgres' },
      { folder: 'PATTERNS', slug: 'md3', title: 'MD3 tokens' },
      { folder: 'PATTERNS', slug: 'errors', title: 'Error handling' },
    ])
    const idx = await buildDocIndex('p1')
    expect(idx?.product_id).toBe('p1')
    const patterns = idx?.folders.find((f) => f.folder === 'patterns')
    expect(patterns?.doc_count).toBe(2)
    expect(patterns?.docs).toEqual([
      { title: 'MD3 tokens', slug: 'md3' },
      { title: 'Error handling', slug: 'errors' },
    ])
    expect(patterns?.description.length).toBeGreaterThan(10)
    expect(patterns?.truncated).toBe(false)
    expect(idx?.folders.find((f) => f.folder === 'adr')?.doc_count).toBe(1)
    expect(idx?.hint).toMatch(/get_product_doc/)
  })

  it('caps docs per folder and flags truncated', async () => {
    P.product.findUnique.mockResolvedValueOnce({ enabled_doc_folders: ['PATTERNS'] })
    const rows = Array.from({ length: DOC_INDEX_FOLDER_CAP + 1 }, (_, i) => ({
      folder: 'PATTERNS', slug: `s${i}`, title: `T${i}`,
    }))
    P.productDoc.findMany.mockResolvedValueOnce(rows)
    const idx = await buildDocIndex('p1')
    const patterns = idx?.folders.find((f) => f.folder === 'patterns')
    expect(patterns?.doc_count).toBe(DOC_INDEX_FOLDER_CAP + 1)
    expect(patterns?.docs).toHaveLength(DOC_INDEX_FOLDER_CAP)
    expect(patterns?.truncated).toBe(true)
  })

  it('queries only active docs in enabled folders', async () => {
    P.product.findUnique.mockResolvedValueOnce({ enabled_doc_folders: ['PATTERNS'] })
    P.productDoc.findMany.mockResolvedValueOnce([])
    await buildDocIndex('p1')
    const arg = P.productDoc.findMany.mock.calls[0][0]
    expect(arg.where).toMatchObject({ product_id: 'p1', status: 'active' })
    expect(arg.where.folder).toEqual({ in: ['PATTERNS'] })
  })
})
