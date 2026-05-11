import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    sprint: {
      findMany: vi.fn(),
      create: vi.fn(),
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
import { requireWriteAccess } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { handleCreateSprint } from '../src/tools/create-sprint.js'

const mockPrisma = prisma as unknown as {
  sprint: {
    findMany: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
  }
}
const mockRequireWriteAccess = requireWriteAccess as ReturnType<typeof vi.fn>
const mockUserCanAccessProduct = userCanAccessProduct as ReturnType<typeof vi.fn>

const PRODUCT_ID = 'prod-1'
const USER_ID = 'user-1'

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireWriteAccess.mockResolvedValue({ userId: USER_ID, tokenId: 'tok-1', username: 'alice', isDemo: false })
  mockUserCanAccessProduct.mockResolvedValue(true)
  mockPrisma.sprint.findMany.mockResolvedValue([])
})

function parseResult(result: Awaited<ReturnType<typeof handleCreateSprint>>) {
  const text = result.content?.[0]?.type === 'text' ? result.content[0].text : ''
  try { return JSON.parse(text) } catch { return text }
}

describe('handleCreateSprint', () => {
  it('happy path: creates sprint with auto-generated code', async () => {
    mockPrisma.sprint.create.mockResolvedValue({
      id: 'spr-1',
      code: 'S-2026-05-11-1',
      sprint_goal: 'My goal',
      status: 'OPEN',
      start_date: new Date('2026-05-11'),
      created_at: new Date('2026-05-11T10:00:00Z'),
    })

    const result = await handleCreateSprint({
      product_id: PRODUCT_ID,
      sprint_goal: 'My goal',
    })

    expect(mockPrisma.sprint.create).toHaveBeenCalledTimes(1)
    const callArgs = mockPrisma.sprint.create.mock.calls[0][0]
    expect(callArgs.data.product_id).toBe(PRODUCT_ID)
    expect(callArgs.data.status).toBe('OPEN')
    expect(callArgs.data.sprint_goal).toBe('My goal')
    expect(callArgs.data.code).toMatch(/^S-\d{4}-\d{2}-\d{2}-1$/)
    expect(callArgs.data.start_date).toBeInstanceOf(Date)

    const parsed = parseResult(result)
    expect(parsed.id).toBe('spr-1')
    expect(parsed.status).toBe('OPEN')
  })

  it('uses user-provided code when given', async () => {
    mockPrisma.sprint.create.mockResolvedValue({
      id: 'spr-2',
      code: 'CUSTOM-CODE',
      sprint_goal: 'g',
      status: 'OPEN',
      start_date: new Date(),
      created_at: new Date(),
    })

    await handleCreateSprint({
      product_id: PRODUCT_ID,
      code: 'CUSTOM-CODE',
      sprint_goal: 'g',
    })

    expect(mockPrisma.sprint.create).toHaveBeenCalledTimes(1)
    expect(mockPrisma.sprint.findMany).not.toHaveBeenCalled()
    expect(mockPrisma.sprint.create.mock.calls[0][0].data.code).toBe('CUSTOM-CODE')
  })

  it('auto-code increments past existing same-day sprints', async () => {
    mockPrisma.sprint.findMany.mockResolvedValue([
      { code: 'S-2026-05-11-1' },
      { code: 'S-2026-05-11-3' },
      { code: 'S-2026-05-10-7' },
    ])
    mockPrisma.sprint.create.mockResolvedValue({
      id: 'spr-3', code: 'X', sprint_goal: 'g', status: 'OPEN', start_date: new Date(), created_at: new Date(),
    })

    await handleCreateSprint({ product_id: PRODUCT_ID, sprint_goal: 'g' })

    const today = new Date().toISOString().slice(0, 10)
    expect(mockPrisma.sprint.create.mock.calls[0][0].data.code).toBe(`S-${today}-4`)
  })

  it('retries on P2002 unique conflict', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002', clientVersion: 'x', meta: { target: ['product_id', 'code'] },
    })
    mockPrisma.sprint.create
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        id: 'spr-r', code: 'S-2026-05-11-2', sprint_goal: 'g', status: 'OPEN',
        start_date: new Date(), created_at: new Date(),
      })

    const result = await handleCreateSprint({ product_id: PRODUCT_ID, sprint_goal: 'g' })

    expect(mockPrisma.sprint.create).toHaveBeenCalledTimes(2)
    expect(parseResult(result).id).toBe('spr-r')
  })

  it('returns error when user cannot access product', async () => {
    mockUserCanAccessProduct.mockResolvedValue(false)
    const result = await handleCreateSprint({ product_id: PRODUCT_ID, sprint_goal: 'g' })

    expect(mockPrisma.sprint.create).not.toHaveBeenCalled()
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toMatch(/not found or not accessible/)
  })

  it('uses provided start_date when given', async () => {
    mockPrisma.sprint.create.mockResolvedValue({
      id: 'spr-d', code: 'X', sprint_goal: 'g', status: 'OPEN',
      start_date: new Date('2026-01-01'), created_at: new Date(),
    })

    await handleCreateSprint({
      product_id: PRODUCT_ID,
      sprint_goal: 'g',
      start_date: '2026-01-01',
    })

    const callArgs = mockPrisma.sprint.create.mock.calls[0][0]
    expect(callArgs.data.start_date.toISOString().slice(0, 10)).toBe('2026-01-01')
  })
})
