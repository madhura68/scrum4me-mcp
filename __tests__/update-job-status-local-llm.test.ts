import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

// Taak 5 (M3-plan): update_job_status slaat maybeCreateAutoPr,
// propagateStatusUpwards en cancelPbiOnFailure over voor
// kind=TASK_IMPLEMENTATION jobs met required_capability='local_llm' — de
// harness beheert de taakstatus zelf en de Claude-sessie mergt de branch met
// de hand. Push bij done, de verify-gate, de jobvelden en de antwoord-JSON
// blijven ongewijzigd (Taak 3 regelt de backup-push-skip al via
// maybeBackupPush/branch-safety.ts).

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

// NB: git/branch-safety.js, git/worktree.js en git/local-llm.js blijven
// ECHT (niet gemockt) — dit bestand test juist dat die keten intact blijft
// voor local_llm-jobs. node:child_process blijft ook echt (delegerende spy,
// zie __tests__/git/local-llm.test.ts): git-aanroepen zonder bestaande
// worktree op schijf falen simpelweg stil (ENOENT), precies zoals het
// bestaande gedrag vóór deze taak (zie update-job-status-push.test.ts).
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
import { createWorktreeForJob } from '../src/git/worktree.js'

const exec = promisify(execFile)
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd })

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
// keten (initiële job-select, assertUnmanagedJob*, isLocalLlmJob) vraagt om
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

describe('update_job_status: local_llm TASK_IMPLEMENTATION jobs', () => {
  it("done + local_llm ⇒ geen maybeCreateAutoPr, geen propagateStatusUpwards; antwoord bevat status:'done' en pushed_at", async () => {
    installJobFixture(baseFixture())
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

    // Push blijft (prepareDoneUpdate roept pushBranchForJob aan).
    expect(pushMocks.pushBranchForJob).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feat/job-local-1' }),
    )
    // Geen auto-PR: createPullRequest (via maybeCreateAutoPr) nooit aangeroepen.
    expect(mockCreatePr).not.toHaveBeenCalled()
    // Geen doorwerking naar task/story/PBI/sprint.
    expect(mockPropagate).not.toHaveBeenCalled()
  })

  it('failed + local_llm ⇒ geen propagateStatusUpwards, geen cancelPbiOnFailure; sibling onder dezelfde PBI blijft ongemoeid', async () => {
    installJobFixture(baseFixture({ status: 'CLAIMED', branch: null }))
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
    expect(mockCancelPbi).not.toHaveBeenCalled()
    // cancelPbiOnFailure is de ENIGE plek die siblings onder dezelfde PBI
    // cancelt (via prisma.claudeJob.updateMany binnen die module) — nooit
    // aangeroepen ⇒ een tweede actieve job onder dezelfde PBI blijft actief.
    expect(mockPrisma.claudeJob.findMany).not.toHaveBeenCalled()
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

// Keten-test (brief Taak 5): echte branch-safety/worktree/local-llm-modules,
// een echte tijdelijke repo met omgebogen gitlink + markers (Taak 3-fixture),
// prisma gemockt met een local_llm-job. Bewijst dat het failed-pad van de
// ECHTE handler (niet alleen maybeBackupPush in isolatie) nooit git draait
// in de worktree van een local_llm-job.
//
// Bekende zwakte uit de Taak 3-review: een BARE evil-gitdir zonder
// core.worktree maakt de fsmonitor-helft onbewijsbaar (git weigert `status`
// in een bare repo zonder work-tree vóórdat de hook ooit geraakt wordt).
// Deze test gebruikt daarom een NIET-bare evil-gitdir met expliciete
// core.worktree=<worktree>, en bewijst eerst met een POSITIEVE controle
// (een directe `git status`/`git push` in die worktree) dat beide markers
// écht kunnen vuren — pas dan telt de afwezigheid van markers na de handler
// als bewijs.
describe('local_llm-keten: update_job_status(failed) draait nooit git in de worktree (markerproef)', () => {
  let dir: string, origin: string, clone: string, wtRoot: string, scripts: string
  let worktreePath: string, evilGitDir: string, evilDotGit: string
  let fsmonitorMarker: string, sshMarker: string
  const jobId = 'local-chain-1'
  const branchName = 'feat/local-chain-1'

  async function commit(cwd: string, name: string) {
    await fs.writeFile(path.join(cwd, name), name)
    await git(cwd, 'add', '-A')
    await git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', name)
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'update-job-status-local-llm-'))
    origin = path.join(dir, 'origin.git')
    clone = path.join(dir, 'clone')
    wtRoot = path.join(dir, 'wt')
    scripts = path.join(dir, 'scripts')
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = wtRoot

    await exec('git', ['init', '--bare', '-b', 'main', origin])
    await exec('git', ['init', '-b', 'main', clone])
    await git(clone, 'remote', 'add', 'origin', origin)
    await commit(clone, 'base.txt')
    await git(clone, 'push', '-u', 'origin', 'main')

    await fs.mkdir(scripts, { recursive: true })
    const fsmonitorScript = path.join(scripts, 'fsmonitor.sh')
    const sshScript = path.join(scripts, 'ssh.sh')
    fsmonitorMarker = path.join(dir, 'marker-fsmonitor')
    sshMarker = path.join(dir, 'marker-ssh')
    await fs.writeFile(
      fsmonitorScript,
      `#!/bin/sh\necho invoked > ${JSON.stringify(fsmonitorMarker)}\nexit 0\n`,
    )
    await fs.writeFile(
      sshScript,
      `#!/bin/sh\necho invoked > ${JSON.stringify(sshMarker)}\nexit 1\n`,
    )
    await fs.chmod(fsmonitorScript, 0o755)
    await fs.chmod(sshScript, 0o755)

    const created = await createWorktreeForJob({
      repoRoot: clone,
      jobId,
      branchName,
      baseRef: 'origin/main',
    })
    worktreePath = created.worktreePath

    // Niet-bare evil-gitdir MET expliciete core.worktree=<worktree> — in
    // tegenstelling tot Task 3's bare fixture kan git hier daadwerkelijk
    // `status`/`push` uitvoeren tegen de echte worktree-inhoud.
    evilGitDir = path.join(dir, 'evil-git-admin')
    evilDotGit = path.join(evilGitDir, '.git')
    await exec('git', ['init', '-b', 'main', evilGitDir])
    await exec('git', ['config', '--file', path.join(evilDotGit, 'config'), 'core.worktree', worktreePath])
    await exec('git', [
      'config', '--file', path.join(evilDotGit, 'config'), 'core.fsmonitor', fsmonitorScript,
    ])
    await exec('git', [
      'config', '--file', path.join(evilDotGit, 'config'), 'core.sshCommand', sshScript,
    ])
    await exec('git', [
      'config', '--file', path.join(evilDotGit, 'config'), 'remote.origin.url', 'ssh://example.invalid/x',
    ])
    const evilEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'evil', GIT_AUTHOR_EMAIL: 'evil@evil',
      GIT_COMMITTER_NAME: 'evil', GIT_COMMITTER_EMAIL: 'evil@evil',
    }
    const emptyTree = execFileSync(
      'git',
      ['--git-dir', evilDotGit, 'hash-object', '-t', 'tree', '--stdin', '-w'],
      { input: '' },
    ).toString().trim()
    const evilCommit = (
      await exec('git', ['--git-dir', evilDotGit, 'commit-tree', emptyTree, '-m', 'evil'], { env: evilEnv })
    ).stdout.trim()
    await exec('git', ['--git-dir', evilDotGit, 'update-ref', 'refs/heads/main', evilCommit])
    // Omgebogen gitlink: worktreePath/.git wijst naar de niet-bare evil-gitdir.
    await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${evilDotGit}\n`)
  })

  afterEach(async () => {
    delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('positieve controle: git status/push in deze worktree zet écht beide markers (bewijst dat de fixture leeft)', async () => {
    await git(worktreePath, 'status').catch(() => {})
    await expect(fs.access(fsmonitorMarker)).resolves.toBeUndefined()

    await git(worktreePath, 'push', 'origin', 'HEAD:refs/heads/positive-control-x').catch(() => {})
    await expect(fs.access(sshMarker)).resolves.toBeUndefined()
  })

  it('update_job_status(failed) op een local_llm-job laat geen marker achter', async () => {
    // Bewijs eerst dat de fixture leeft (zelfde proef als de vorige test,
    // herhaald binnen déze test zodat de volgorde van assertions niet
    // afhangt van test-isolatie tussen `it`-blocks).
    await git(worktreePath, 'status').catch(() => {})
    await expect(fs.access(fsmonitorMarker)).resolves.toBeUndefined()
    await git(worktreePath, 'push', 'origin', 'HEAD:refs/heads/positive-control-y').catch(() => {})
    await expect(fs.access(sshMarker)).resolves.toBeUndefined()

    // Reset de markers — vanaf hier mag niets ze opnieuw aanmaken.
    await fs.rm(fsmonitorMarker, { force: true })
    await fs.rm(sshMarker, { force: true })

    installJobFixture(
      baseFixture({
        id: jobId,
        branch: branchName,
        status: 'CLAIMED',
      }),
    )
    mockPrisma.claudeJob.update.mockResolvedValue({
      id: jobId,
      status: 'FAILED',
      branch: branchName,
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
      job_id: jobId,
      status: 'failed',
      error: 'model faalde ergens onderweg',
    })) as { structuredContent: { status: string } }

    expect(result).not.toMatchObject({ isError: true })
    expect(result.structuredContent.status).toBe('failed')

    await expect(fs.access(fsmonitorMarker)).rejects.toThrow()
    await expect(fs.access(sshMarker)).rejects.toThrow()

    expect(mockPropagate).not.toHaveBeenCalled()
    expect(mockCancelPbi).not.toHaveBeenCalled()
  })
})
