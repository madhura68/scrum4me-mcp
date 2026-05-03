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
import { handleSetPbiPr, inputSchema } from '../src/tools/set-pbi-pr.js'

const mockPrisma = prisma as unknown as {
  pbi: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
}
const mockRequireWriteAccess = requireWriteAccess as ReturnType<typeof vi.fn>
const mockUserCanAccessProduct = userCanAccessProduct as ReturnType<typeof vi.fn>

const VALID_PR_URL = 'https://github.com/owner/repo/pull/42'
const PBI_ID = 'pbi-abc123'
const USER_ID = 'user-1'

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireWriteAccess.mockResolvedValue({ userId: USER_ID, tokenId: 'tok-1', username: 'alice', isDemo: false })
  mockPrisma.pbi.findUnique.mockResolvedValue({ product_id: 'prod-1' })
  mockUserCanAccessProduct.mockResolvedValue(true)
  mockPrisma.pbi.update.mockResolvedValue({})
})

describe('handleSetPbiPr', () => {
  it('happy path: updates pr_url and clears pr_merged_at', async () => {
    const result = await handleSetPbiPr({ pbi_id: PBI_ID, pr_url: VALID_PR_URL })

    expect(result.isError).toBeFalsy()
    expect(mockPrisma.pbi.update).toHaveBeenCalledWith({
      where: { id: PBI_ID },
      data: { pr_url: VALID_PR_URL, pr_merged_at: null },
    })
    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    const parsed = JSON.parse(text)
    expect(parsed).toEqual({ ok: true, pbi_id: PBI_ID, pr_url: VALID_PR_URL })
  })

  it('idempotent: second call with different url overwrites', async () => {
    const newUrl = 'https://github.com/owner/repo/pull/99'
    await handleSetPbiPr({ pbi_id: PBI_ID, pr_url: newUrl })

    expect(mockPrisma.pbi.update).toHaveBeenCalledWith({
      where: { id: PBI_ID },
      data: { pr_url: newUrl, pr_merged_at: null },
    })
  })

  it('returns error when PBI not found', async () => {
    mockPrisma.pbi.findUnique.mockResolvedValue(null)

    const result = await handleSetPbiPr({ pbi_id: PBI_ID, pr_url: VALID_PR_URL })

    expect(result.isError).toBe(true)
    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toMatch(PBI_ID)
    expect(mockPrisma.pbi.update).not.toHaveBeenCalled()
  })

  it('returns error when user has no access to the product', async () => {
    mockUserCanAccessProduct.mockResolvedValue(false)

    const result = await handleSetPbiPr({ pbi_id: PBI_ID, pr_url: VALID_PR_URL })

    expect(result.isError).toBe(true)
    expect(mockPrisma.pbi.update).not.toHaveBeenCalled()
  })

  it('returns PERMISSION_DENIED for demo accounts', async () => {
    mockRequireWriteAccess.mockRejectedValue(new PermissionDeniedError())

    const result = await handleSetPbiPr({ pbi_id: PBI_ID, pr_url: VALID_PR_URL })

    expect(result.isError).toBe(true)
    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toMatch(/PERMISSION_DENIED/)
  })
})

describe('inputSchema validation', () => {
  it('accepts a valid GitHub PR URL', () => {
    const r = inputSchema.safeParse({ pbi_id: PBI_ID, pr_url: VALID_PR_URL })
    expect(r.success).toBe(true)
  })

  it('rejects a URL pointing to an issue instead of a pull', () => {
    const r = inputSchema.safeParse({ pbi_id: PBI_ID, pr_url: 'https://github.com/owner/repo/issues/42' })
    expect(r.success).toBe(false)
  })

  it('rejects a non-GitHub URL', () => {
    const r = inputSchema.safeParse({ pbi_id: PBI_ID, pr_url: 'https://gitlab.com/owner/repo/pull/42' })
    expect(r.success).toBe(false)
  })

  it('rejects a URL without a numeric PR number', () => {
    const r = inputSchema.safeParse({ pbi_id: PBI_ID, pr_url: 'https://github.com/owner/repo/pull/abc' })
    expect(r.success).toBe(false)
  })

  it('rejects an empty pbi_id', () => {
    const r = inputSchema.safeParse({ pbi_id: '', pr_url: VALID_PR_URL })
    expect(r.success).toBe(false)
  })
})
