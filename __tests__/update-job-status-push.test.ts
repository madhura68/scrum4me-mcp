import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'

vi.mock('../src/git/push.js', () => ({
  pushBranchForJob: vi.fn(),
}))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: {
      findUnique: vi.fn(),
    },
  },
}))

import { pushBranchForJob } from '../src/git/push.js'
import { prisma } from '../src/prisma.js'
import { prepareDoneUpdate } from '../src/tools/update-job-status.js'

const mockPush = pushBranchForJob as ReturnType<typeof vi.fn>
const mockFindUnique = (prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
}).claudeJob.findUnique

beforeEach(() => {
  vi.clearAllMocks()
  mockFindUnique.mockResolvedValue(null)
})

describe('prepareDoneUpdate', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv.SCRUM4ME_AGENT_WORKTREE_DIR
  })

  it('returns DONE with pushedAt and branchOverride when push succeeds', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockPush.mockResolvedValue({ pushed: true, remoteRef: 'refs/heads/feat/job-abc' })

    const plan = await prepareDoneUpdate('job-abc', 'feat/job-abc')

    expect(plan.dbStatus).toBe('DONE')
    expect(plan.pushedAt).toBeInstanceOf(Date)
    expect(plan.branchOverride).toBe('feat/job-abc')
    expect(plan.errorOverride).toBeUndefined()
    expect(plan.skipWorktreeCleanup).toBe(false)

    expect(mockPush).toHaveBeenCalledWith({
      worktreePath: path.join('/wt', 'job-abc'),
      branchName: 'feat/job-abc',
    })
  })

  it('reads branchName from DB (claudeJob.branch) when branch arg is undefined', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockFindUnique.mockResolvedValue({ branch: 'feat/sprint-fvy30lvv' })
    mockPush.mockResolvedValue({ pushed: true, remoteRef: 'refs/heads/feat/sprint-fvy30lvv' })

    await prepareDoneUpdate('job-abc12345', undefined)

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: 'job-abc12345' },
      select: { branch: true },
    })
    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feat/sprint-fvy30lvv' }),
    )
  })

  it('falls back to feat/job-<8> when neither branch arg nor DB.branch is set', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockFindUnique.mockResolvedValue({ branch: null })
    mockPush.mockResolvedValue({ pushed: true, remoteRef: 'refs/heads/feat/job-abc12345' })

    await prepareDoneUpdate('job-abc12345', undefined)

    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feat/job-abc12345' }),
    )
  })

  it('returns DONE without pushedAt when no-changes', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockPush.mockResolvedValue({ pushed: false, reason: 'no-changes', stderr: '' })

    const plan = await prepareDoneUpdate('job-abc', 'feat/job-abc')

    expect(plan.dbStatus).toBe('DONE')
    expect(plan.pushedAt).toBeUndefined()
    expect(plan.branchOverride).toBeUndefined()
    expect(plan.errorOverride).toBeUndefined()
    expect(plan.skipWorktreeCleanup).toBe(false)
  })

  it('returns FAILED with error and skipWorktreeCleanup when no-credentials', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockPush.mockResolvedValue({
      pushed: false,
      reason: 'no-credentials',
      stderr: 'fatal: Authentication failed',
    })

    const plan = await prepareDoneUpdate('job-abc', 'feat/job-abc')

    expect(plan.dbStatus).toBe('FAILED')
    expect(plan.errorOverride).toContain('push failed (no-credentials)')
    expect(plan.errorOverride).toContain('Authentication failed')
    expect(plan.skipWorktreeCleanup).toBe(true)
  })

  it('returns FAILED with error and skipWorktreeCleanup when conflict', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockPush.mockResolvedValue({
      pushed: false,
      reason: 'conflict',
      stderr: '! [rejected] non-fast-forward',
    })

    const plan = await prepareDoneUpdate('job-abc', 'feat/job-abc')

    expect(plan.dbStatus).toBe('FAILED')
    expect(plan.errorOverride).toContain('push failed (conflict)')
    expect(plan.skipWorktreeCleanup).toBe(true)
  })

  it('returns FAILED with error and skipWorktreeCleanup when unknown push error', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockPush.mockResolvedValue({
      pushed: false,
      reason: 'unknown',
      stderr: 'something went wrong',
    })

    const plan = await prepareDoneUpdate('job-abc', 'feat/job-abc')

    expect(plan.dbStatus).toBe('FAILED')
    expect(plan.skipWorktreeCleanup).toBe(true)
  })
})
