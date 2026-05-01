import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { removeWorktreeForJob } from '../src/git/worktree.js'
import { resolveRepoRoot } from '../src/tools/wait-for-job.js'
import { cleanupWorktreeForTerminalStatus } from '../src/tools/update-job-status.js'

const mockRemove = removeWorktreeForJob as ReturnType<typeof vi.fn>
const mockResolve = resolveRepoRoot as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
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
})
