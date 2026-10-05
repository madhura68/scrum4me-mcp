import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn().mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' }),
}))
vi.mock('../src/access.js', () => ({
  userCanAccessProduct: vi.fn().mockResolvedValue(true),
}))
vi.mock('../src/prisma.js', () => ({
  prisma: {
    story: { findUnique: vi.fn(), updateMany: vi.fn() },
    task: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    taskEstimate: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}))

import { Prisma } from '@prisma/client'
import { prisma } from '../src/prisma.js'
import { handleCreateTask } from '../src/tools/create-task.js'
import { toolText } from './helpers/tool-result.js'

const mockPrisma = prisma as unknown as {
  story: { findUnique: ReturnType<typeof vi.fn> }
  task: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
  taskEstimate: { create: ReturnType<typeof vi.fn> }
  $transaction: ReturnType<typeof vi.fn>
}

const base = { story_id: 'story-1', title: 'Task', priority: 2 }

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma))
  mockPrisma.story.findUnique.mockResolvedValue({ product_id: 'prod-1', sprint_id: null, assignee_id: null })
  mockPrisma.task.findMany.mockResolvedValue([])
  mockPrisma.task.findFirst.mockResolvedValue(null)
  mockPrisma.task.create.mockResolvedValue({ id: 'task-1', code: 'T-1', title: 'Task', status: 'TO_DO' })
  mockPrisma.taskEstimate.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    estimate_active_minutes: data.estimate_active_minutes,
    estimate_usd: new Prisma.Decimal(data.estimate_usd as string),
    estimate_basis: data.estimate_basis,
    estimated_at: new Date('2026-10-05T10:00:00Z'),
  }))
})

// IDEA-235 (spec §5.2, plan Taak 8): an estimate is all three fields or none, stored once.
describe('create_task estimate', () => {
  it('creates no estimate row without the fields', async () => {
    const result = await handleCreateTask(base)
    expect(result.isError).not.toBe(true)
    expect(mockPrisma.taskEstimate.create).not.toHaveBeenCalled()
    expect(JSON.parse(toolText(result))).not.toHaveProperty('estimate')
  })

  it('stores the estimate in the task transaction', async () => {
    const result = await handleCreateTask({
      ...base, estimate_active_minutes: 30, estimate_usd: 2.5, estimate_basis: 'Vergelijkbaar met T6; Opus.',
    })
    expect(result.isError).not.toBe(true)
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mockPrisma.taskEstimate.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { task_id: 'task-1', estimate_active_minutes: 30, estimate_usd: '2.5000', estimate_basis: 'Vergelijkbaar met T6; Opus.' },
    }))
    expect(JSON.parse(toolText(result)).estimate).toMatchObject({ estimate_active_minutes: 30, estimate_usd: '2.5000' })
  })

  it.each([
    [{ estimate_active_minutes: 30 }],
    [{ estimate_usd: 2.5 }],
    [{ estimate_basis: 'basis' }],
    [{ estimate_active_minutes: 30, estimate_usd: 2.5 }],
    [{ estimate_usd: 2.5, estimate_basis: 'basis' }],
    [{ estimate_active_minutes: 30, estimate_basis: 'basis' }],
  ])('rejects a partial estimate %j and creates no task', async (partial) => {
    const result = await handleCreateTask({ ...base, ...partial })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toMatch(/^ESTIMATE_INCOMPLETE/)
    expect(mockPrisma.task.create).not.toHaveBeenCalled()
    expect(mockPrisma.taskEstimate.create).not.toHaveBeenCalled()
  })

  it('rejects an estimate_usd that rounds to zero', async () => {
    const result = await handleCreateTask({ ...base, estimate_active_minutes: 1, estimate_usd: 0.00001, estimate_basis: 'b' })
    expect(toolText(result)).toMatch(/^ESTIMATE_INCOMPLETE/)
    expect(mockPrisma.task.create).not.toHaveBeenCalled()
  })
})

// Frozen by construction: create_task is the only code that writes task_estimates.
describe('task_estimates write paths', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : []
    })

  it('only create-task.ts writes task_estimates', () => {
    const writers = files(new URL('../src', import.meta.url).pathname).filter((path) => {
      const source = readFileSync(path, 'utf8')
      return /taskEstimate\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.test(source) ||
        /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?task_estimates/i.test(source)
    })
    expect(writers.map((path) => path.replace(/.*\/src\//, 'src/'))).toEqual(['src/tools/create-task.ts'])
    const createTask = readFileSync(new URL('../src/tools/create-task.ts', import.meta.url), 'utf8')
    expect(createTask.match(/taskEstimate\.\w+/g)).toEqual(['taskEstimate.create'])
  })
})
