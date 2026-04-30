import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    task: {
      update: vi.fn(),
      findMany: vi.fn(),
    },
    story: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))

import { prisma } from '../src/prisma.js'
import { updateTaskStatusWithStoryPromotion } from '../src/lib/tasks-status-update.js'

const mockPrisma = prisma as unknown as {
  task: { update: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }
  story: { findUniqueOrThrow: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  $transaction: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$transaction.mockImplementation(
    async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma),
  )
})

const TASK_BASE = {
  id: 'task-1',
  title: 'Task',
  story_id: 'story-1',
  implementation_plan: null,
}

describe('updateTaskStatusWithStoryPromotion', () => {
  it('promotes story to DONE when last sibling task transitions to DONE', async () => {
    mockPrisma.task.update.mockResolvedValue({ ...TASK_BASE, status: 'DONE' })
    mockPrisma.task.findMany.mockResolvedValue([{ status: 'DONE' }, { status: 'DONE' }])
    mockPrisma.story.findUniqueOrThrow.mockResolvedValue({ status: 'IN_SPRINT' })

    const result = await updateTaskStatusWithStoryPromotion('task-1', 'DONE')

    expect(result.storyStatusChange).toBe('promoted')
    expect(result.storyId).toBe('story-1')
    expect(mockPrisma.story.update).toHaveBeenCalledWith({
      where: { id: 'story-1' },
      data: { status: 'DONE' },
    })
  })

  it('does not promote when story is already DONE (idempotent)', async () => {
    mockPrisma.task.update.mockResolvedValue({ ...TASK_BASE, status: 'DONE' })
    mockPrisma.task.findMany.mockResolvedValue([{ status: 'DONE' }])
    mockPrisma.story.findUniqueOrThrow.mockResolvedValue({ status: 'DONE' })

    const result = await updateTaskStatusWithStoryPromotion('task-1', 'DONE')

    expect(result.storyStatusChange).toBe(null)
    expect(mockPrisma.story.update).not.toHaveBeenCalled()
  })

  it('does not promote when not all siblings are DONE', async () => {
    mockPrisma.task.update.mockResolvedValue({ ...TASK_BASE, status: 'DONE' })
    mockPrisma.task.findMany.mockResolvedValue([{ status: 'DONE' }, { status: 'IN_PROGRESS' }])
    mockPrisma.story.findUniqueOrThrow.mockResolvedValue({ status: 'IN_SPRINT' })

    const result = await updateTaskStatusWithStoryPromotion('task-1', 'DONE')

    expect(result.storyStatusChange).toBe(null)
    expect(mockPrisma.story.update).not.toHaveBeenCalled()
  })

  it('demotes story to IN_SPRINT when a task moves out of DONE on a DONE story', async () => {
    mockPrisma.task.update.mockResolvedValue({ ...TASK_BASE, status: 'IN_PROGRESS' })
    mockPrisma.task.findMany.mockResolvedValue([{ status: 'IN_PROGRESS' }, { status: 'DONE' }])
    mockPrisma.story.findUniqueOrThrow.mockResolvedValue({ status: 'DONE' })

    const result = await updateTaskStatusWithStoryPromotion('task-1', 'IN_PROGRESS')

    expect(result.storyStatusChange).toBe('demoted')
    expect(mockPrisma.story.update).toHaveBeenCalledWith({
      where: { id: 'story-1' },
      data: { status: 'IN_SPRINT' },
    })
  })

  it('does not demote when story is not DONE', async () => {
    mockPrisma.task.update.mockResolvedValue({ ...TASK_BASE, status: 'IN_PROGRESS' })
    mockPrisma.task.findMany.mockResolvedValue([{ status: 'IN_PROGRESS' }])
    mockPrisma.story.findUniqueOrThrow.mockResolvedValue({ status: 'IN_SPRINT' })

    const result = await updateTaskStatusWithStoryPromotion('task-1', 'IN_PROGRESS')

    expect(result.storyStatusChange).toBe(null)
    expect(mockPrisma.story.update).not.toHaveBeenCalled()
  })

  it('updates the task regardless of story-status change', async () => {
    mockPrisma.task.update.mockResolvedValue({ ...TASK_BASE, status: 'IN_PROGRESS' })
    mockPrisma.task.findMany.mockResolvedValue([{ status: 'IN_PROGRESS' }])
    mockPrisma.story.findUniqueOrThrow.mockResolvedValue({ status: 'IN_SPRINT' })

    await updateTaskStatusWithStoryPromotion('task-1', 'IN_PROGRESS')

    expect(mockPrisma.task.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'IN_PROGRESS' },
      select: expect.any(Object),
    })
  })

  it('uses the provided transaction client when passed', async () => {
    const tx = {
      task: { update: vi.fn(), findMany: vi.fn() },
      story: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    }
    tx.task.update.mockResolvedValue({ ...TASK_BASE, status: 'DONE' })
    tx.task.findMany.mockResolvedValue([{ status: 'DONE' }])
    tx.story.findUniqueOrThrow.mockResolvedValue({ status: 'IN_SPRINT' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await updateTaskStatusWithStoryPromotion('task-1', 'DONE', tx as any)

    expect(result.storyStatusChange).toBe('promoted')
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(tx.story.update).toHaveBeenCalledWith({
      where: { id: 'story-1' },
      data: { status: 'DONE' },
    })
  })
})
