import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'

vi.mock('../src/git/push.js', () => ({
  pushBranchForJob: vi.fn(),
}))

import { pushBranchForJob } from '../src/git/push.js'
import { prepareDoneUpdate } from '../src/tools/update-job-status.js'

const mockPush = pushBranchForJob as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
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

  it('derives branchName from jobId when branch is undefined', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
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
