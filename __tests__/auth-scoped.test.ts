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

const HOUR_MS = 60 * 60 * 1000
const past = () => new Date(Date.now() - HOUR_MS)
const future = () => new Date(Date.now() + HOUR_MS)

describe('getAuth — vervaldatum (ISS-9)', () => {
  it('weigert een verlopen token met dezelfde melding als een ingetrokken token', async () => {
    mockFindUnique.mockResolvedValue({ ...baseToken, revoked_at: new Date() })
    const revoked = await getAuth().catch((e: Error) => e.message)
    mockFindUnique.mockResolvedValue({ ...baseToken, expires_at: past() })
    const expired = await getAuth().catch((e: Error) => e.message)
    expect(expired).toBe('SCRUM4ME_TOKEN is invalid or revoked')
    expect(expired).toBe(revoked)
  })

  it('accepteert een token zonder vervaldatum', async () => {
    mockFindUnique.mockResolvedValue({ ...baseToken, expires_at: null })
    await expect(getAuth()).resolves.toMatchObject({ tokenId: 'tok-1' })
  })

  it('accepteert een token met een vervaldatum in de toekomst', async () => {
    mockFindUnique.mockResolvedValue({ ...baseToken, expires_at: future() })
    await expect(getAuth()).resolves.toMatchObject({ tokenId: 'tok-1' })
  })
})

describe('getTokenScopedProducts', () => {
  it('geeft de scope van het huidige request-token', async () => {
    mockFindUnique.mockResolvedValue(baseToken)
    await expect(getTokenScopedProducts()).resolves.toEqual(['prod-1'])
  })

  it('geeft [] bij een verlopen token (ISS-9)', async () => {
    mockFindUnique.mockResolvedValue({ ...baseToken, expires_at: past() })
    await expect(getTokenScopedProducts()).resolves.toEqual([])
  })

  it('geeft de scope bij geen of een toekomstige vervaldatum', async () => {
    mockFindUnique.mockResolvedValue({ ...baseToken, expires_at: null })
    await expect(getTokenScopedProducts()).resolves.toEqual(['prod-1'])
    mockFindUnique.mockResolvedValue({ ...baseToken, expires_at: future() })
    await expect(getTokenScopedProducts()).resolves.toEqual(['prod-1'])
  })

  it('vraagt expires_at op in de select', async () => {
    mockFindUnique.mockResolvedValue(baseToken)
    await getTokenScopedProducts()
    expect(mockFindUnique.mock.calls[0][0].select).toMatchObject({ expires_at: true })
  })

  it('geeft [] zonder token of bij onbekend/ingetrokken token', async () => {
    mockGetToken.mockReturnValue(undefined)
    await expect(getTokenScopedProducts()).resolves.toEqual([])
    mockGetToken.mockReturnValue('raw-token')
    mockFindUnique.mockResolvedValue(null)
    await expect(getTokenScopedProducts()).resolves.toEqual([])
  })
})
