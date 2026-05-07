// Unit-tests voor de no-op SKIPPED exit-route in update_job_status (PBI-57 ST-1273).
// Volle handler-integratie wordt niet hier getest — die hangt aan tientallen
// MCP/Prisma-mocks. Wel testen we de geëxporteerde helpers die expliciet
// SKIPPED-aware zijn gemaakt: resolveNextAction en cleanupWorktreeForTerminalStatus.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn(), count: vi.fn() },
  },
}))

vi.mock('../src/git/worktree.js', () => ({
  removeWorktreeForJob: vi.fn(),
}))

vi.mock('../src/tools/wait-for-job.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/tools/wait-for-job.js')>()
  return {
    ...original,
    resolveRepoRoot: vi.fn(),
  }
})

import { prisma } from '../src/prisma.js'
import { removeWorktreeForJob } from '../src/git/worktree.js'
import { resolveRepoRoot } from '../src/tools/wait-for-job.js'
import {
  cleanupWorktreeForTerminalStatus,
  resolveNextAction,
} from '../src/tools/update-job-status.js'

const mockRemove = removeWorktreeForJob as ReturnType<typeof vi.fn>
const mockResolve = resolveRepoRoot as ReturnType<typeof vi.fn>
const mockPrisma = prisma as unknown as {
  claudeJob: {
    findUnique: ReturnType<typeof vi.fn>
    count: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.claudeJob.findUnique.mockResolvedValue({ task: { story_id: 'story-default' } })
  mockPrisma.claudeJob.count.mockResolvedValue(0)
})

describe('resolveNextAction — skipped pad', () => {
  it('returns wait_for_job_again when queue has jobs after skipped', () => {
    expect(resolveNextAction(2, 'skipped')).toBe('wait_for_job_again')
  })

  it('returns queue_empty when queue is empty after skipped', () => {
    expect(resolveNextAction(0, 'skipped')).toBe('queue_empty')
  })
})

describe('cleanupWorktreeForTerminalStatus — skipped pad', () => {
  it('calls removeWorktreeForJob with keepBranch=false when skipped (no push happened)', async () => {
    mockResolve.mockResolvedValue('/repos/my-project')
    mockRemove.mockResolvedValue({ removed: true })

    await cleanupWorktreeForTerminalStatus('prod-001', 'job-skip', 'skipped', undefined)

    expect(mockRemove).toHaveBeenCalledWith({
      repoRoot: '/repos/my-project',
      jobId: 'job-skip',
      keepBranch: false,
    })
  })

  it('keeps keepBranch=false when skipped even if a branch is reported', async () => {
    mockResolve.mockResolvedValue('/repos/my-project')
    mockRemove.mockResolvedValue({ removed: true })

    await cleanupWorktreeForTerminalStatus('prod-001', 'job-skip', 'skipped', 'feat/job-skip')

    expect(mockRemove).toHaveBeenCalledWith({
      repoRoot: '/repos/my-project',
      jobId: 'job-skip',
      keepBranch: false,
    })
  })

  it('defers cleanup when sibling jobs in same story are still active (skipped path)', async () => {
    mockResolve.mockResolvedValue('/repos/my-project')
    mockPrisma.claudeJob.findUnique.mockResolvedValue({ task: { story_id: 'story-shared' } })
    mockPrisma.claudeJob.count.mockResolvedValue(1)

    await cleanupWorktreeForTerminalStatus('prod-001', 'job-skip', 'skipped', undefined)

    expect(mockRemove).not.toHaveBeenCalled()
  })
})
