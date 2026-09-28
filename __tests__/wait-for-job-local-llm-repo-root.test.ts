// P13 (controller ruling, M3 whole-branch review, wave-2 Opus finding):
// attachWorktreeToJob resolved a local_llm job's repo root with
// allowOnDemandClone: true, exactly like any other job. Without an explicitly
// configured SCRUM4ME_REPO_ROOT_* root, that let a local_llm job clone into
// ~/Projects/<name> and run `npm ci` (with lifecycle scripts, the host's own
// DATABASE_URL/Forgejo credentials) — the Global Constraint that repo code
// never runs on the host for a local_llm job (spec §4.5/§5/§6). These tests
// pin the fix: a local_llm job resolves ONLY from an explicitly configured
// root, and never touches cloneRepoOnDemand or rollbackClaim when none exists.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'

// vi.mock factories are hoisted, so the mock fn must be created via vi.hoisted.
const { cloneMock } = vi.hoisted(() => ({ cloneMock: vi.fn() }))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $executeRaw: vi.fn(),
    claudeJob: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    product: { findUnique: vi.fn() },
    sprintTaskExecution: { deleteMany: vi.fn() },
  },
}))

// cloneRepoOnDemand is mocked (never let a test hit the real filesystem/git);
// the real error classes are kept so resolveRepoRoot's instanceof checks work.
vi.mock('../src/git/on-demand-clone.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/git/on-demand-clone.js')>()
  return { ...actual, cloneRepoOnDemand: cloneMock }
})

// createWorktreeForJob/removeWorktreeForJob stay mocked (no real git in these
// tests); LocalLlmWorktreeRefused stays the real class (not exercised here,
// but attachWorktreeToJob's `instanceof` check must still see the real ctor).
vi.mock('../src/git/worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/git/worktree.js')>()
  return { ...actual, createWorktreeForJob: vi.fn(), removeWorktreeForJob: vi.fn() }
})

vi.mock('../src/git/branch-safety.js', () => ({ maybeBackupPush: vi.fn() }))

type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { createWorktreeForJob } from '../src/git/worktree.js'
import { attachWorktreeToJob } from '../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  $executeRaw: ReturnType<typeof vi.fn>
  claudeJob: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  product: { findUnique: ReturnType<typeof vi.fn> }
}
const mockCreateWorktree = createWorktreeForJob as ReturnType<typeof vi.fn>
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>

const LOCAL_PRODUCT_ID = 'prod-local-llm-repo-root-zzz'
const NORMAL_PRODUCT_ID = 'prod-normal-repo-root-zzz'
const PRODUCT_REPO = 'https://git.jp-visser.nl/janpeter/repo-root-zzz-nonexistent.git'

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.claudeJob.findFirst.mockResolvedValue(null)
  mockPrisma.claudeJob.update.mockResolvedValue({})
  mockPrisma.product.findUnique.mockResolvedValue({ repo_url: PRODUCT_REPO })
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) =>
    cb(null, { stdout: 'deadbeef\n', stderr: '' }),
  )
})

describe('attachWorktreeToJob: local_llm-job zonder repo-root (P13)', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SCRUM4ME_REPO_ROOT_')) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  it('markeert de job FAILED i.p.v. on-demand clone op de host wanneer geen root geconfigureerd is', async () => {
    delete process.env[`SCRUM4ME_REPO_ROOT_${LOCAL_PRODUCT_ID}`]
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      sprint_run_id: null,
      sprint_run: null,
      required_capability: 'local_llm',
    })

    const result = await attachWorktreeToJob(LOCAL_PRODUCT_ID, 'job-local-no-root', 'story-x')

    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toBe(
      `geen repo-root voor product ${LOCAL_PRODUCT_ID} op deze host ` +
        '(local_llm vereist een expliciete SCRUM4ME_REPO_ROOT_*)',
    )
    // Never clones/runs npm ci on the host for a local_llm job.
    expect(cloneMock).not.toHaveBeenCalled()
    // Never creates a worktree either.
    expect(mockCreateWorktree).not.toHaveBeenCalled()
    // FAILED, not rolled back to QUEUED (that would hot-loop claim → fail → rollback).
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith({
      where: { id: 'job-local-no-root' },
      data: expect.objectContaining({ status: 'FAILED' }),
    })
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
  })

  it('local_llm-job MET een expliciet geconfigureerde root claimt gewoon (geen clone nodig)', async () => {
    process.env[`SCRUM4ME_REPO_ROOT_${LOCAL_PRODUCT_ID}`] = '/repos/my-local-project'
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      sprint_run_id: null,
      sprint_run: null,
      required_capability: 'local_llm',
    })
    mockCreateWorktree.mockResolvedValue({
      worktreePath: '/wt-root/job-local-with-root',
      branchName: 'feat/story-x',
    })

    const result = await attachWorktreeToJob(LOCAL_PRODUCT_ID, 'job-local-with-root', 'story-x')

    expect('worktree_path' in result).toBe(true)
    expect(cloneMock).not.toHaveBeenCalled()
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: '/repos/my-local-project' }),
    )
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
  })

  it('regressiebewaker: een NIET-lokale job zonder geconfigureerde root behoudt het on-demand-clone-pad (zelfde aanroep, zelfde opties)', async () => {
    delete process.env[`SCRUM4ME_REPO_ROOT_${NORMAL_PRODUCT_ID}`]
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      sprint_run_id: null,
      sprint_run: null,
      required_capability: null,
    })
    cloneMock.mockResolvedValue('/cloned/repo-root-zzz-nonexistent')
    mockCreateWorktree.mockResolvedValue({
      worktreePath: '/wt-root/job-normal-no-root',
      branchName: 'feat/story-x',
    })

    const result = await attachWorktreeToJob(NORMAL_PRODUCT_ID, 'job-normal-no-root', 'story-x')

    expect('worktree_path' in result).toBe(true)
    expect(cloneMock).toHaveBeenCalledTimes(1)
    expect(cloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: PRODUCT_REPO,
        name: 'repo-root-zzz-nonexistent',
        ownerCtx: null,
      }),
    )
    expect(mockCreateWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: '/cloned/repo-root-zzz-nonexistent' }),
    )
  })
})
