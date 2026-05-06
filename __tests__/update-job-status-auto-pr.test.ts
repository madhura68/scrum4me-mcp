import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    product: { findUnique: vi.fn() },
    task: { findUnique: vi.fn() },
    claudeJob: { findFirst: vi.fn(), findUnique: vi.fn() },
  },
}))

vi.mock('../src/git/pr.js', () => ({
  createPullRequest: vi.fn(),
  markPullRequestReady: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { createPullRequest } from '../src/git/pr.js'
import { maybeCreateAutoPr } from '../src/tools/update-job-status.js'

const mockPrisma = prisma as unknown as {
  product: { findUnique: ReturnType<typeof vi.fn> }
  task: { findUnique: ReturnType<typeof vi.fn> }
  claudeJob: {
    findFirst: ReturnType<typeof vi.fn>
    findUnique: ReturnType<typeof vi.fn>
  }
}
const mockCreatePr = createPullRequest as ReturnType<typeof vi.fn>

const BASE_OPTS = {
  jobId: 'job-abc',
  productId: 'prod-1',
  taskId: 'task-1',
  worktreePath: '/wt/job-abc',
  branchName: 'feat/job-abc',
  summary: 'Implemented the feature',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.product.findUnique.mockResolvedValue({ auto_pr: true })
  mockPrisma.task.findUnique.mockResolvedValue({
    title: 'Add feature',
    story: { id: 'story-1', code: 'SCRUM-42', title: 'Story title' },
  })
  mockPrisma.claudeJob.findFirst.mockResolvedValue(null) // no sibling PR by default
  // Default: legacy job zonder sprint_run (STORY-mode pad).
  mockPrisma.claudeJob.findUnique.mockResolvedValue({ sprint_run_id: null, sprint_run: null })
  mockCreatePr.mockResolvedValue({ url: 'https://github.com/org/repo/pull/99' })
})

describe('maybeCreateAutoPr', () => {
  it('returns PR URL when auto_pr=true and gh succeeds (story-scoped title)', async () => {
    const url = await maybeCreateAutoPr(BASE_OPTS)
    expect(url).toBe('https://github.com/org/repo/pull/99')
    expect(mockCreatePr).toHaveBeenCalledWith({
      worktreePath: BASE_OPTS.worktreePath,
      branchName: BASE_OPTS.branchName,
      title: 'SCRUM-42: Story title',
      body: expect.stringContaining(BASE_OPTS.summary),
    })
  })

  it('reuses sibling pr_url when another job in same story already opened a PR', async () => {
    mockPrisma.claudeJob.findFirst.mockResolvedValue({ pr_url: 'https://github.com/org/repo/pull/77' })
    const url = await maybeCreateAutoPr(BASE_OPTS)
    expect(url).toBe('https://github.com/org/repo/pull/77')
    expect(mockCreatePr).not.toHaveBeenCalled()
  })

  it('returns null when auto_pr=false', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ auto_pr: false })
    const url = await maybeCreateAutoPr(BASE_OPTS)
    expect(url).toBeNull()
    expect(mockCreatePr).not.toHaveBeenCalled()
  })

  it('uses story title without code prefix when story has no code', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      title: 'Add feature',
      story: { id: 'story-1', code: null, title: 'Story title' },
    })
    await maybeCreateAutoPr(BASE_OPTS)
    expect(mockCreatePr).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Story title' }),
    )
  })

  it('SPRINT-mode: maakt een draft-PR aan met sprint-titel, geen auto-merge', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      sprint_run_id: 'run-1',
      sprint_run: {
        id: 'run-1',
        pr_strategy: 'SPRINT',
        sprint: { sprint_goal: 'Cascade-flow live' },
      },
    })

    const url = await maybeCreateAutoPr(BASE_OPTS)

    expect(url).toBe('https://github.com/org/repo/pull/99')
    expect(mockCreatePr).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Sprint: Cascade-flow live',
        draft: true,
        enableAutoMerge: false,
      }),
    )
  })

  it('SPRINT-mode: hergebruikt sibling-PR binnen dezelfde SprintRun', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      sprint_run_id: 'run-1',
      sprint_run: { id: 'run-1', pr_strategy: 'SPRINT', sprint: { sprint_goal: 'Goal' } },
    })
    mockPrisma.claudeJob.findFirst.mockResolvedValue({ pr_url: 'https://github.com/org/repo/pull/55' })

    const url = await maybeCreateAutoPr(BASE_OPTS)

    expect(url).toBe('https://github.com/org/repo/pull/55')
    expect(mockCreatePr).not.toHaveBeenCalled()
  })

  it('returns null and does not throw when gh fails', async () => {
    mockCreatePr.mockResolvedValue({ error: 'gh CLI not found' })
    const url = await maybeCreateAutoPr(BASE_OPTS)
    expect(url).toBeNull()
  })

  it('returns null when product not found', async () => {
    mockPrisma.product.findUnique.mockResolvedValue(null)
    const url = await maybeCreateAutoPr(BASE_OPTS)
    expect(url).toBeNull()
    expect(mockCreatePr).not.toHaveBeenCalled()
  })
})
