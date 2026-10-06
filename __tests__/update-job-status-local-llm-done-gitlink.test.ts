import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

// M45-2b (Taak 3, spec §5.6): alles hieronder geldt ook voor een HARNESS-job
// (isHarnessJob), dus beide tests draaien voor beide soorten job.
//
// Done-pad-regressie (Forgejo-review PR #169, s4m-codex-reviewer BLOCKER):
// een GESLAAGDE local_llm-job draaide in prepareDoneUpdate → pushBranchForJob
// → resolveOriginDefaultRef `git remote set-head` en `git push` met cwd in de
// container-beschrijfbare worktree. SAFE_GIT_CONFIG schakelt core.sshCommand
// en een onvertrouwde remote.origin.url niet uit, dus een door de container
// omgebogen `.git`-gitlink liet de host de configured SSH-command draaien.
//
// De fix: vóór elke git-aanroep in een local_llm-worktree controleert de MCP
// zelf (alleen fs, geen git) dat de gitlink naar de worktree-administratie
// van de vertrouwde clone wijst (assertTrustedWorktreeGitlink). Deze test
// draait de ECHTE update_job_status-handler met de echte push-code en
// dezelfde spy/markerproef als update-job-status-local-llm-chain.test.ts
// (die het failed-pad dekt).
//
// Git is afgeschermd van de globale/system-config via GIT_CONFIG_GLOBAL
// (tijdelijk bestand) en GIT_CONFIG_NOSYSTEM=1.

const authMocks = vi.hoisted(() => ({ requireWriteAccess: vi.fn() }))
const pgMocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }))
const jobLockMocks = vi.hoisted(() => ({ releaseLocksOnTerminal: vi.fn() }))
const pushTriggerMocks = vi.hoisted(() => ({ triggerPush: vi.fn() }))
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
vi.mock('../src/lib/push-trigger.js', () => pushTriggerMocks)
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

// git/push.js, git/branch-safety.js, git/worktree.js en git/local-llm.js
// blijven ECHT (niet gemockt) — zie de uitleg bovenaan dit bestand.
//
// node:child_process blijft ook echt, via dezelfde delegerende spy als
// __tests__/git/local-llm.test.ts: een vi.fn-wrapper die naar de originele
// implementatie delegeert, met een handmatige call-registratie op het
// promisify.custom-pad (nodig omdat promisify(execFileMock) anders de
// ORIGINELE promisified functie teruggeeft en de mock omzeilt — zie die
// test-file's eigen commentaar). We gebruiken deze spy hieronder ZELF om te
// bewijzen dat geen enkele aanroep tijdens de handler-call een cwd binnen de
// worktree had.
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
      update: vi.fn(),
      count: vi.fn(),
    },
  },
}))

import { prisma } from '../src/prisma.js'
import { registerUpdateJobStatusTool } from '../src/tools/update-job-status.js'
import { propagateStatusUpwards } from '../src/lib/tasks-status-update.js'
import { cancelPbiOnFailure } from '../src/cancel/pbi-cascade.js'
import { createWorktreeForJob } from '../src/git/worktree.js'
import { GUARDED_JOBS } from './helpers/guarded-jobs.js'

const exec = promisify(execFile)
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd })
const execMock = vi.mocked(execFile)

const mockPrisma = prisma as unknown as {
  claudeJob: {
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    count: ReturnType<typeof vi.fn>
  }
}
const mockPropagate = propagateStatusUpwards as ReturnType<typeof vi.fn>
const mockCancelPbi = cancelPbiOnFailure as ReturnType<typeof vi.fn>

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
    id: 'local-chain-1',
    status: 'CLAIMED',
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
    branch: null,
    pr_url: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  authMocks.requireWriteAccess.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' })
  pgMocks.connect.mockResolvedValue(undefined)
  pgMocks.query.mockResolvedValue({ rows: [] })
  pgMocks.end.mockResolvedValue(undefined)
  jobLockMocks.releaseLocksOnTerminal.mockResolvedValue(undefined)
  pushTriggerMocks.triggerPush.mockResolvedValue(undefined)
  worktreeQueueMocks.markWorktreeCleanupPending.mockResolvedValue(undefined)
  worktreeQueueMocks.isWorktreeCleanupPending.mockResolvedValue(false)
  worktreeQueueMocks.clearWorktreeCleanupPending.mockResolvedValue(undefined)
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
  mockPrisma.claudeJob.count.mockResolvedValue(0)
})


function tmpfixture() {
  return {} as {
    dir: string; origin: string; clone: string; wtRoot: string; scripts: string
    worktreePath: string; fsmonitorMarker: string; sshMarker: string
  }
}

describe.each(GUARDED_JOBS)('done-pad van een $label: git alleen tegen een vertrouwde worktree-gitlink', ({ job }) => {
  const f = tmpfixture()
  const jobId = 'local-chain-1'
  const branchName = 'feat/local-chain-1'
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = [
    'SCRUM4ME_AGENT_WORKTREE_DIR', 'SCRUM4ME_REPO_ROOT_prod-1',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
  ]

  async function commit(cwd: string, name: string) {
    await fs.writeFile(path.join(cwd, name), name)
    await git(cwd, 'add', '-A')
    await git(cwd, 'commit', '-m', name)
  }

  function callsInWorktree() {
    const wtResolved = path.resolve(f.worktreePath)
    return execMock.mock.calls.filter((call) => {
      const args = call as unknown as [string, string[] | undefined, unknown, unknown?]
      const opts = args[2] as { cwd?: string } | undefined
      const cwd = opts?.cwd
      if (!cwd || typeof cwd !== 'string') return false
      const resolvedCwd = path.resolve(cwd)
      return resolvedCwd === wtResolved || resolvedCwd.startsWith(wtResolved + path.sep)
    })
  }

  function installUpdateEcho() {
    mockPrisma.claudeJob.update.mockImplementation((async (args: {
      data: Record<string, unknown>
    }) => ({
      id: jobId,
      status: args.data.status,
      branch: (args.data.branch as string | undefined) ?? branchName,
      pushed_at: (args.data.pushed_at as Date | undefined) ?? null,
      pr_url: null,
      verify_result: 'ALIGNED',
      summary: (args.data.summary as string | undefined) ?? null,
      error: (args.data.error as string | undefined) ?? null,
      started_at: new Date('2026-09-27T09:00:00Z'),
      finished_at: (args.data.finished_at as Date | undefined) ?? null,
      head_sha: (args.data.head_sha as string | undefined) ?? null,
    })) as never)
  }

  beforeEach(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
    f.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'update-job-status-local-llm-done-'))
    const globalCfg = path.join(f.dir, 'gitconfig-global')
    await fs.writeFile(globalCfg, '[user]\n\temail = t@t\n\tname = t\n[init]\n\tdefaultBranch = main\n')
    process.env.GIT_CONFIG_GLOBAL = globalCfg
    process.env.GIT_CONFIG_NOSYSTEM = '1'

    f.origin = path.join(f.dir, 'origin.git')
    f.clone = path.join(f.dir, 'clone')
    f.wtRoot = path.join(f.dir, 'wt')
    f.scripts = path.join(f.dir, 'scripts')
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = f.wtRoot
    // Expliciete repo-root, zoals op max2 (spec §6): de MCP resolvet de clone
    // met explicitRootsOnly, net als bij de claim.
    process.env['SCRUM4ME_REPO_ROOT_prod-1'] = f.clone

    await exec('git', ['init', '--bare', '-b', 'main', f.origin])
    await exec('git', ['init', '-b', 'main', f.clone])
    await git(f.clone, 'remote', 'add', 'origin', f.origin)
    await commit(f.clone, 'base.txt')
    await git(f.clone, 'push', '-u', 'origin', 'main')

    await fs.mkdir(f.scripts, { recursive: true })
    const fsmonitorScript = path.join(f.scripts, 'fsmonitor.sh')
    const sshScript = path.join(f.scripts, 'ssh.sh')
    f.fsmonitorMarker = path.join(f.dir, 'marker-fsmonitor')
    f.sshMarker = path.join(f.dir, 'marker-ssh')
    await fs.writeFile(
      fsmonitorScript,
      `#!/bin/sh\necho invoked > ${JSON.stringify(f.fsmonitorMarker)}\nexit 0\n`,
    )
    await fs.writeFile(sshScript, `#!/bin/sh\necho invoked > ${JSON.stringify(f.sshMarker)}\nexit 1\n`)
    await fs.chmod(fsmonitorScript, 0o755)
    await fs.chmod(sshScript, 0o755)

    installJobFixture(baseFixture({ id: jobId, branch: branchName, ...job }))
    const created = await createWorktreeForJob({
      repoRoot: f.clone,
      jobId,
      branchName,
      baseRef: 'origin/main',
    })
    f.worktreePath = created.worktreePath
    // Het werk van de job: één commit op de branch (de harness-commit).
    await commit(f.worktreePath, 'work.txt')
  })

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    await fs.rm(f.dir, { recursive: true, force: true })
  })

  it('omgebogen gitlink naar container-administratie in de worktree ⇒ FAILED, geen marker, geen git in de worktree (reviewer-scenario)', async () => {
    // Container-gemaakte administratie BINNEN de worktree, niet-bare met
    // core.worktree=<worktree> zodat git er echt status/push mee kan doen.
    const evilDotGit = path.join(f.worktreePath, '.evil', '.git')
    await exec('git', ['init', '-b', 'main', path.dirname(evilDotGit)])
    const cfg = path.join(evilDotGit, 'config')
    await exec('git', ['config', '--file', cfg, 'core.worktree', f.worktreePath])
    await exec('git', ['config', '--file', cfg, 'core.fsmonitor', path.join(f.scripts, 'fsmonitor.sh')])
    await exec('git', ['config', '--file', cfg, 'core.sshCommand', path.join(f.scripts, 'ssh.sh')])
    await exec('git', ['config', '--file', cfg, 'remote.origin.url', 'ssh://example.invalid/x.git'])
    const emptyTree = execFileSync(
      'git',
      ['--git-dir', evilDotGit, 'hash-object', '-t', 'tree', '--stdin', '-w'],
      { input: '' },
    ).toString().trim()
    const evilCommit = (
      await exec('git', ['--git-dir', evilDotGit, 'commit-tree', emptyTree, '-m', 'evil'])
    ).stdout.trim()
    const evilHead = (
      await exec('git', ['--git-dir', evilDotGit, 'commit-tree', emptyTree, '-p', evilCommit, '-m', 'evil2'])
    ).stdout.trim()
    // origin/main ≠ HEAD, zodat de oude code ook echt tot `git push` komt.
    await exec('git', ['--git-dir', evilDotGit, 'update-ref', 'refs/heads/main', evilCommit])
    await exec('git', ['--git-dir', evilDotGit, 'update-ref', 'refs/remotes/origin/main', evilCommit])
    await exec('git', ['--git-dir', evilDotGit, 'update-ref', `refs/heads/${branchName}`, evilHead])
    await exec('git', ['--git-dir', evilDotGit, 'symbolic-ref', 'HEAD', `refs/heads/${branchName}`])
    await fs.writeFile(path.join(f.worktreePath, '.git'), `gitdir: ${evilDotGit}\n`)

    // Positieve controle: de fixture leeft — status zet fsmonitor, push zet ssh.
    await git(f.worktreePath, 'status').catch(() => {})
    await expect(fs.access(f.fsmonitorMarker)).resolves.toBeUndefined()
    await git(f.worktreePath, 'push', 'origin', 'HEAD:refs/heads/positive-control').catch(() => {})
    await expect(fs.access(f.sshMarker)).resolves.toBeUndefined()
    await fs.rm(f.fsmonitorMarker, { force: true })
    await fs.rm(f.sshMarker, { force: true })

    installUpdateEcho()
    execMock.mockClear()

    const handler = registerHandler()
    const result = (await handler({ job_id: jobId, status: 'done', summary: 'klaar' })) as {
      isError?: boolean
      structuredContent: { status: string; error: string | null; pushed_at: string | null }
    }

    // Eerst de veiligheidsasserties: geen marker en geen git met cwd in de worktree.
    await expect(fs.access(f.sshMarker)).rejects.toThrow()
    await expect(fs.access(f.fsmonitorMarker)).rejects.toThrow()
    expect(callsInWorktree()).toEqual([])

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent.status).toBe('failed')
    expect(result.structuredContent.error).toMatch(
      /^git-administratie van de worktree wijst niet naar de clone \(.+\); geen git uitgevoerd$/,
    )
    expect(result.structuredContent.pushed_at).toBeNull()
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    )

    // Geen push naar origin, geen auto-PR, geen doorwerking, geen cascade.
    const { stdout: remoteRefs } = await git(f.clone, 'ls-remote', 'origin')
    expect(remoteRefs).not.toContain(`refs/heads/${branchName}`)
    expect(prMocks.createPullRequest).not.toHaveBeenCalled()
    expect(mockPropagate).not.toHaveBeenCalled()
    expect(mockCancelPbi).not.toHaveBeenCalled()
  })

  it('onaangetaste worktree ⇒ done pusht naar de lokale bare remote (de controle blokkeert het groene pad niet)', async () => {
    const { stdout: headOut } = await git(f.worktreePath, 'rev-parse', 'HEAD')
    const head = headOut.trim()

    installUpdateEcho()
    execMock.mockClear()

    const handler = registerHandler()
    const result = (await handler({ job_id: jobId, status: 'done', summary: 'klaar' })) as {
      isError?: boolean
      structuredContent: { status: string; error: string | null; pushed_at: string | null }
    }

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent.status).toBe('done')
    expect(result.structuredContent.pushed_at).not.toBeNull()
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DONE', head_sha: head, branch: branchName }),
      }),
    )
    const { stdout: remoteRef } = await exec('git', [
      '--git-dir', f.origin, 'rev-parse', `refs/heads/${branchName}`,
    ])
    expect(remoteRef.trim()).toBe(head)
    // De push zelf draaide met de veilige vlaggen en --no-verify.
    const pushCall = callsInWorktree().find((call) => {
      const args = (call as unknown as [string, string[]])[1]
      return args.includes('push')
    }) as unknown as [string, string[]] | undefined
    expect(pushCall?.[1]).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null', '--no-verify']))
    expect(prMocks.createPullRequest).not.toHaveBeenCalled()
    expect(mockPropagate).not.toHaveBeenCalled()
  })
})
