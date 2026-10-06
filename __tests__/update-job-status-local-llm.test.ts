import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// Taak 5 (M3-plan): update_job_status slaat maybeCreateAutoPr,
// propagateStatusUpwards en cancelPbiOnFailure over voor
// kind=TASK_IMPLEMENTATION jobs met required_capability='local_llm' — de
// harness beheert de taakstatus zelf en de Claude-sessie mergt de branch met
// de hand. Push bij done, de verify-gate, de jobvelden en de antwoord-JSON
// blijven ongewijzigd (Taak 3 regelt de backup-push-skip al via
// maybeBackupPush/branch-safety.ts).
// M45-2b (Taak 3): dezelfde drie uitzonderingen gelden voor een job met runtime
// 'HARNESS' (isHarnessJobRow, spec §5.6); de twee tests met uitzondering draaien
// hieronder voor beide soorten, de twee regressietests voor een gewone job.
//
// Dit bestand test de HANDLER-condities met gemockte git (push.js gemockt,
// branch-safety.js/worktree.js hier niet gebruikt). De keten-proef met échte
// git tegen een omgebogen gitlink (fsmonitor/sshCommand-markers) zit in het
// aparte bestand __tests__/update-job-status-local-llm-chain.test.ts — die
// heeft écht `git/push.js` nodig (niet gemockt) om te bewijzen dat een
// weggehaalde guard daadwerkelijk een echte push door de evil-origin zou
// triggeren; dat kan niet in hetzelfde bestand als deze gemockte push.js.

const authMocks = vi.hoisted(() => ({ requireWriteAccess: vi.fn() }))
const pgMocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }))
const jobLockMocks = vi.hoisted(() => ({ releaseLocksOnTerminal: vi.fn() }))
const pushMocks = vi.hoisted(() => ({ pushBranchForJob: vi.fn(), triggerPush: vi.fn() }))
const worktreeQueueMocks = vi.hoisted(() => ({
  markWorktreeCleanupPending: vi.fn(),
  isWorktreeCleanupPending: vi.fn(),
  clearWorktreeCleanupPending: vi.fn(),
}))
const prMocks = vi.hoisted(() => ({
  createPullRequest: vi.fn(),
  markPullRequestReady: vi.fn(),
  listPullRequestFiles: vi.fn(),
  getPullRequestState: vi.fn(),
}))
const propagateMocks = vi.hoisted(() => ({ propagateStatusUpwards: vi.fn() }))
const cascadeMocks = vi.hoisted(() => ({ cancelPbiOnFailure: vi.fn() }))
const effectsMocks = vi.hoisted(() => ({ executeEffects: vi.fn() }))
const deployJobMocks = vi.hoisted(() => ({ maybeEnqueueDeployJob: vi.fn() }))

vi.mock('../src/auth.js', () => authMocks)
vi.mock('../src/git/job-locks.js', () => jobLockMocks)
vi.mock('../src/git/push.js', () => ({ pushBranchForJob: pushMocks.pushBranchForJob }))
vi.mock('../src/lib/push-trigger.js', () => ({ triggerPush: pushMocks.triggerPush }))
vi.mock('../src/git/worktree-cleanup-queue.js', () => worktreeQueueMocks)
vi.mock('../src/git/pr.js', () => prMocks)
vi.mock('../src/lib/tasks-status-update.js', () => propagateMocks)
vi.mock('../src/cancel/pbi-cascade.js', () => cascadeMocks)
vi.mock('../src/flow/effects.js', () => effectsMocks)
vi.mock('../src/lib/dispatch/deploy-job.js', () => deployJobMocks)
vi.mock('pg', () => ({
  Client: vi.fn(function Client() {
    return { connect: pgMocks.connect, query: pgMocks.query, end: pgMocks.end }
  }),
}))

// node:child_process blijft echt (delegerende spy, zie
// __tests__/git/local-llm.test.ts): prepareDoneUpdate's post-push
// `rev-parse HEAD` (dynamische import van node:child_process, ná
// gitPrefixFor) draait dus echt, maar zonder bestaande worktree op schijf
// faalt dat simpelweg stil (ENOENT) — precies het bestaande gedrag van vóór
// deze taak (zie update-job-status-push.test.ts). git/push.js blijft hieronder
// gemockt: dit bestand test de HANDLER-condities, niet de git-keten zelf.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify: p } = await import('node:util')
  const originalPromisified = (
    actual.execFile as unknown as Record<symbol, (...a: unknown[]) => unknown>
  )[p.custom]
  const execFileMock = vi.fn((...args: unknown[]) =>
    (actual.execFile as unknown as (...a: unknown[]) => unknown)(...args),
  )
  Object.defineProperty(execFileMock, p.custom, {
    value: (...args: unknown[]) => {
      execFileMock.mock.calls.push(args as never)
      return originalPromisified(...args)
    },
  })
  return { ...actual, execFile: execFileMock, execFileSync: actual.execFileSync }
})

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    product: { findUnique: vi.fn() },
    task: { findUnique: vi.fn() },
  },
}))

import { prisma } from '../src/prisma.js'
import { registerUpdateJobStatusTool } from '../src/tools/update-job-status.js'
import { propagateStatusUpwards } from '../src/lib/tasks-status-update.js'
import { cancelPbiOnFailure } from '../src/cancel/pbi-cascade.js'
import { createPullRequest } from '../src/git/pr.js'
import { GUARDED_JOBS } from './helpers/guarded-jobs.js'

const mockPrisma = prisma as unknown as {
  claudeJob: {
    findUnique: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    count: ReturnType<typeof vi.fn>
  }
  product: { findUnique: ReturnType<typeof vi.fn> }
  task: { findUnique: ReturnType<typeof vi.fn> }
}
const mockPropagate = propagateStatusUpwards as ReturnType<typeof vi.fn>
const mockCancelPbi = cancelPbiOnFailure as ReturnType<typeof vi.fn>
const mockCreatePr = createPullRequest as ReturnType<typeof vi.fn>

function registerHandler() {
  let handler:
    | ((input: {
        job_id: string
        status: 'running' | 'done' | 'failed' | 'skipped'
        summary?: string
        error?: string
        branch?: string
      }) => Promise<unknown>)
    | null = null
  registerUpdateJobStatusTool({
    registerTool: (_n: string, _c: unknown, cb: typeof handler) => {
      handler = cb
    },
  } as never)
  return handler!
}

// Superset fixture voor prisma.claudeJob.findUnique: elke aanroep in de
// keten (initiële job-select, assertUnmanagedJob*, isHarnessJob) vraagt om
// hetzelfde job.id met een ander `select` — een mock die op id matcht en
// altijd de volledige fixture teruggeeft dekt ze allemaal, ongeacht select.
function installJobFixture(fixture: Record<string, unknown> & { id: string }) {
  mockPrisma.claudeJob.findUnique.mockImplementation((async (args: {
    where: { id: string }
  }) => {
    if (args.where.id !== fixture.id) return null
    return fixture
  }) as never)
}

function baseFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-local-1',
    status: 'RUNNING',
    claimed_at: new Date('2026-09-27T09:00:00Z'),
    started_at: new Date('2026-09-27T09:00:00Z'),
    claimed_by_token_id: 'token-1',
    user_id: 'user-1',
    product_id: 'prod-1',
    task_id: 'task-1',
    idea_id: null,
    sprint_run_id: null,
    kind: 'TASK_IMPLEMENTATION',
    runtime: 'CLAUDE',
    source: 'COPILOT',
    verify_result: 'ALIGNED',
    created_at: new Date('2026-09-27T08:59:00Z'),
    chat_cutoff_message_id: null,
    chat_cutoff_at: null,
    required_capability: 'local_llm',
    dispatch_request_id: null,
    dispatch_candidate_id: null,
    task_executions: [],
    task: {
      verify_only: false,
      verify_required: 'ALIGNED_OR_PARTIAL',
      dispatch_request_id: null,
      title: 'Local LLM taak',
      repo_url: null,
      story: { id: 'story-1', code: 'SCRUM-1', title: 'Story title' },
    },
    branch: 'feat/job-local-1',
    pr_url: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
  authMocks.requireWriteAccess.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' })
  pgMocks.connect.mockResolvedValue(undefined)
  pgMocks.query.mockResolvedValue({ rows: [] })
  pgMocks.end.mockResolvedValue(undefined)
  jobLockMocks.releaseLocksOnTerminal.mockResolvedValue(undefined)
  pushMocks.pushBranchForJob.mockResolvedValue({ pushed: true, remoteRef: 'refs/heads/feat/job-local-1' })
  pushMocks.triggerPush.mockResolvedValue(undefined)
  worktreeQueueMocks.markWorktreeCleanupPending.mockResolvedValue(undefined)
  worktreeQueueMocks.isWorktreeCleanupPending.mockResolvedValue(false)
  worktreeQueueMocks.clearWorktreeCleanupPending.mockResolvedValue(undefined)
  prMocks.createPullRequest.mockResolvedValue({ url: 'https://git.example/org/repo/pulls/9' })
  prMocks.markPullRequestReady.mockResolvedValue({ ok: true })
  prMocks.listPullRequestFiles.mockResolvedValue([])
  prMocks.getPullRequestState.mockResolvedValue({ error: 'not used' })
  propagateMocks.propagateStatusUpwards.mockResolvedValue({
    task: { id: 'task-1', title: 't', status: 'DONE', story_id: 'story-1', implementation_plan: null },
    storyId: 'story-1',
    storyChanged: false,
    pbiChanged: false,
    sprintChanged: false,
    sprintRunChanged: false,
  })
  cascadeMocks.cancelPbiOnFailure.mockResolvedValue({
    cancelled_job_ids: [],
    closed_prs: [],
    reverted_prs: [],
    deleted_branches: [],
    warnings: [],
  })
  effectsMocks.executeEffects.mockResolvedValue([])
  deployJobMocks.maybeEnqueueDeployJob.mockResolvedValue('enqueued')
  mockPrisma.claudeJob.count.mockResolvedValue(0)
  mockPrisma.claudeJob.findMany.mockResolvedValue([])
  mockPrisma.product.findUnique.mockResolvedValue({ auto_pr: true, repo_url: null })
  mockPrisma.task.findUnique.mockResolvedValue({
    title: 'Local LLM taak',
    repo_url: null,
    story: { id: 'story-1', code: 'SCRUM-1', title: 'Story title' },
  })
})

afterEach(() => {
  delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
})

describe('update_job_status: TASK_IMPLEMENTATION jobs van een HARNESS- of local_llm-job', () => {
  it.each(GUARDED_JOBS)("done + $label ⇒ geen maybeCreateAutoPr, geen propagateStatusUpwards; antwoord bevat status:'done' en pushed_at", async ({ job }) => {
    installJobFixture(baseFixture(job))
    mockPrisma.claudeJob.update.mockResolvedValue({
      id: 'job-local-1',
      status: 'DONE',
      branch: 'feat/job-local-1',
      pushed_at: new Date('2026-09-27T09:05:00Z'),
      pr_url: null,
      verify_result: 'ALIGNED',
      summary: 'Klaar.',
      error: null,
      started_at: new Date('2026-09-27T09:00:00Z'),
      finished_at: new Date('2026-09-27T09:05:00Z'),
      head_sha: null,
    })

    const handler = registerHandler()
    const result = (await handler({
      job_id: 'job-local-1',
      status: 'done',
      summary: 'Klaar.',
      branch: 'feat/job-local-1',
    })) as { structuredContent: { status: string; pushed_at: string | null } }

    expect(result).not.toMatchObject({ isError: true })
    expect(result.structuredContent.status).toBe('done')
    expect(result.structuredContent.pushed_at).not.toBeNull()

    // Push blijft (prepareDoneUpdate roept pushBranchForJob aan) en zet
    // pushed_at echt als Date op de jobUpdateData — niet enkel doorgegeven
    // vanuit de gemockte prisma-return.
    expect(pushMocks.pushBranchForJob).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feat/job-local-1' }),
    )
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pushed_at: expect.any(Date) }),
      }),
    )
    // Geen auto-PR: createPullRequest (via maybeCreateAutoPr) nooit aangeroepen.
    expect(mockCreatePr).not.toHaveBeenCalled()
    // Geen doorwerking naar task/story/PBI/sprint.
    expect(mockPropagate).not.toHaveBeenCalled()
  })

  it.each(GUARDED_JOBS)('failed + $label ⇒ geen propagateStatusUpwards, geen cancelPbiOnFailure; sibling onder dezelfde PBI blijft ongemoeid', async ({ job }) => {
    installJobFixture(baseFixture({ ...job, status: 'CLAIMED', branch: null }))
    mockPrisma.claudeJob.update.mockResolvedValue({
      id: 'job-local-1',
      status: 'FAILED',
      branch: null,
      pushed_at: null,
      pr_url: null,
      verify_result: 'ALIGNED',
      summary: null,
      error: 'model faalde',
      started_at: new Date('2026-09-27T09:00:00Z'),
      finished_at: new Date('2026-09-27T09:05:00Z'),
      head_sha: null,
    })

    const handler = registerHandler()
    const result = (await handler({
      job_id: 'job-local-1',
      status: 'failed',
      error: 'model faalde ergens',
    })) as { structuredContent: { status: string } }

    expect(result).not.toMatchObject({ isError: true })
    expect(result.structuredContent.status).toBe('failed')

    expect(mockPropagate).not.toHaveBeenCalled()
    // cancelPbiOnFailure is de ENIGE plek die siblings onder dezelfde PBI
    // cancelt; dit bestand mockt die hele module (zie vi.mock hierboven), dus
    // "nooit aangeroepen" is de volledige assertie — een aparte findMany-check
    // op de (eveneens gemockte) prisma zou niets extra's bewijzen.
    expect(mockCancelPbi).not.toHaveBeenCalled()
  })

  it('regressie zonder local_llm: done roept maybeCreateAutoPr + propagateStatusUpwards nog gewoon aan', async () => {
    installJobFixture(baseFixture({ required_capability: null }))
    mockPrisma.claudeJob.update.mockResolvedValue({
      id: 'job-local-1',
      status: 'DONE',
      branch: 'feat/job-local-1',
      pushed_at: new Date('2026-09-27T09:05:00Z'),
      pr_url: 'https://git.example/org/repo/pulls/9',
      verify_result: 'ALIGNED',
      summary: 'Klaar.',
      error: null,
      started_at: new Date('2026-09-27T09:00:00Z'),
      finished_at: new Date('2026-09-27T09:05:00Z'),
      head_sha: null,
    })

    const handler = registerHandler()
    const result = (await handler({
      job_id: 'job-local-1',
      status: 'done',
      summary: 'Klaar.',
      branch: 'feat/job-local-1',
    })) as { structuredContent: { status: string } }

    expect(result).not.toMatchObject({ isError: true })
    expect(mockCreatePr).toHaveBeenCalledOnce()
    expect(mockPropagate).toHaveBeenCalledOnce()
  })

  it('regressie zonder local_llm: failed roept cancelPbiOnFailure nog gewoon aan', async () => {
    installJobFixture(baseFixture({ required_capability: null, branch: null }))
    mockPrisma.claudeJob.update.mockResolvedValue({
      id: 'job-local-1',
      status: 'FAILED',
      branch: null,
      pushed_at: null,
      pr_url: null,
      verify_result: 'ALIGNED',
      summary: null,
      error: 'model faalde',
      started_at: new Date('2026-09-27T09:00:00Z'),
      finished_at: new Date('2026-09-27T09:05:00Z'),
      head_sha: null,
    })

    const handler = registerHandler()
    const result = (await handler({
      job_id: 'job-local-1',
      status: 'failed',
      error: 'model faalde ergens',
    })) as { structuredContent: { status: string } }

    expect(result).not.toMatchObject({ isError: true })
    expect(mockCancelPbi).toHaveBeenCalledOnce()
  })
})
