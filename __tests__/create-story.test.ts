import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    pbi: { findUnique: vi.fn() },
    sprint: { findUnique: vi.fn() },
    story: {
      findFirst: vi.fn(),
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
import { handleCreateStory } from '../src/tools/create-story.js'

const mockPrisma = prisma as unknown as {
  pbi: { findUnique: ReturnType<typeof vi.fn> }
  sprint: { findUnique: ReturnType<typeof vi.fn> }
  story: {
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
  }
}
const mockRequireWriteAccess = requireWriteAccess as ReturnType<typeof vi.fn>
const mockUserCanAccessProduct = userCanAccessProduct as ReturnType<typeof vi.fn>

const PRODUCT_ID = 'prod-1'
const PBI_ID = 'pbi-1'
const SPRINT_ID = 'spr-1'
const USER_ID = 'user-1'

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireWriteAccess.mockResolvedValue({ userId: USER_ID, tokenId: 'tok-1', username: 'alice', isDemo: false })
  mockUserCanAccessProduct.mockResolvedValue(true)
  mockPrisma.pbi.findUnique.mockResolvedValue({ product_id: PRODUCT_ID })
  mockPrisma.story.findMany.mockResolvedValue([])
  mockPrisma.story.findFirst.mockResolvedValue(null)
  mockPrisma.story.create.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'story-1', created_at: new Date('2026-05-14T10:00:00Z'), ...args.data }),
  )
})

function parseResult(result: Awaited<ReturnType<typeof handleCreateStory>>) {
  const text = result.content?.[0]?.type === 'text' ? result.content[0].text : ''
  try { return JSON.parse(text) } catch { return text }
}

function errorText(result: Awaited<ReturnType<typeof handleCreateStory>>): string {
  return result.content?.[0]?.type === 'text' ? result.content[0].text : ''
}

describe('handleCreateStory', () => {
  it('without sprint_id: creates story with status OPEN and no sprint', async () => {
    const result = await handleCreateStory({ pbi_id: PBI_ID, title: 'A story', priority: 2 })

    expect(mockPrisma.sprint.findUnique).not.toHaveBeenCalled()
    const data = mockPrisma.story.create.mock.calls[0][0].data
    expect(data.status).toBe('OPEN')
    expect(data.sprint_id).toBeNull()
    expect(data.product_id).toBe(PRODUCT_ID)
    expect(parseResult(result).status).toBe('OPEN')
  })

  it('with valid sprint_id: links story to sprint with status IN_SPRINT', async () => {
    mockPrisma.sprint.findUnique.mockResolvedValue({ product_id: PRODUCT_ID })

    const result = await handleCreateStory({
      pbi_id: PBI_ID,
      title: 'A story',
      priority: 2,
      sprint_id: SPRINT_ID,
    })

    expect(mockPrisma.sprint.findUnique).toHaveBeenCalledWith({
      where: { id: SPRINT_ID },
      select: { product_id: true },
    })
    const data = mockPrisma.story.create.mock.calls[0][0].data
    expect(data.status).toBe('IN_SPRINT')
    expect(data.sprint_id).toBe(SPRINT_ID)
    expect(parseResult(result).sprint_id).toBe(SPRINT_ID)
  })

  it('rejects a non-existent sprint_id', async () => {
    mockPrisma.sprint.findUnique.mockResolvedValue(null)

    const result = await handleCreateStory({
      pbi_id: PBI_ID,
      title: 'A story',
      priority: 2,
      sprint_id: 'missing',
    })

    expect(mockPrisma.story.create).not.toHaveBeenCalled()
    expect(errorText(result)).toMatch(/Sprint missing not found/)
  })

  it('rejects a sprint from a different product', async () => {
    mockPrisma.sprint.findUnique.mockResolvedValue({ product_id: 'other-product' })

    const result = await handleCreateStory({
      pbi_id: PBI_ID,
      title: 'A story',
      priority: 2,
      sprint_id: SPRINT_ID,
    })

    expect(mockPrisma.story.create).not.toHaveBeenCalled()
    expect(errorText(result)).toMatch(/different product/)
  })

  it('returns error when PBI not found', async () => {
    mockPrisma.pbi.findUnique.mockResolvedValue(null)

    const result = await handleCreateStory({ pbi_id: 'missing', title: 'A story', priority: 2 })

    expect(mockPrisma.sprint.findUnique).not.toHaveBeenCalled()
    expect(mockPrisma.story.create).not.toHaveBeenCalled()
    expect(errorText(result)).toMatch(/PBI missing not found/)
  })
})
