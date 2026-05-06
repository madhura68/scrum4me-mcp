import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    task: {
      update: vi.fn(),
      findMany: vi.fn(),
    },
    story: {
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    pbi: {
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    sprint: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    claudeJob: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    sprintRun: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))

import { prisma } from '../src/prisma.js'
import {
  propagateStatusUpwards,
  updateTaskStatusWithStoryPromotion,
} from '../src/lib/tasks-status-update.js'

type MockedPrisma = {
  task: { update: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }
  story: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  pbi: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  sprint: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  claudeJob: {
    findFirst: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
  sprintRun: {
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  $transaction: ReturnType<typeof vi.fn>
}

const mockPrisma = prisma as unknown as MockedPrisma

const TASK_BASE = {
  id: 'task-1',
  title: 'Task',
  story_id: 'story-1',
  implementation_plan: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$transaction.mockImplementation(
    async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma),
  )
})

describe('propagateStatusUpwards — story-niveau', () => {
  it('zet story op DONE wanneer alle siblings DONE zijn', async () => {
    mockPrisma.task.update.mockResolvedValue({ ...TASK_BASE, status: 'DONE' })
    mockPrisma.task.findMany.mockResolvedValue([{ status: 'DONE' }, { status: 'DONE' }])
    mockPrisma.story.findUniqueOrThrow.mockResolvedValue({
      id: 'story-1',
      status: 'IN_SPRINT',
      pbi_id: 'pbi-1',
      sprint_id: null,
    })
    mockPrisma.pbi.findUniqueOrThrow.mockResolvedValue({ id: 'pbi-1', status: 'READY' })
    mockPrisma.story.findMany.mockResolvedValue([{ status: 'DONE' }])

    const result = await propagateStatusUpwards('task-1', 'DONE')

    expect(result.storyChanged).toBe(true)
    expect(mockPrisma.story.update).toHaveBeenCalledWith({
      where: { id: 'story-1' },
      data: { status: 'DONE' },
    })
  })

  it('zet story op FAILED wanneer een task FAILED is, ongeacht andere tasks', async () => {
    mockPrisma.task.update.mockResolvedValue({ ...TASK_BASE, status: 'FAILED' })
    mockPrisma.task.findMany.mockResolvedValue([
      { status: 'FAILED' },
      { status: 'DONE' },
      { status: 'TO_DO' },
    ])
    mockPrisma.story.findUniqueOrThrow.mockResolvedValue({
      id: 'story-1',
      status: 'IN_SPRINT',
      pbi_id: 'pbi-1',
      sprint_id: null,
    })
    mockPrisma.pbi.findUniqueOrThrow.mockResolvedValue({ id: 'pbi-1', status: 'READY' })
    mockPrisma.story.findMany.mockResolvedValue([{ status: 'FAILED' }])

    const result = await propagateStatusUpwards('task-1', 'FAILED')

    expect(result.storyChanged).toBe(true)
    expect(mockPrisma.story.update).toHaveBeenCalledWith({
      where: { id: 'story-1' },
      data: { status: 'FAILED' },
    })
  })
})

describe('propagateStatusUpwards — PBI BLOCKED met rust laten', () => {
  it('overschrijft een handmatig BLOCKED PBI niet', async () => {
    mockPrisma.task.update.mockResolvedValue({ ...TASK_BASE, status: 'DONE' })
    mockPrisma.task.findMany.mockResolvedValue([{ status: 'DONE' }])
    mockPrisma.story.findUniqueOrThrow.mockResolvedValue({
      id: 'story-1',
      status: 'IN_SPRINT',
      pbi_id: 'pbi-1',
      sprint_id: null,
    })
    mockPrisma.pbi.findUniqueOrThrow.mockResolvedValue({ id: 'pbi-1', status: 'BLOCKED' })

    const result = await propagateStatusUpwards('task-1', 'DONE')

    expect(result.pbiChanged).toBe(false)
    expect(mockPrisma.pbi.update).not.toHaveBeenCalled()
  })
})

describe('propagateStatusUpwards — sprint cascade tot SprintRun', () => {
  it('zet bij FAILED de hele keten op FAILED en cancelt sibling-jobs', async () => {
    mockPrisma.task.update.mockResolvedValue({ ...TASK_BASE, status: 'FAILED' })
    mockPrisma.task.findMany.mockResolvedValue([{ status: 'FAILED' }, { status: 'DONE' }])
    mockPrisma.story.findUniqueOrThrow.mockResolvedValue({
      id: 'story-1',
      status: 'IN_SPRINT',
      pbi_id: 'pbi-1',
      sprint_id: 'sprint-1',
    })
    mockPrisma.pbi.findUniqueOrThrow.mockResolvedValue({ id: 'pbi-1', status: 'READY' })
    mockPrisma.story.findMany.mockImplementation(
      async (args: { where?: { pbi_id?: string; sprint_id?: string } }) => {
        if (args.where?.pbi_id) return [{ status: 'FAILED' }]
        if (args.where?.sprint_id) return [{ pbi_id: 'pbi-1' }]
        return []
      },
    )
    mockPrisma.sprint.findUniqueOrThrow.mockResolvedValue({ id: 'sprint-1', status: 'ACTIVE' })
    ;(mockPrisma.pbi as unknown as { findMany: ReturnType<typeof vi.fn> }).findMany = vi
      .fn()
      .mockResolvedValue([{ status: 'FAILED' }])
    mockPrisma.claudeJob.findFirst.mockResolvedValue({ id: 'job-1', sprint_run_id: 'run-1' })
    mockPrisma.sprintRun.findUnique.mockResolvedValue({ id: 'run-1', status: 'RUNNING' })

    const result = await propagateStatusUpwards('task-1', 'FAILED')

    expect(result.sprintChanged).toBe(true)
    expect(result.sprintRunChanged).toBe(true)
    expect(mockPrisma.sprintRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({ status: 'FAILED', failed_task_id: 'task-1' }),
      }),
    )
    expect(mockPrisma.claudeJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sprint_run_id: 'run-1',
          status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] },
          id: { not: 'job-1' },
        }),
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    )
  })
})

describe('updateTaskStatusWithStoryPromotion (BC-wrapper)', () => {
  it('mapt storyChanged + DONE-newStatus naar storyStatusChange="promoted"', async () => {
    mockPrisma.task.update.mockResolvedValue({ ...TASK_BASE, status: 'DONE' })
    mockPrisma.task.findMany.mockResolvedValue([{ status: 'DONE' }])
    mockPrisma.story.findUniqueOrThrow.mockResolvedValue({
      id: 'story-1',
      status: 'IN_SPRINT',
      pbi_id: 'pbi-1',
      sprint_id: null,
    })
    mockPrisma.pbi.findUniqueOrThrow.mockResolvedValue({ id: 'pbi-1', status: 'READY' })
    mockPrisma.story.findMany.mockResolvedValue([{ status: 'DONE' }])

    const result = await updateTaskStatusWithStoryPromotion('task-1', 'DONE')

    expect(result.storyStatusChange).toBe('promoted')
    expect(result.storyId).toBe('story-1')
  })

  it('mapt storyChanged + non-DONE naar storyStatusChange="demoted"', async () => {
    mockPrisma.task.update.mockResolvedValue({ ...TASK_BASE, status: 'IN_PROGRESS' })
    mockPrisma.task.findMany.mockResolvedValue([{ status: 'IN_PROGRESS' }, { status: 'DONE' }])
    mockPrisma.story.findUniqueOrThrow.mockResolvedValue({
      id: 'story-1',
      status: 'DONE',
      pbi_id: 'pbi-1',
      sprint_id: null,
    })
    mockPrisma.pbi.findUniqueOrThrow.mockResolvedValue({ id: 'pbi-1', status: 'DONE' })
    mockPrisma.story.findMany.mockResolvedValue([{ status: 'OPEN' }])

    const result = await updateTaskStatusWithStoryPromotion('task-1', 'IN_PROGRESS')

    expect(result.storyStatusChange).toBe('demoted')
  })

  it('null wanneer story niet verandert', async () => {
    mockPrisma.task.update.mockResolvedValue({ ...TASK_BASE, status: 'IN_PROGRESS' })
    mockPrisma.task.findMany.mockResolvedValue([{ status: 'IN_PROGRESS' }, { status: 'TO_DO' }])
    mockPrisma.story.findUniqueOrThrow.mockResolvedValue({
      id: 'story-1',
      status: 'IN_SPRINT',
      pbi_id: 'pbi-1',
      sprint_id: 'sprint-1',
    })
    mockPrisma.pbi.findUniqueOrThrow.mockResolvedValue({ id: 'pbi-1', status: 'READY' })
    mockPrisma.story.findMany.mockImplementation(
      async (args: { where?: { pbi_id?: string; sprint_id?: string } }) => {
        if (args.where?.pbi_id) return [{ status: 'IN_SPRINT' }]
        if (args.where?.sprint_id) return [{ pbi_id: 'pbi-1' }]
        return []
      },
    )
    mockPrisma.sprint.findUniqueOrThrow.mockResolvedValue({ id: 'sprint-1', status: 'ACTIVE' })
    ;(mockPrisma.pbi as unknown as { findMany: ReturnType<typeof vi.fn> }).findMany = vi
      .fn()
      .mockResolvedValue([{ status: 'READY' }])

    const result = await updateTaskStatusWithStoryPromotion('task-1', 'IN_PROGRESS')

    expect(result.storyStatusChange).toBe(null)
  })
})
