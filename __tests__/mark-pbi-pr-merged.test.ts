import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    pbi: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
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

vi.mock('../src/access.js', () => ({
  userCanAccessProduct: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess, PermissionDeniedError } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { handleMarkPbiPrMerged } from '../src/tools/mark-pbi-pr-merged.js'

const mockPrisma = prisma as unknown as {
  pbi: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
}
const mockRequireWriteAccess = requireWriteAccess as ReturnType<typeof vi.fn>
const mockUserCanAccessProduct = userCanAccessProduct as ReturnType<typeof vi.fn>

const PBI_ID = 'pbi-abc123'
const PR_URL = 'https://github.com/owner/repo/pull/42'
const MERGED_AT = new Date('2026-05-03T12:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireWriteAccess.mockResolvedValue({ userId: 'user-1', tokenId: 'tok-1', username: 'alice', isDemo: false })
  mockPrisma.pbi.findUnique.mockResolvedValue({ product_id: 'prod-1', pr_url: PR_URL })
  mockUserCanAccessProduct.mockResolvedValue(true)
  mockPrisma.pbi.update.mockResolvedValue({ id: PBI_ID, pr_url: PR_URL, pr_merged_at: MERGED_AT })
})

describe('handleMarkPbiPrMerged', () => {
  it('happy path: sets pr_merged_at and returns ok', async () => {
    const result = await handleMarkPbiPrMerged({ pbi_id: PBI_ID })

    expect(result.isError).toBeFalsy()
    expect(mockPrisma.pbi.update).toHaveBeenCalledWith({
      where: { id: PBI_ID },
      data: { pr_merged_at: expect.any(Date) },
      select: { id: true, pr_url: true, pr_merged_at: true },
    })
    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    const parsed = JSON.parse(text)
    expect(parsed.ok).toBe(true)
    expect(parsed.pbi_id).toBe(PBI_ID)
    expect(parsed.pr_url).toBe(PR_URL)
  })

  it('returns error when PBI has no pr_url', async () => {
    mockPrisma.pbi.findUnique.mockResolvedValue({ product_id: 'prod-1', pr_url: null })

    const result = await handleMarkPbiPrMerged({ pbi_id: PBI_ID })

    expect(result.isError).toBe(true)
    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toMatch(/geen gekoppelde PR/)
    expect(mockPrisma.pbi.update).not.toHaveBeenCalled()
  })

  it('idempotent: re-calling overwrites pr_merged_at timestamp', async () => {
    await handleMarkPbiPrMerged({ pbi_id: PBI_ID })
    await handleMarkPbiPrMerged({ pbi_id: PBI_ID })

    expect(mockPrisma.pbi.update).toHaveBeenCalledTimes(2)
    expect(mockPrisma.pbi.update.mock.calls[0][0].data.pr_merged_at).toBeInstanceOf(Date)
    expect(mockPrisma.pbi.update.mock.calls[1][0].data.pr_merged_at).toBeInstanceOf(Date)
  })

  it('returns error when user has no access', async () => {
    mockUserCanAccessProduct.mockResolvedValue(false)

    const result = await handleMarkPbiPrMerged({ pbi_id: PBI_ID })

    expect(result.isError).toBe(true)
    expect(mockPrisma.pbi.update).not.toHaveBeenCalled()
  })

  it('returns error when PBI not found', async () => {
    mockPrisma.pbi.findUnique.mockResolvedValue(null)

    const result = await handleMarkPbiPrMerged({ pbi_id: PBI_ID })

    expect(result.isError).toBe(true)
    expect(mockPrisma.pbi.update).not.toHaveBeenCalled()
  })

  it('returns PERMISSION_DENIED for demo accounts', async () => {
    mockRequireWriteAccess.mockRejectedValue(new PermissionDeniedError())

    const result = await handleMarkPbiPrMerged({ pbi_id: PBI_ID })

    expect(result.isError).toBe(true)
    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toMatch(/PERMISSION_DENIED/)
  })
})
