import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn().mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' }),
}))
vi.mock('../src/access.js', () => ({
  userCanAccessProduct: vi.fn().mockResolvedValue(true),
}))
vi.mock('../src/prisma.js', () => ({
  prisma: {
    story: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    task: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}))

import { prisma } from '../src/prisma.js'
import { handleCreateTask } from '../src/tools/create-task.js'

const mockPrisma = prisma as unknown as {
  story: {
    findUnique: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
  task: {
    findMany: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
  }
  $transaction: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma))
  mockPrisma.task.findMany.mockResolvedValue([])
  mockPrisma.task.findFirst.mockResolvedValue(null)
  mockPrisma.task.create.mockResolvedValue({
    id: 'task-1',
    code: 'T-1',
    title: 'Task',
    status: 'TO_DO',
    repo_url: null,
    created_at: new Date('2026-06-13T00:00:00Z'),
  })
})

describe('handleCreateTask default assignee', () => {
  it('claimt een ongeclaimde sprint-story voor de token-user', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({
      product_id: 'prod-1',
      sprint_id: 'sprint-1',
      assignee_id: null,
    })

    await handleCreateTask({
      story_id: 'story-1',
      title: 'Task',
      priority: 2,
    })

    expect(mockPrisma.story.updateMany).toHaveBeenCalledWith({
      where: { id: 'story-1', assignee_id: null },
      data: { assignee_id: 'user-1' },
    })
  })

  it('overschrijft geen bestaande assignee', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({
      product_id: 'prod-1',
      sprint_id: 'sprint-1',
      assignee_id: 'user-2',
    })

    await handleCreateTask({
      story_id: 'story-1',
      title: 'Task',
      priority: 2,
    })

    expect(mockPrisma.story.updateMany).not.toHaveBeenCalled()
  })

  it('claimt geen backlog-story zonder sprint', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({
      product_id: 'prod-1',
      sprint_id: null,
      assignee_id: null,
    })

    await handleCreateTask({
      story_id: 'story-1',
      title: 'Task',
      priority: 2,
    })

    expect(mockPrisma.story.updateMany).not.toHaveBeenCalled()
  })
})
