import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/prisma.js', () => ({
  prisma: {
    pbi: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('../../src/auth.js', () => ({
  requireWriteAccess: vi.fn(),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))

vi.mock('../../src/access.js', () => ({
  userCanAccessProduct: vi.fn(),
}))

import { prisma } from '../../src/prisma.js'
import { requireWriteAccess } from '../../src/auth.js'
import { userCanAccessProduct } from '../../src/access.js'
import { inputSchema, handleSetPbiPr } from '../../src/tools/set-pbi-pr.js'

const mockPrisma = prisma as unknown as {
  pbi: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
}
const mockRequireWriteAccess = requireWriteAccess as ReturnType<typeof vi.fn>
const mockUserCanAccessProduct = userCanAccessProduct as ReturnType<typeof vi.fn>

beforeEach(() => {
  process.env.FORGEJO_HOST = 'git.jp-visser.nl'
  delete process.env.FORGEJO_HOSTS
  vi.clearAllMocks()
  mockRequireWriteAccess.mockResolvedValue({
    userId: 'u1',
    tokenId: 't1',
    username: 'alice',
    isDemo: false,
  })
  mockPrisma.pbi.findUnique.mockResolvedValue({ product_id: 'p1' })
  mockUserCanAccessProduct.mockResolvedValue(true)
  mockPrisma.pbi.update.mockResolvedValue({})
})

// Plan-v4 vereist: GitHub URLs worden bewust geweigerd zodat de hardstop op
// "Forgejo is leidend" in de tool-laag zichtbaar is. Bestaande DB-records
// blijven onveranderd; alleen nieuwe writes worden tegengehouden.
describe('set_pbi_pr — Forgejo-only', () => {
  it('schema weigert github.com /pull/N URL', () => {
    const r = inputSchema.safeParse({
      pbi_id: 'pbi-1',
      pr_url: 'https://github.com/owner/repo/pull/42',
    })
    expect(r.success).toBe(false)
  })

  it('schema accepteert Forgejo /pulls/N URL op geconfigureerde host', () => {
    const r = inputSchema.safeParse({
      pbi_id: 'pbi-1',
      pr_url: 'https://git.jp-visser.nl/owner/repo/pulls/42',
    })
    expect(r.success).toBe(true)
  })

  it('handler updates pr_url voor valid Forgejo URL', async () => {
    const result = await handleSetPbiPr({
      pbi_id: 'pbi-1',
      pr_url: 'https://git.jp-visser.nl/owner/repo/pulls/42',
    })

    expect(result.isError).toBeFalsy()
    expect(mockPrisma.pbi.update).toHaveBeenCalledWith({
      where: { id: 'pbi-1' },
      data: { pr_url: 'https://git.jp-visser.nl/owner/repo/pulls/42', pr_merged_at: null },
    })
  })
})
