import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    sprint: {
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
import { requireWriteAccess } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { handleUpdateSprint } from '../src/tools/update-sprint.js'

const mockPrisma = prisma as unknown as {
  sprint: {
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}
const mockRequireWriteAccess = requireWriteAccess as ReturnType<typeof vi.fn>
const mockUserCanAccessProduct = userCanAccessProduct as ReturnType<typeof vi.fn>

const SPRINT_ID = 'spr-1'
const PRODUCT_ID = 'prod-1'
const USER_ID = 'user-1'

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireWriteAccess.mockResolvedValue({ userId: USER_ID, tokenId: 'tok-1', username: 'alice', isDemo: false })
  mockUserCanAccessProduct.mockResolvedValue(true)
  mockPrisma.sprint.findUnique.mockResolvedValue({ id: SPRINT_ID, product_id: PRODUCT_ID })
  mockPrisma.sprint.update.mockResolvedValue({
    id: SPRINT_ID,
    code: 'S-2026-05-11-1',
    sprint_goal: 'g',
    status: 'OPEN',
    start_date: new Date('2026-05-11'),
    end_date: null,
    completed_at: null,
  })
})

function getText(result: Awaited<ReturnType<typeof handleUpdateSprint>>) {
  return result.content?.[0]?.type === 'text' ? result.content[0].text : ''
}

describe('handleUpdateSprint', () => {
  it('returns error when no fields provided', async () => {
    const result = await handleUpdateSprint({ sprint_id: SPRINT_ID })

    expect(mockPrisma.sprint.update).not.toHaveBeenCalled()
    expect(getText(result)).toMatch(/Minstens één veld vereist/)
  })

  it('updates status only', async () => {
    await handleUpdateSprint({ sprint_id: SPRINT_ID, status: 'OPEN' })

    expect(mockPrisma.sprint.update).toHaveBeenCalledTimes(1)
    const args = mockPrisma.sprint.update.mock.calls[0][0]
    expect(args.where).toEqual({ id: SPRINT_ID })
    expect(args.data).toEqual({ status: 'OPEN' })
  })

  it('auto-sets end_date AND completed_at when status → CLOSED without explicit end_date', async () => {
    const before = Date.now()
    await handleUpdateSprint({ sprint_id: SPRINT_ID, status: 'CLOSED' })
    const after = Date.now()

    const args = mockPrisma.sprint.update.mock.calls[0][0]
    expect(args.data.status).toBe('CLOSED')
    expect(args.data.end_date).toBeInstanceOf(Date)
    expect(args.data.end_date.getTime()).toBeGreaterThanOrEqual(before)
    expect(args.data.end_date.getTime()).toBeLessThanOrEqual(after)
    expect(args.data.completed_at).toBeInstanceOf(Date)
    expect(args.data.completed_at.getTime()).toBeGreaterThanOrEqual(before)
    expect(args.data.completed_at.getTime()).toBeLessThanOrEqual(after)
  })

  it('auto-sets end_date when status → FAILED, but does NOT set completed_at', async () => {
    await handleUpdateSprint({ sprint_id: SPRINT_ID, status: 'FAILED' })

    const args = mockPrisma.sprint.update.mock.calls[0][0]
    expect(args.data.end_date).toBeInstanceOf(Date)
    expect(args.data.completed_at).toBeUndefined()
  })

  it('auto-sets end_date when status → ARCHIVED, but does NOT set completed_at', async () => {
    await handleUpdateSprint({ sprint_id: SPRINT_ID, status: 'ARCHIVED' })

    const args = mockPrisma.sprint.update.mock.calls[0][0]
    expect(args.data.end_date).toBeInstanceOf(Date)
    expect(args.data.completed_at).toBeUndefined()
  })

  it('still sets completed_at when status → CLOSED even with explicit end_date', async () => {
    await handleUpdateSprint({
      sprint_id: SPRINT_ID,
      status: 'CLOSED',
      end_date: '2025-12-31',
    })

    const args = mockPrisma.sprint.update.mock.calls[0][0]
    expect(args.data.end_date.toISOString().slice(0, 10)).toBe('2025-12-31')
    expect(args.data.completed_at).toBeInstanceOf(Date)
  })

  it('does NOT auto-set end_date or completed_at when status → OPEN', async () => {
    await handleUpdateSprint({ sprint_id: SPRINT_ID, status: 'OPEN' })

    const args = mockPrisma.sprint.update.mock.calls[0][0]
    expect(args.data.end_date).toBeUndefined()
    expect(args.data.completed_at).toBeUndefined()
  })

  it('updates multiple fields at once', async () => {
    await handleUpdateSprint({
      sprint_id: SPRINT_ID,
      sprint_goal: 'New goal',
      start_date: '2026-05-15',
    })

    const args = mockPrisma.sprint.update.mock.calls[0][0]
    expect(args.data.sprint_goal).toBe('New goal')
    expect(args.data.start_date.toISOString().slice(0, 10)).toBe('2026-05-15')
    expect(args.data.status).toBeUndefined()
    expect(args.data.end_date).toBeUndefined()
  })

  it('returns error when sprint not found', async () => {
    mockPrisma.sprint.findUnique.mockResolvedValue(null)

    const result = await handleUpdateSprint({ sprint_id: SPRINT_ID, status: 'CLOSED' })

    expect(mockPrisma.sprint.update).not.toHaveBeenCalled()
    expect(getText(result)).toMatch(/not found/)
  })

  it('returns error when user cannot access sprint product', async () => {
    mockUserCanAccessProduct.mockResolvedValue(false)

    const result = await handleUpdateSprint({ sprint_id: SPRINT_ID, status: 'CLOSED' })

    expect(mockPrisma.sprint.update).not.toHaveBeenCalled()
    expect(getText(result)).toMatch(/not accessible/)
  })

  it('allows any status transition (no state-machine)', async () => {
    await handleUpdateSprint({ sprint_id: SPRINT_ID, status: 'OPEN' })
    expect(mockPrisma.sprint.update).toHaveBeenCalledTimes(1)

    await handleUpdateSprint({ sprint_id: SPRINT_ID, status: 'CLOSED' })
    expect(mockPrisma.sprint.update).toHaveBeenCalledTimes(2)

    await handleUpdateSprint({ sprint_id: SPRINT_ID, status: 'OPEN' })
    expect(mockPrisma.sprint.update).toHaveBeenCalledTimes(3)
  })
})
