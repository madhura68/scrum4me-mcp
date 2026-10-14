import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { toolText } from './helpers/tool-result.js'
import type { AnyMock } from './helpers/mocks.js'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    sprint: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    idea: { findFirst: vi.fn(), updateMany: vi.fn() },
    ideaProduct: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}))

// executePpeMutation doorlussen zodat we het request kunnen inspecteren dat
// in de PPE payload_hash terechtkomt, zonder controller-database.
vi.mock('../src/lib/ppe-operation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/ppe-operation.js')>()),
  executePpeMutation: vi.fn((input: { mutate: () => Promise<unknown> }) => input.mutate()),
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
import { executePpeMutation } from '../src/lib/ppe-operation.js'

const mockPrisma = prisma as unknown as {
  sprint: {
    findMany: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
  }
  idea: { findFirst: AnyMock; updateMany: AnyMock }
  ideaProduct: { findUnique: AnyMock }
  $transaction: AnyMock
}
const mockExecutePpeMutation = executePpeMutation as unknown as AnyMock
const mockRequireWriteAccess = requireWriteAccess as ReturnType<typeof vi.fn>
const mockUserCanAccessProduct = userCanAccessProduct as ReturnType<typeof vi.fn>

const PRODUCT_ID = 'prod-1'
const USER_ID = 'user-1'

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireWriteAccess.mockResolvedValue({ userId: USER_ID, tokenId: 'tok-1', username: 'alice', isDemo: false })
  mockUserCanAccessProduct.mockResolvedValue(true)
  mockPrisma.sprint.findMany.mockResolvedValue([])
  mockPrisma.idea.findFirst.mockResolvedValue({ product_id: PRODUCT_ID })
  mockPrisma.idea.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.ideaProduct.findUnique.mockResolvedValue(null)
  mockPrisma.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma))
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
    // Codes moeten relatief aan "vandaag" zijn: generateNextSprintCode telt
    // alleen same-day sprints. Hardcoded datums maakten deze test datum-flaky.
    const today = new Date().toISOString().slice(0, 10)
    mockPrisma.sprint.findMany.mockResolvedValue([
      { code: `S-${today}-1` },
      { code: `S-${today}-3` },
      { code: 'S-2020-01-01-7' },
    ])
    mockPrisma.sprint.create.mockResolvedValue({
      id: 'spr-3', code: 'X', sprint_goal: 'g', status: 'OPEN', start_date: new Date(), created_at: new Date(),
    })

    await handleCreateSprint({ product_id: PRODUCT_ID, sprint_goal: 'g' })

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

  // Shape measured on Prisma 7.8 + @prisma/adapter-pg: P2002 without
  // meta.target, constraint under the driver-adapter cause.
  it('retries on the unique conflict the driver adapter reports without meta.target', async () => {
    const adapterError = new Error('UniqueConstraintViolation')
    adapterError.name = 'DriverAdapterError'
    ;(adapterError as Error & { cause: unknown }).cause = {
      originalCode: '23505',
      originalMessage: 'duplicate key value violates unique constraint "sprints_product_id_code_key"',
      kind: 'UniqueConstraintViolation',
      constraint: { fields: ['product_id', 'code'] },
    }
    const conflict = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002', clientVersion: 'x', meta: { driverAdapterError: adapterError },
    })
    mockPrisma.sprint.create
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        id: 'spr-a', code: 'S-2026-05-11-2', sprint_goal: 'g', status: 'OPEN',
        start_date: new Date(), created_at: new Date(),
      })

    const result = await handleCreateSprint({ product_id: PRODUCT_ID, sprint_goal: 'g' })

    expect(mockPrisma.sprint.create).toHaveBeenCalledTimes(2)
    expect(parseResult(result).id).toBe('spr-a')
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

describe('handleCreateSprint idea_id (ISS-17)', () => {
  const IDEA_ID = 'idea-1'
  const sprintRow = {
    id: 'spr-i', code: 'S-2026-05-11-1', sprint_goal: 'g', status: 'OPEN',
    start_date: new Date(), created_at: new Date(),
  }

  // Driver-adapter-vorm (Prisma 7 + adapter-pg): geen meta.target, constraint onder de cause.
  function p2002() {
    const adapterError = new Error('UniqueConstraintViolation')
    adapterError.name = 'DriverAdapterError'
    ;(adapterError as Error & { cause: unknown }).cause = {
      originalCode: '23505',
      originalMessage: 'duplicate key value violates unique constraint "sprints_product_id_code_key"',
      kind: 'UniqueConstraintViolation',
      constraint: { fields: ['product_id', 'code'] },
    }
    return new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002', clientVersion: 'x', meta: { driverAdapterError: adapterError },
    })
  }

  it('zonder idea_id: geen transactie, geen idee-query, request zonder idea_id-key', async () => {
    mockPrisma.sprint.create.mockResolvedValue(sprintRow)

    const result = await handleCreateSprint({ product_id: PRODUCT_ID, sprint_goal: 'g' })

    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockPrisma.idea.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.idea.updateMany).not.toHaveBeenCalled()
    expect(parseResult(result)).not.toHaveProperty('idea_link')
    const request = mockExecutePpeMutation.mock.calls[0][0].request
    expect(request).toEqual({
      product_id: PRODUCT_ID, code: null, sprint_goal: 'g', start_date: null, ceremony_object_key: null,
    })
    expect('idea_id' in request).toBe(false)
  })

  it('koppelt een lege build_sprint_id in dezelfde transactie (gegenereerde code)', async () => {
    mockPrisma.sprint.create.mockResolvedValue(sprintRow)

    const result = await handleCreateSprint({ product_id: PRODUCT_ID, sprint_goal: 'g', idea_id: IDEA_ID })

    expect(mockPrisma.idea.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: IDEA_ID, user_id: USER_ID },
    }))
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mockPrisma.idea.updateMany).toHaveBeenCalledWith({
      where: { id: IDEA_ID, build_sprint_id: null },
      data: { build_sprint_id: 'spr-i' },
    })
    const parsed = parseResult(result)
    expect(parsed.id).toBe('spr-i')
    expect(parsed.idea_link).toEqual({ idea_id: IDEA_ID, field: 'build_sprint_id', outcome: 'set' })
    expect(mockExecutePpeMutation.mock.calls[0][0].request.idea_id).toBe(IDEA_ID)
  })

  it('koppelt ook op het pad met expliciete code', async () => {
    mockPrisma.sprint.create.mockResolvedValue(sprintRow)

    const result = await handleCreateSprint({
      product_id: PRODUCT_ID, code: 'CUSTOM', sprint_goal: 'g', idea_id: IDEA_ID,
    })

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mockPrisma.idea.updateMany).toHaveBeenCalledTimes(1)
    expect(parseResult(result).idea_link.outcome).toBe('set')
  })

  it('overschrijft een gevulde build_sprint_id niet, maar maakt de sprint wel aan', async () => {
    mockPrisma.sprint.create.mockResolvedValue(sprintRow)
    mockPrisma.idea.updateMany.mockResolvedValue({ count: 0 })

    const result = await handleCreateSprint({ product_id: PRODUCT_ID, sprint_goal: 'g', idea_id: IDEA_ID })

    expect(mockPrisma.sprint.create).toHaveBeenCalledTimes(1)
    const parsed = parseResult(result)
    expect(parsed.id).toBe('spr-i')
    expect(parsed.idea_link).toEqual({ idea_id: IDEA_ID, field: 'build_sprint_id', outcome: 'skipped_existing' })
  })

  it('weigert een vreemd of onbekend idee zonder sprint aan te maken', async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(null)

    const result = await handleCreateSprint({ product_id: PRODUCT_ID, sprint_goal: 'g', idea_id: IDEA_ID })

    expect(result.isError).toBe(true)
    expect(toolText(result)).toMatch(/not found or not accessible/)
    expect(mockPrisma.sprint.create).not.toHaveBeenCalled()
    expect(mockExecutePpeMutation).not.toHaveBeenCalled()
  })

  it('weigert een product dat primair noch secundair bij het idee hoort', async () => {
    mockPrisma.idea.findFirst.mockResolvedValue({ product_id: 'other-product' })

    const result = await handleCreateSprint({ product_id: PRODUCT_ID, sprint_goal: 'g', idea_id: IDEA_ID })

    expect(result.isError).toBe(true)
    expect(toolText(result)).toMatch(/does not belong to product/)
    expect(mockPrisma.sprint.create).not.toHaveBeenCalled()
  })

  it('herkent een code-conflict uit de transactie en zet de koppeling één keer', async () => {
    mockPrisma.sprint.create
      .mockRejectedValueOnce(p2002())
      .mockResolvedValueOnce({ ...sprintRow, id: 'spr-r' })

    const result = await handleCreateSprint({ product_id: PRODUCT_ID, sprint_goal: 'g', idea_id: IDEA_ID })

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2)
    expect(mockPrisma.sprint.create).toHaveBeenCalledTimes(2)
    expect(mockPrisma.idea.updateMany).toHaveBeenCalledTimes(1)
    expect(mockPrisma.idea.updateMany).toHaveBeenCalledWith({
      where: { id: IDEA_ID, build_sprint_id: null },
      data: { build_sprint_id: 'spr-r' },
    })
    const parsed = parseResult(result)
    expect(parsed.id).toBe('spr-r')
    expect(parsed.idea_link.outcome).toBe('set')
  })
})
