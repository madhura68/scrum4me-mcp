// __tests__/auth-scoped.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { apiToken: { findUnique: vi.fn() } },
}))
vi.mock('../src/request-context.js', () => ({
  getRequestToken: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { getRequestToken } from '../src/request-context.js'
import { getAuth, getTokenScopedProducts } from '../src/auth.js'

const mockFindUnique = prisma.apiToken.findUnique as ReturnType<typeof vi.fn>
const mockGetToken = getRequestToken as ReturnType<typeof vi.fn>

const baseToken = {
  id: 'tok-1',
  user_id: 'user-1',
  revoked_at: null,
  kind: 'COPILOT',
  scoped_products: ['prod-1'],
  user: { username: 'jp', is_demo: false },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetToken.mockReturnValue('raw-token')
})

describe('getAuth — COPILOT-scoping', () => {
  it('geeft kind en scopedProducts terug', async () => {
    mockFindUnique.mockResolvedValue(baseToken)
    const auth = await getAuth()
    expect(auth.kind).toBe('COPILOT')
    expect(auth.scopedProducts).toEqual(['prod-1'])
  })

  it('weigert een COPILOT-token met lege scoped_products (K11)', async () => {
    mockFindUnique.mockResolvedValue({ ...baseToken, scoped_products: [] })
    await expect(getAuth()).rejects.toThrow(/COPILOT token has empty scoped_products/)
  })

  it('laat andere kinds met lege scope ongemoeid', async () => {
    mockFindUnique.mockResolvedValue({ ...baseToken, kind: 'IMPLEMENTATION', scoped_products: [] })
    await expect(getAuth()).resolves.toMatchObject({ userId: 'user-1' })
  })
})

describe('getTokenScopedProducts', () => {
  it('geeft de scope van het huidige request-token', async () => {
    mockFindUnique.mockResolvedValue(baseToken)
    await expect(getTokenScopedProducts()).resolves.toEqual(['prod-1'])
  })

  it('geeft [] zonder token of bij onbekend/ingetrokken token', async () => {
    mockGetToken.mockReturnValue(undefined)
    await expect(getTokenScopedProducts()).resolves.toEqual([])
    mockGetToken.mockReturnValue('raw-token')
    mockFindUnique.mockResolvedValue(null)
    await expect(getTokenScopedProducts()).resolves.toEqual([])
  })
})
