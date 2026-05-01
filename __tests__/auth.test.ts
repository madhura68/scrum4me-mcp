import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    apiToken: {
      findUnique: vi.fn(),
    },
  },
}))

import { prisma } from '../src/prisma.js'
import { getAuth, resetAuthCache } from '../src/auth.js'

const mockPrisma = prisma as unknown as {
  apiToken: { findUnique: ReturnType<typeof vi.fn> }
}

const VALID_TOKEN_ROW = {
  id: 'token-id-1',
  user_id: 'user-1',
  token_hash: 'irrelevant-checked-by-crypto',
  revoked_at: null,
  user: { username: 'alice', is_demo: false },
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAuthCache()
  process.env.SCRUM4ME_TOKEN = 'test-token-value'
})

describe('getAuth', () => {
  it('returns AuthContext for a valid token', async () => {
    mockPrisma.apiToken.findUnique.mockResolvedValue(VALID_TOKEN_ROW)

    const auth = await getAuth()

    expect(auth.tokenId).toBe('token-id-1')
    expect(auth.userId).toBe('user-1')
    expect(auth.username).toBe('alice')
    expect(auth.isDemo).toBe(false)
  })

  it('caches the result — prisma is only called once on repeated calls', async () => {
    mockPrisma.apiToken.findUnique.mockResolvedValue(VALID_TOKEN_ROW)

    await getAuth()
    await getAuth()

    expect(mockPrisma.apiToken.findUnique).toHaveBeenCalledTimes(1)
  })

  it('throws when SCRUM4ME_TOKEN is not set', async () => {
    delete process.env.SCRUM4ME_TOKEN

    await expect(getAuth()).rejects.toThrow('SCRUM4ME_TOKEN is not set')
  })

  it('throws when token is not found in the database', async () => {
    mockPrisma.apiToken.findUnique.mockResolvedValue(null)

    await expect(getAuth()).rejects.toThrow('invalid or revoked')
  })

  it('throws when token is revoked', async () => {
    mockPrisma.apiToken.findUnique.mockResolvedValue({
      ...VALID_TOKEN_ROW,
      revoked_at: new Date(),
    })

    await expect(getAuth()).rejects.toThrow('invalid or revoked')
  })
})
