// M38 T5 — resetStaleClaimedJobs: requeue + execution-cleanup transactioneel,
// vangnet-push voor élke stale rij met een branch (spec §3.2.3 / §3.4).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    sprintTaskExecution: { deleteMany: vi.fn(), findFirst: vi.fn() },
    sprintRun: { update: vi.fn() },
  },
}))
vi.mock('../src/git/branch-safety.js', () => ({ maybeBackupPush: vi.fn() }))
vi.mock('../src/git/job-locks.js', () => ({
  releaseLocksOnTerminal: vi.fn(),
  setupProductWorktrees: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { maybeBackupPush } from '../src/git/branch-safety.js'
import { resetStaleClaimedJobs } from '../src/tools/wait-for-job.js'

type PrismaMock = {
  $queryRaw: ReturnType<typeof vi.fn>
  $transaction: ReturnType<typeof vi.fn>
  sprintTaskExecution: { deleteMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> }
  sprintRun: { update: ReturnType<typeof vi.fn> }
}
const p = prisma as unknown as PrismaMock
const mockPush = maybeBackupPush as unknown as ReturnType<typeof vi.fn>
const originalWorktreeDir = process.env.SCRUM4ME_AGENT_WORKTREE_DIR

// Volgorde-registratie: bewijst dat deleteMany binnen de transactie-callback loopt.
let calls: string[] = []

function staleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    task_id: null,
    product_id: 'p',
    kind: 'SPRINT_IMPLEMENTATION',
    runtime: 'DOCKER',
    source: 'AUTO',
    sprint_run_id: null,
    branch: 'feat/sprint-x',
    retry_count: 1,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  calls = []
  process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
  p.$queryRaw.mockResolvedValue([])
  p.sprintTaskExecution.deleteMany.mockImplementation(async () => {
    calls.push('deleteMany')
    return { count: 0 }
  })
  p.sprintTaskExecution.findFirst.mockResolvedValue(null)
  p.sprintRun.update.mockResolvedValue({})
  mockPush.mockResolvedValue('pushed')
  p.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    calls.push('tx:begin')
    const result = await fn({
      $queryRaw: p.$queryRaw,
      sprintTaskExecution: p.sprintTaskExecution,
    })
    calls.push('tx:end')
    return result
  })
})

afterEach(() => {
  process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalWorktreeDir
})

describe('resetStaleClaimedJobs (M38)', () => {
  it('verwijdert execution-rows van gerequeuede sprint-jobs binnen de transactie', async () => {
    p.$queryRaw
      .mockResolvedValueOnce([]) // failedRows
      .mockResolvedValueOnce([staleRow({ id: 'j1' })]) // requeuedRows

    await resetStaleClaimedJobs('u1')

    expect(p.sprintTaskExecution.deleteMany).toHaveBeenCalledWith({
      where: { sprint_job_id: { in: ['j1'] } },
    })
    // deleteMany zit tussen begin en einde van de transactie
    expect(calls).toEqual(['tx:begin', 'deleteMany', 'tx:end'])
  })

  it('verwijdert geen executions voor niet-SPRINT rijen', async () => {
    p.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([staleRow({ id: 'j2', kind: 'TASK_IMPLEMENTATION', task_id: 't1' })])

    await resetStaleClaimedJobs('u1')

    expect(p.sprintTaskExecution.deleteMany).not.toHaveBeenCalled()
  })

  it('pusht de branch van gerequeuede én failed stale rijen', async () => {
    p.$queryRaw
      .mockResolvedValueOnce([
        staleRow({ id: 'jf', branch: 'feat/sprint-f', retry_count: undefined }),
      ])
      .mockResolvedValueOnce([
        staleRow({ id: 'jr', kind: 'TASK_IMPLEMENTATION', task_id: 't', branch: 'feat/story-r' }),
      ])

    await resetStaleClaimedJobs('u1')

    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: path.join('/wt', 'jf'), branchName: 'feat/sprint-f' }),
    )
    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: path.join('/wt', 'jr'), branchName: 'feat/story-r' }),
    )
  })

  it('pusht niet voor een stale rij zonder branch', async () => {
    p.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([staleRow({ id: 'j3', branch: null })])

    await resetStaleClaimedJobs('u1')

    expect(mockPush).not.toHaveBeenCalled()
  })

  it('een pushfout blokkeert de sweep niet', async () => {
    p.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([staleRow({ id: 'j4', sprint_run_id: null })])
    mockPush.mockRejectedValue(new Error('boom'))

    await expect(resetStaleClaimedJobs('u1')).resolves.toBeUndefined()
  })
})
