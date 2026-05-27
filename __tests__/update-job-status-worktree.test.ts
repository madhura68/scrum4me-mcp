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
import { cleanupWorktreeForTerminalStatus } from '../src/tools/update-job-status.js'

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
  // Default: job exists, no active siblings — cleanup proceeds
  mockPrisma.claudeJob.findUnique.mockResolvedValue({ task: { story_id: 'story-default' } })
  mockPrisma.claudeJob.count.mockResolvedValue(0)
})

describe('cleanupWorktreeForTerminalStatus', () => {
  it('calls removeWorktreeForJob with keepBranch=true when done and branch set', async () => {
    mockResolve.mockResolvedValue('/repos/my-project')
    mockRemove.mockResolvedValue({ removed: true })

    await cleanupWorktreeForTerminalStatus('prod-001', 'job-abc', 'done', 'feat/job-abc')

    expect(mockRemove).toHaveBeenCalledWith({
      repoRoot: '/repos/my-project',
      jobId: 'job-abc',
      keepBranch: true,
    })
  })

  it('resolves terminal cleanup through task.repo_url for cross-repo task jobs', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      task: {
        story_id: 'story-cross',
        repo_url: 'https://git.jp-visser.nl/janpeter/scrum4me-mcp.git',
      },
      sprint_run_id: null,
      sprint_run: null,
    })
    mockResolve.mockResolvedValue('/repos/scrum4me-mcp')
    mockRemove.mockResolvedValue({ removed: true })

    await cleanupWorktreeForTerminalStatus('prod-001', 'job-cross', 'done', 'feat/x')

    expect(mockResolve).toHaveBeenCalledWith(
      'prod-001',
      'https://git.jp-visser.nl/janpeter/scrum4me-mcp.git',
    )
    expect(mockRemove).toHaveBeenCalledWith({
      repoRoot: '/repos/scrum4me-mcp',
      jobId: 'job-cross',
      keepBranch: true,
    })
  })

  it('calls removeWorktreeForJob with keepBranch=false when done but no branch', async () => {
    mockResolve.mockResolvedValue('/repos/my-project')
    mockRemove.mockResolvedValue({ removed: true })

    await cleanupWorktreeForTerminalStatus('prod-001', 'job-abc', 'done', undefined)

    expect(mockRemove).toHaveBeenCalledWith({
      repoRoot: '/repos/my-project',
      jobId: 'job-abc',
      keepBranch: false,
    })
  })

  it('calls removeWorktreeForJob with keepBranch=false when failed', async () => {
    mockResolve.mockResolvedValue('/repos/my-project')
    mockRemove.mockResolvedValue({ removed: true })

    await cleanupWorktreeForTerminalStatus('prod-001', 'job-abc', 'failed', 'feat/job-abc')

    expect(mockRemove).toHaveBeenCalledWith({
      repoRoot: '/repos/my-project',
      jobId: 'job-abc',
      keepBranch: false,
    })
  })

  it('skips cleanup and does not throw when no repoRoot configured', async () => {
    mockResolve.mockResolvedValue(null)

    await expect(
      cleanupWorktreeForTerminalStatus('prod-no-root', 'job-abc', 'done', undefined),
    ).resolves.toBeUndefined()

    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('does not throw when removeWorktreeForJob fails (best-effort)', async () => {
    mockResolve.mockResolvedValue('/repos/my-project')
    mockRemove.mockRejectedValue(new Error('git error'))

    await expect(
      cleanupWorktreeForTerminalStatus('prod-001', 'job-abc', 'done', 'feat/job-abc'),
    ).resolves.toBeUndefined()
  })

  it('defers cleanup when sibling jobs in same story are still active', async () => {
    mockResolve.mockResolvedValue('/repos/my-project')
    mockPrisma.claudeJob.findUnique.mockResolvedValue({ task: { story_id: 'story-shared' } })
    mockPrisma.claudeJob.count.mockResolvedValue(2) // 2 siblings active

    await cleanupWorktreeForTerminalStatus('prod-001', 'job-abc', 'done', 'feat/story-shared')

    expect(mockRemove).not.toHaveBeenCalled()
  })
})
