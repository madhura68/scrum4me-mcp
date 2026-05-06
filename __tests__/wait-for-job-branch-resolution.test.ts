import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}))

import { prisma } from '../src/prisma.js'
import { resolveBranchForJob } from '../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  claudeJob: {
    findUnique: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveBranchForJob — sprint-aware', () => {
  it('SPRINT-mode: kiest feat/sprint-<id-suffix> en marks reused=false bij eerste task', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      sprint_run_id: 'run-cuid-12345678',
      sprint_run: { id: 'run-cuid-12345678', pr_strategy: 'SPRINT' },
    })
    mockPrisma.claudeJob.findFirst.mockResolvedValue(null)

    const result = await resolveBranchForJob('job-1', 'story-anything')

    expect(result.branchName).toBe('feat/sprint-12345678')
    expect(result.reused).toBe(false)
  })

  it('SPRINT-mode: marks reused=true wanneer sibling al de branch gebruikt', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      sprint_run_id: 'run-cuid-12345678',
      sprint_run: { id: 'run-cuid-12345678', pr_strategy: 'SPRINT' },
    })
    mockPrisma.claudeJob.findFirst.mockResolvedValue({ branch: 'feat/sprint-12345678' })

    const result = await resolveBranchForJob('job-2', 'story-anything')

    expect(result.branchName).toBe('feat/sprint-12345678')
    expect(result.reused).toBe(true)
  })

  it('STORY-mode (sprint-flow): valt terug op story-branch via legacy-pad', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      sprint_run_id: 'run-cuid-12345678',
      sprint_run: { id: 'run-cuid-12345678', pr_strategy: 'STORY' },
    })
    mockPrisma.claudeJob.findFirst.mockResolvedValue(null)

    const result = await resolveBranchForJob('job-1', 'story-cuid-87654321')

    expect(result.branchName).toBe('feat/story-87654321')
    expect(result.reused).toBe(false)
  })

  it('Legacy (geen sprint_run): bestaand gedrag — feat/story-<id-suffix>', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      sprint_run_id: null,
      sprint_run: null,
    })
    mockPrisma.claudeJob.findFirst.mockResolvedValue(null)

    const result = await resolveBranchForJob('job-1', 'story-cuid-87654321')

    expect(result.branchName).toBe('feat/story-87654321')
    expect(result.reused).toBe(false)
  })

  it('Legacy: hergebruik branch wanneer sibling-job in dezelfde story al een branch heeft', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      sprint_run_id: null,
      sprint_run: null,
    })
    mockPrisma.claudeJob.findFirst.mockResolvedValue({ branch: 'feat/story-87654321' })

    const result = await resolveBranchForJob('job-2', 'story-cuid-87654321')

    expect(result.branchName).toBe('feat/story-87654321')
    expect(result.reused).toBe(true)
  })
})
