import { beforeEach, describe, expect, it, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({ requireWriteAccess: vi.fn() }))
const pgMocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }))
const jobLockMocks = vi.hoisted(() => ({ releaseLocksOnTerminal: vi.fn() }))
const pushMocks = vi.hoisted(() => ({ pushBranchForJob: vi.fn(), triggerPush: vi.fn() }))
const worktreeMocks = vi.hoisted(() => ({
  markWorktreeCleanupPending: vi.fn(),
  isWorktreeCleanupPending: vi.fn(),
  clearWorktreeCleanupPending: vi.fn(),
}))
const prMocks = vi.hoisted(() => ({
  createPullRequest: vi.fn(),
  markPullRequestReady: vi.fn(),
  listPullRequestFiles: vi.fn(),
  enableAutoMergeOnPr: vi.fn(),
}))
const propagateMocks = vi.hoisted(() => ({ propagateStatusUpwards: vi.fn() }))
const effectsMocks = vi.hoisted(() => ({ executeEffects: vi.fn() }))
const deployJobMocks = vi.hoisted(() => ({ maybeEnqueueDeployJob: vi.fn() }))
const sprintBatchDeployMocks = vi.hoisted(() => ({
  maybeAutoDeploySprintBatchPr: vi.fn(),
  repoBucketKey: vi.fn((r: string | null | undefined, p: string) => `${p}:${r ?? ''}`),
}))
const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: unknown) => {
    const callback = typeof cb === 'function' ? cb : undefined
    callback?.(null, { stdout: 'deadbeefcafe\n', stderr: '' })
    return {}
  }),
}))

vi.mock('../src/auth.js', () => authMocks)
vi.mock('../src/git/job-locks.js', () => jobLockMocks)
vi.mock('../src/git/push.js', () => ({ pushBranchForJob: pushMocks.pushBranchForJob }))
vi.mock('../src/lib/push-trigger.js', () => ({ triggerPush: pushMocks.triggerPush }))
vi.mock('../src/git/worktree-cleanup-queue.js', () => worktreeMocks)
vi.mock('../src/git/pr.js', () => prMocks)
vi.mock('../src/lib/tasks-status-update.js', () => propagateMocks)
vi.mock('../src/flow/effects.js', () => effectsMocks)
vi.mock('../src/lib/dispatch/deploy-job.js', () => deployJobMocks)
vi.mock('../src/lib/dispatch/sprint-batch-deploy.js', () => sprintBatchDeployMocks)
vi.mock('node:child_process', () => childProcessMocks)
vi.mock('pg', () => ({
  Client: vi.fn(function Client() {
    return { connect: pgMocks.connect, query: pgMocks.query, end: pgMocks.end }
  }),
}))
vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), count: vi.fn() },
    product: { findUnique: vi.fn() },
    task: { findUnique: vi.fn() },
    sprintRun: { findUnique: vi.fn(), update: vi.fn() },
    sprintTaskExecution: { findMany: vi.fn() },
    story: { count: vi.fn() },
  },
}))

import { prisma } from '../src/prisma.js'
import { registerUpdateJobStatusTool } from '../src/tools/update-job-status.js'
import { maybeAutoDeploySprintBatchPr } from '../src/lib/dispatch/sprint-batch-deploy.js'
import { propagateStatusUpwards } from '../src/lib/tasks-status-update.js'

const mockPrisma = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> }
  product: { findUnique: ReturnType<typeof vi.fn> }
  task: { findUnique: ReturnType<typeof vi.fn> }
  sprintRun: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  sprintTaskExecution: { findMany: ReturnType<typeof vi.fn> }
  story: { count: ReturnType<typeof vi.fn> }
}
const mockDeploy = maybeAutoDeploySprintBatchPr as ReturnType<typeof vi.fn>
const mockPropagate = propagateStatusUpwards as ReturnType<typeof vi.fn>

function registerHandler() {
  let handler: ((input: { job_id: string; status: 'running' | 'done' | 'failed' | 'skipped'; summary?: string; error?: string; branch?: string }) => Promise<unknown>) | null = null
  registerUpdateJobStatusTool({
    registerTool: (_n: string, _c: unknown, cb: typeof handler) => { handler = cb },
  } as never)
  return handler!
}

const SUM = 'Sprint-batch klaar; alle stories DONE en gepusht.'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
  authMocks.requireWriteAccess.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' })
  pgMocks.connect.mockResolvedValue(undefined); pgMocks.query.mockResolvedValue({ rows: [] }); pgMocks.end.mockResolvedValue(undefined)
  jobLockMocks.releaseLocksOnTerminal.mockResolvedValue(undefined)
  pushMocks.pushBranchForJob.mockResolvedValue({ pushed: true, remoteRef: 'refs/heads/feat/run-1' })
  pushMocks.triggerPush.mockResolvedValue(undefined)
  worktreeMocks.markWorktreeCleanupPending.mockResolvedValue(undefined)
  worktreeMocks.isWorktreeCleanupPending.mockResolvedValue(false)
  worktreeMocks.clearWorktreeCleanupPending.mockResolvedValue(undefined)
  prMocks.createPullRequest.mockResolvedValue({ url: 'https://git.example/org/repo/pulls/9' })
  prMocks.markPullRequestReady.mockResolvedValue({ ok: true })
  prMocks.listPullRequestFiles.mockResolvedValue([])
  prMocks.enableAutoMergeOnPr.mockResolvedValue({ ok: true })
  effectsMocks.executeEffects.mockResolvedValue([])
  deployJobMocks.maybeEnqueueDeployJob.mockResolvedValue('enqueued')
  mockDeploy.mockResolvedValue(undefined)
  mockPrisma.product.findUnique.mockResolvedValue({ auto_pr: true })
  mockPrisma.task.findUnique.mockResolvedValue({ title: 'Sprint task', repo_url: null, story: { id: 'story-1', code: 'SCRUM-1', title: 'Story title' } })
  mockPrisma.claudeJob.findMany.mockResolvedValue([])
  mockPrisma.claudeJob.count.mockResolvedValue(0)
  mockPrisma.claudeJob.update.mockResolvedValue({
    id: 'job-1', status: 'DONE', branch: 'feat/run-1', pushed_at: new Date('2026-07-05T10:00:00Z'),
    pr_url: 'https://git.example/org/repo/pulls/9', verify_result: null, summary: SUM, error: null,
    started_at: new Date('2026-07-05T09:59:00Z'), finished_at: new Date('2026-07-05T10:00:00Z'), head_sha: 'deadbeefcafe',
  })
})

const JOB_BASE = {
  id: 'job-1', status: 'RUNNING', claimed_at: new Date('2026-07-05T09:58:00Z'),
  started_at: new Date('2026-07-05T09:59:00Z'), claimed_by_token_id: 'token-1',
  user_id: 'user-1', product_id: 'prod-1', idea_id: null, sprint_run_id: 'run-1',
  runtime: 'CLAUDE', source: 'SYSTEM', created_at: new Date('2026-07-05T09:58:00Z'),
  chat_cutoff_message_id: null, chat_cutoff_at: null,
}

describe('maybeAutoDeploySprintBatchPr call-sites in update_job_status', () => {
  it('(a) multi-job SPRINT-tak: propagatie zet SprintRun op DONE → helper aangeroepen', async () => {
    const handler = registerHandler()
    mockPrisma.claudeJob.findUnique
      // 1: initiële job-select
      .mockResolvedValueOnce({ ...JOB_BASE, task_id: 'task-1', kind: 'TASK_IMPLEMENTATION', verify_result: 'ALIGNED', task: { verify_only: false, verify_required: 'ALIGNED_OR_PARTIAL' } })
      // 2: maybeCreateAutoPr sprint_run-lookup (auto-PR draait want kind=TASK_IMPLEMENTATION + pushed)
      .mockResolvedValueOnce({ sprint_run_id: 'run-1', sprint_run: { id: 'run-1', pr_strategy: 'SPRINT', sprint: { sprint_goal: 'Live' } } })
      // 3: isStoryAutoMergeCandidate storyCtx-lookup — pr_strategy=SPRINT (≠STORY) ⇒ STORY-auto-merge geskipt
      .mockResolvedValueOnce({ task: { story: { status: 'DONE' } }, sprint_run: { pr_strategy: 'SPRINT' } })
      // 4: sprintRunBecameDone ctx-lookup (de sprint-batch-call-site)
      .mockResolvedValueOnce({ sprint_run_id: 'run-1', sprint_run: { pr_strategy: 'SPRINT', status: 'DONE' } })
    mockPropagate.mockResolvedValue({ task: { id: 'task-1', title: 't', status: 'DONE', story_id: 'story-1', implementation_plan: null }, storyId: 'story-1', storyChanged: false, pbiChanged: false, sprintChanged: true, sprintRunChanged: true })
    mockPrisma.claudeJob.findFirst.mockResolvedValue({ pr_url: 'https://git.example/org/repo/pulls/9' })
    const result = await handler({ job_id: 'job-1', status: 'done', summary: SUM, branch: 'feat/run-1' })
    expect(result).not.toMatchObject({ isError: true })
    expect(mockDeploy).toHaveBeenCalledTimes(1)
    expect(mockDeploy).toHaveBeenCalledWith({ jobId: 'job-1', userId: 'user-1', productId: 'prod-1', sprintRunId: 'run-1' })
  })

  it('(b) single-session SPRINT_IMPLEMENTATION DONE → finalize zet run DONE → helper aangeroepen', async () => {
    const handler = registerHandler()
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce({ ...JOB_BASE, task_id: null, kind: 'SPRINT_IMPLEMENTATION', verify_result: null, task: null })
      .mockResolvedValueOnce({ sprint_run_id: 'run-1', sprint_run: { id: 'run-1', sprint: { sprint_goal: 'Live' } } })
    mockPrisma.sprintTaskExecution.findMany.mockResolvedValue([{ id: 'exec-1', task_id: 'task-1', order: 0, status: 'DONE', verify_result: 'ALIGNED', verify_summary: null, verify_required_snapshot: 'ALIGNED_OR_PARTIAL', verify_only_snapshot: false, task: { code: 'TASK-1', title: 'Sample' } }])
    mockPrisma.sprintRun.findUnique
      .mockResolvedValueOnce({ previous_run_id: null })
      .mockResolvedValueOnce({ id: 'run-1', status: 'RUNNING', sprint_id: 'sprint-1' })
      .mockResolvedValueOnce({ status: 'DONE' })
    mockPrisma.story.count.mockResolvedValue(0)
    mockPrisma.sprintRun.update.mockResolvedValue(undefined)
    const result = await handler({ job_id: 'job-1', status: 'done', summary: SUM, branch: 'feat/run-1' })
    expect(result).not.toMatchObject({ isError: true })
    expect(mockDeploy).toHaveBeenCalledTimes(1)
    expect(mockDeploy).toHaveBeenCalledWith({ jobId: 'job-1', userId: 'user-1', productId: 'prod-1', sprintRunId: 'run-1' })
  })

  it('(c) STORY-run: geen sprint-batch-deploy', async () => {
    const handler = registerHandler()
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce({ ...JOB_BASE, task_id: 'task-1', kind: 'TASK_IMPLEMENTATION', verify_result: 'ALIGNED', task: { verify_only: false, verify_required: 'ALIGNED_OR_PARTIAL' } })
      .mockResolvedValueOnce({ sprint_run_id: 'run-1', sprint_run: { id: 'run-1', pr_strategy: 'STORY', sprint: { sprint_goal: 'Story' } } })
      .mockResolvedValueOnce({ sprint_run_id: 'run-1', sprint_run: { pr_strategy: 'STORY', status: 'DONE' } })
      .mockResolvedValueOnce({ task: { story: { status: 'DONE' } }, sprint_run: { pr_strategy: 'STORY' } })
    mockPropagate.mockResolvedValue({ task: { id: 'task-1', title: 't', status: 'DONE', story_id: 'story-1', implementation_plan: null }, storyId: 'story-1', storyChanged: true, pbiChanged: false, sprintChanged: false, sprintRunChanged: false })
    mockPrisma.claudeJob.findFirst.mockResolvedValue(null)
    const result = await handler({ job_id: 'job-1', status: 'done', summary: SUM, branch: 'feat/run-1' })
    expect(result).not.toMatchObject({ isError: true })
    expect(mockDeploy).not.toHaveBeenCalled()
  })
})
