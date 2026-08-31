import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'node:path'
import * as os from 'node:os'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findMany: vi.fn() },
  },
}))

vi.mock('../src/git/worktree.js', () => ({
  removeWorktreeForJob: vi.fn(),
}))

vi.mock('../src/tools/wait-for-job.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/tools/wait-for-job.js')>()
  return { ...original, resolveRepoRoot: vi.fn() }
})

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
}))

vi.mock('../src/git/branch-safety.js', () => ({ maybeBackupPush: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { removeWorktreeForJob } from '../src/git/worktree.js'
import { maybeBackupPush } from '../src/git/branch-safety.js'
import { resolveRepoRoot } from '../src/tools/wait-for-job.js'
import * as fsPromises from 'node:fs/promises'
import { cleanupWorktrees, listWorktreeJobIds, getWorktreeParent } from '../src/tools/cleanup-my-worktrees.js'

const mockPrisma = prisma as unknown as {
  claudeJob: { findMany: ReturnType<typeof vi.fn> }
}
const mockRemove = removeWorktreeForJob as ReturnType<typeof vi.fn>
const mockResolve = resolveRepoRoot as ReturnType<typeof vi.fn>
const mockReaddir = fsPromises.readdir as ReturnType<typeof vi.fn>
const mockBackupPush = maybeBackupPush as unknown as ReturnType<typeof vi.fn>

const REPO_ROOT = '/repos/my-project'
const USER_ID = 'user-1'
const PRODUCT_ID = 'product-1'
const WORKTREE_PARENT = '/home/user/.scrum4me-agent-worktrees'

function makeDirent(name: string, isDir = true) {
  return { name, isDirectory: () => isDir } as unknown as import('node:fs').Dirent
}

beforeEach(() => {
  vi.clearAllMocks()
  mockResolve.mockResolvedValue(REPO_ROOT)
  mockRemove.mockResolvedValue({ removed: true })
  mockBackupPush.mockResolvedValue('pushed')
})

describe('getWorktreeParent', () => {
  it('uses SCRUM4ME_AGENT_WORKTREE_DIR env var when set', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/custom/dir'
    expect(await getWorktreeParent()).toBe('/custom/dir')
    delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
  })

  it('defaults to ~/.scrum4me-agent-worktrees', async () => {
    delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    expect(await getWorktreeParent()).toBe(path.join(os.homedir(), '.scrum4me-agent-worktrees'))
  })
})

describe('listWorktreeJobIds', () => {
  it('returns directory names from the worktree parent', async () => {
    mockReaddir.mockResolvedValue([makeDirent('job-aaa'), makeDirent('job-bbb'), makeDirent('file.txt', false)])
    const ids = await listWorktreeJobIds(WORKTREE_PARENT)
    expect(ids).toEqual(['job-aaa', 'job-bbb'])
  })

  it('returns empty array when parent does not exist', async () => {
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    expect(await listWorktreeJobIds(WORKTREE_PARENT)).toEqual([])
  })

  it('skips _products/ system dir and *.lock files (PBI-9)', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('job-aaa'),
      makeDirent('_products'),
      makeDirent('product-abc.lock'),
      makeDirent('job-bbb'),
    ])
    const ids = await listWorktreeJobIds(WORKTREE_PARENT)
    expect(ids).toEqual(['job-aaa', 'job-bbb'])
  })
})

describe('cleanupWorktrees', () => {
  it('removes worktrees for DONE/FAILED/CANCELLED jobs', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('job-done'),
      makeDirent('job-failed'),
      makeDirent('job-cancelled'),
    ])
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      { id: 'job-done',      status: 'DONE',      product_id: PRODUCT_ID, branch: 'feat/job-done' },
      { id: 'job-failed',    status: 'FAILED',    product_id: PRODUCT_ID, branch: null },
      { id: 'job-cancelled', status: 'CANCELLED', product_id: PRODUCT_ID, branch: null },
    ])

    const result = await cleanupWorktrees(WORKTREE_PARENT, USER_ID)

    expect(result.removed).toEqual(expect.arrayContaining(['job-done', 'job-failed', 'job-cancelled']))
    expect(result.kept).toEqual([])
    expect(result.skipped).toEqual([])
    expect(mockRemove).toHaveBeenCalledTimes(3)
  })

  it('keeps worktrees for QUEUED/CLAIMED/RUNNING jobs', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('job-queued'),
      makeDirent('job-claimed'),
      makeDirent('job-running'),
    ])
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      { id: 'job-queued',  status: 'QUEUED',  product_id: PRODUCT_ID, branch: null },
      { id: 'job-claimed', status: 'CLAIMED', product_id: PRODUCT_ID, branch: null },
      { id: 'job-running', status: 'RUNNING', product_id: PRODUCT_ID, branch: null },
    ])

    const result = await cleanupWorktrees(WORKTREE_PARENT, USER_ID)

    expect(result.kept).toEqual(expect.arrayContaining(['job-queued', 'job-claimed', 'job-running']))
    expect(result.removed).toEqual([])
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('calls removeWorktreeForJob with keepBranch=true for DONE with branch', async () => {
    mockReaddir.mockResolvedValue([makeDirent('job-done')])
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      { id: 'job-done', status: 'DONE', product_id: PRODUCT_ID, branch: 'feat/job-done' },
    ])

    await cleanupWorktrees(WORKTREE_PARENT, USER_ID)

    expect(mockRemove).toHaveBeenCalledWith({ repoRoot: REPO_ROOT, jobId: 'job-done', keepBranch: true })
  })

  it('calls removeWorktreeForJob with keepBranch=false for FAILED jobs', async () => {
    mockReaddir.mockResolvedValue([makeDirent('job-failed')])
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      { id: 'job-failed', status: 'FAILED', product_id: PRODUCT_ID, branch: null },
    ])

    await cleanupWorktrees(WORKTREE_PARENT, USER_ID)

    expect(mockRemove).toHaveBeenCalledWith({ repoRoot: REPO_ROOT, jobId: 'job-failed', keepBranch: false })
  })

  it('skips orphan worktrees (no DB record)', async () => {
    mockReaddir.mockResolvedValue([makeDirent('job-orphan')])
    mockPrisma.claudeJob.findMany.mockResolvedValue([])

    const result = await cleanupWorktrees(WORKTREE_PARENT, USER_ID)

    expect(result.skipped).toContain('job-orphan')
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('skips worktrees when no repoRoot is configured', async () => {
    mockReaddir.mockResolvedValue([makeDirent('job-norepo')])
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      { id: 'job-norepo', status: 'FAILED', product_id: 'unknown-product', branch: null },
    ])
    mockResolve.mockResolvedValue(null)

    const result = await cleanupWorktrees(WORKTREE_PARENT, USER_ID)

    expect(result.skipped).toContain('job-norepo')
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('returns empty result when worktree parent is empty', async () => {
    mockReaddir.mockResolvedValue([])

    const result = await cleanupWorktrees(WORKTREE_PARENT, USER_ID)

    expect(result).toEqual({ removed: [], kept: [], skipped: [] })
    expect(mockPrisma.claudeJob.findMany).not.toHaveBeenCalled()
  })

  // M38 T8 — spec §3.2.4 + §3.3 (repo-resolutie per job)
  it('gebruikt task.repo_url bij een cross-repo-job', async () => {
    mockReaddir.mockResolvedValue([makeDirent('j1')])
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      {
        id: 'j1',
        status: 'FAILED',
        product_id: PRODUCT_ID,
        branch: 'feat/x',
        task: { repo_url: 'https://git/other.git' },
      },
    ])

    await cleanupWorktrees(WORKTREE_PARENT, USER_ID)

    expect(mockResolve).toHaveBeenCalledWith(PRODUCT_ID, 'https://git/other.git')
  })

  it('pusht een FAILED-branch vóór verwijdering', async () => {
    mockReaddir.mockResolvedValue([makeDirent('j1')])
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      { id: 'j1', status: 'FAILED', product_id: PRODUCT_ID, branch: 'feat/x', task: null },
    ])

    await cleanupWorktrees(WORKTREE_PARENT, USER_ID)

    expect(mockBackupPush).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: path.join(WORKTREE_PARENT, 'j1'),
        branchName: 'feat/x',
      }),
    )
  })

  it('pusht niet voor DONE-jobs', async () => {
    mockReaddir.mockResolvedValue([makeDirent('j1')])
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      { id: 'j1', status: 'DONE', product_id: PRODUCT_ID, branch: 'feat/x', task: null },
    ])

    await cleanupWorktrees(WORKTREE_PARENT, USER_ID)

    expect(mockBackupPush).not.toHaveBeenCalled()
  })
})
