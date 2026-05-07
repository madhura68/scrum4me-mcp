import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('../src/tools/wait-for-job.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/tools/wait-for-job.js')>()
  return { ...original, resolveRepoRoot: vi.fn() }
})

vi.mock('../src/git/worktree.js', () => ({
  removeWorktreeForJob: vi.fn(),
}))

vi.mock('../src/git/pr.js', () => ({
  closePullRequest: vi.fn(),
  getPullRequestState: vi.fn(),
  createRevertPullRequest: vi.fn(),
}))

vi.mock('../src/git/push.js', () => ({
  deleteRemoteBranch: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { resolveRepoRoot } from '../src/tools/wait-for-job.js'
import { removeWorktreeForJob } from '../src/git/worktree.js'
import {
  closePullRequest,
  getPullRequestState,
  createRevertPullRequest,
} from '../src/git/pr.js'
import { deleteRemoteBranch } from '../src/git/push.js'
import { cancelPbiOnFailure } from '../src/cancel/pbi-cascade.js'

const mockPrisma = prisma as unknown as {
  claudeJob: {
    findUnique: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}
const mockResolveRepoRoot = resolveRepoRoot as ReturnType<typeof vi.fn>
const mockRemoveWorktree = removeWorktreeForJob as ReturnType<typeof vi.fn>
const mockClosePr = closePullRequest as ReturnType<typeof vi.fn>
const mockGetPrState = getPullRequestState as ReturnType<typeof vi.fn>
const mockCreateRevertPr = createRevertPullRequest as ReturnType<typeof vi.fn>
const mockDeleteBranch = deleteRemoteBranch as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.claudeJob.update.mockResolvedValue({})
  mockPrisma.claudeJob.updateMany.mockResolvedValue({ count: 0 })
  mockResolveRepoRoot.mockResolvedValue('/repos/proj')
  mockRemoveWorktree.mockResolvedValue(undefined)
  // Sensible defaults so an un-stubbed branch in a test doesn't throw on
  // `result.deleted` / `result.ok` access. Tests that care override these.
  mockDeleteBranch.mockResolvedValue({ deleted: true })
  mockClosePr.mockResolvedValue({ ok: true })
})

const FAILED_JOB = {
  id: 'job-failed',
  kind: 'TASK_IMPLEMENTATION',
  product_id: 'prod-1',
  task_id: 'task-failed',
  branch: 'feat/story-aaaabbbb',
  pr_url: null,
  task: { story: { pbi: { id: 'pbi-1', code: 'PBI-7' } } },
}

describe('cancelPbiOnFailure', () => {
  it('no-ops for non-TASK_IMPLEMENTATION jobs', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({ ...FAILED_JOB, kind: 'IDEA_GRILL' })

    const out = await cancelPbiOnFailure('job-failed')

    expect(out.cancelled_job_ids).toEqual([])
    expect(mockPrisma.claudeJob.findMany).not.toHaveBeenCalled()
    expect(mockPrisma.claudeJob.updateMany).not.toHaveBeenCalled()
  })

  it('no-ops when failed job has no PBI parent', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      ...FAILED_JOB,
      task: null,
    })
    const out = await cancelPbiOnFailure('job-failed')
    expect(out).toEqual({
      cancelled_job_ids: [],
      closed_prs: [],
      reverted_prs: [],
      deleted_branches: [],
      warnings: [],
    })
  })

  it('cancels eligible siblings and writes a trace to the failed job', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(FAILED_JOB)
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      { id: 'job-sib1', branch: 'feat/story-aaaabbbb', pr_url: null, status: 'QUEUED', task_id: 't2' },
      { id: 'job-sib2', branch: 'feat/story-ccccdddd', pr_url: null, status: 'CLAIMED', task_id: 't3' },
    ])

    const out = await cancelPbiOnFailure('job-failed')

    expect(mockPrisma.claudeJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['job-sib1', 'job-sib2'] } },
        data: expect.objectContaining({
          status: 'CANCELLED',
          error: 'cancelled_by_pbi_failure',
        }),
      }),
    )
    expect(out.cancelled_job_ids).toEqual(['job-sib1', 'job-sib2'])
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-failed' },
        data: expect.objectContaining({ error: expect.stringContaining('cancelled_by_self') }),
      }),
    )
  })

  it('idempotent: empty eligible set means no updateMany call', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(FAILED_JOB)
    mockPrisma.claudeJob.findMany.mockResolvedValue([])

    await cancelPbiOnFailure('job-failed')

    expect(mockPrisma.claudeJob.updateMany).not.toHaveBeenCalled()
  })

  it('closes an open PR with the cascade comment', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      ...FAILED_JOB,
      pr_url: 'https://github.com/o/r/pull/1',
    })
    mockPrisma.claudeJob.findMany.mockResolvedValue([])
    mockGetPrState.mockResolvedValue({
      state: 'OPEN',
      mergeCommit: null,
      baseRefName: 'main',
      title: 'feat: x',
    })
    mockClosePr.mockResolvedValue({ ok: true })

    const out = await cancelPbiOnFailure('job-failed')

    expect(mockClosePr).toHaveBeenCalledWith(
      expect.objectContaining({
        prUrl: 'https://github.com/o/r/pull/1',
        comment: expect.stringContaining('PBI PBI-7'),
      }),
    )
    expect(out.closed_prs).toEqual(['https://github.com/o/r/pull/1'])
  })

  it('creates a revert-PR when an affected PR is already merged', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      ...FAILED_JOB,
      pr_url: 'https://github.com/o/r/pull/9',
    })
    mockPrisma.claudeJob.findMany.mockResolvedValue([])
    mockGetPrState.mockResolvedValue({
      state: 'MERGED',
      mergeCommit: 'abc123def',
      baseRefName: 'main',
      title: 'feat: shipped',
    })
    mockCreateRevertPr.mockResolvedValue({ url: 'https://github.com/o/r/pull/10' })

    const out = await cancelPbiOnFailure('job-failed')

    expect(mockCreateRevertPr).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: '/repos/proj',
        mergeSha: 'abc123def',
        baseRef: 'main',
        originalTitle: 'feat: shipped',
        originalBranch: 'feat/story-aaaabbbb',
        jobId: 'job-failed',
        pbiCode: 'PBI-7',
      }),
    )
    expect(out.reverted_prs).toEqual([
      { original: 'https://github.com/o/r/pull/9', revertPr: 'https://github.com/o/r/pull/10' },
    ])
    expect(mockClosePr).not.toHaveBeenCalled()
  })

  it('skips revert when no repo root is configured + emits a warning', async () => {
    mockResolveRepoRoot.mockResolvedValue(null)
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      ...FAILED_JOB,
      pr_url: 'https://github.com/o/r/pull/9',
    })
    mockPrisma.claudeJob.findMany.mockResolvedValue([])
    mockGetPrState.mockResolvedValue({
      state: 'MERGED',
      mergeCommit: 'abc',
      baseRefName: 'main',
      title: 'x',
    })

    const out = await cancelPbiOnFailure('job-failed')

    expect(mockCreateRevertPr).not.toHaveBeenCalled()
    expect(out.warnings.some((w) => /no repo root/i.test(w))).toBe(true)
  })

  it('deletes a remote branch when there is no PR for it', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      ...FAILED_JOB,
      pr_url: null,
    })
    mockPrisma.claudeJob.findMany.mockResolvedValue([])
    mockDeleteBranch.mockResolvedValue({ deleted: true })

    const out = await cancelPbiOnFailure('job-failed')

    expect(mockDeleteBranch).toHaveBeenCalledWith({
      repoRoot: '/repos/proj',
      branch: 'feat/story-aaaabbbb',
    })
    expect(out.deleted_branches).toEqual(['feat/story-aaaabbbb'])
  })

  it('groups siblings sharing a branch so the PR is only closed once', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      ...FAILED_JOB,
      branch: 'feat/story-shared',
      pr_url: 'https://github.com/o/r/pull/1',
    })
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      {
        id: 'job-sib',
        branch: 'feat/story-shared',
        pr_url: 'https://github.com/o/r/pull/1',
        status: 'QUEUED',
        task_id: 't2',
      },
    ])
    mockGetPrState.mockResolvedValue({
      state: 'OPEN',
      mergeCommit: null,
      baseRefName: 'main',
      title: 't',
    })
    mockClosePr.mockResolvedValue({ ok: true })

    await cancelPbiOnFailure('job-failed')

    expect(mockClosePr).toHaveBeenCalledTimes(1)
  })

  it('removes worktrees of cancelled siblings', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(FAILED_JOB)
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      { id: 'job-sib1', branch: null, pr_url: null, status: 'QUEUED', task_id: 't2' },
    ])

    await cancelPbiOnFailure('job-failed')

    expect(mockRemoveWorktree).toHaveBeenCalledWith({
      repoRoot: '/repos/proj',
      jobId: 'job-sib1',
      keepBranch: false,
    })
  })

  it('never throws — wraps unexpected errors into warnings', async () => {
    mockPrisma.claudeJob.findUnique.mockRejectedValue(new Error('boom'))

    const out = await cancelPbiOnFailure('job-failed')

    expect(out.warnings.some((w) => w.includes('boom'))).toBe(true)
  })

  it('no-ops when failed job has status SKIPPED (no-op exit, niet een echte fail)', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({ ...FAILED_JOB, status: 'SKIPPED' })

    const out = await cancelPbiOnFailure('job-failed')

    expect(out.cancelled_job_ids).toEqual([])
    expect(mockPrisma.claudeJob.findMany).not.toHaveBeenCalled()
    expect(mockPrisma.claudeJob.updateMany).not.toHaveBeenCalled()
    expect(mockPrisma.claudeJob.update).not.toHaveBeenCalled()
  })

  it('appends the cascade trace to an existing error (preserves original cause)', async () => {
    // findUnique wordt twee keer aangeroepen: eerst voor failedJob (status FAILED + originele error),
    // daarna door de append-trace om de huidige error te lezen vóór update.
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce({ ...FAILED_JOB, status: 'FAILED' })
      .mockResolvedValueOnce({ error: 'timeout: agent died after 5min' })
    mockPrisma.claudeJob.findMany.mockResolvedValue([])

    await cancelPbiOnFailure('job-failed')

    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-failed' },
        data: expect.objectContaining({
          error: expect.stringMatching(/timeout: agent died after 5min[\s\S]*---[\s\S]*cancelled_by_self/),
        }),
      }),
    )
  })

  it('falls back to trace-only when there is no existing error', async () => {
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce({ ...FAILED_JOB, status: 'FAILED' })
      .mockResolvedValueOnce({ error: null })
    mockPrisma.claudeJob.findMany.mockResolvedValue([])

    await cancelPbiOnFailure('job-failed')

    const updateCall = mockPrisma.claudeJob.update.mock.calls[0]?.[0] as
      | { data: { error: string } }
      | undefined
    expect(updateCall?.data.error).toMatch(/^cancelled_by_self/)
    expect(updateCall?.data.error).not.toContain('---')
  })

  it('truncates the merged error at 1900 chars while preserving the head of the original', async () => {
    const longOriginal = 'X'.repeat(1800)
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce({ ...FAILED_JOB, status: 'FAILED' })
      .mockResolvedValueOnce({ error: longOriginal })
    mockPrisma.claudeJob.findMany.mockResolvedValue([])

    await cancelPbiOnFailure('job-failed')

    const updateCall = mockPrisma.claudeJob.update.mock.calls[0]?.[0] as
      | { data: { error: string } }
      | undefined
    expect(updateCall?.data.error.length).toBeLessThanOrEqual(1900)
    expect(updateCall?.data.error.startsWith('X')).toBe(true)
  })
})
