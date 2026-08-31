import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $executeRaw: vi.fn(),
    claudeJob: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    product: { findUnique: vi.fn() },
    sprintTaskExecution: { deleteMany: vi.fn() },
  },
}))

vi.mock('../src/git/worktree.js', () => ({
  createWorktreeForJob: vi.fn(),
  removeWorktreeForJob: vi.fn(),
}))

vi.mock('../src/git/branch-safety.js', () => ({ maybeBackupPush: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { createWorktreeForJob, removeWorktreeForJob } from '../src/git/worktree.js'
import { maybeBackupPush } from '../src/git/branch-safety.js'
import { resolveRepoRoot, rollbackClaim, attachWorktreeToJob } from '../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  $executeRaw: ReturnType<typeof vi.fn>
  claudeJob: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  product: { findUnique: ReturnType<typeof vi.fn> }
  sprintTaskExecution: { deleteMany: ReturnType<typeof vi.fn> }
}
const mockCreateWorktree = createWorktreeForJob as ReturnType<typeof vi.fn>
const mockRemoveWorktree = removeWorktreeForJob as ReturnType<typeof vi.fn>
const mockBackupPush = maybeBackupPush as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  // Default: legacy job zonder sprint_run (oude flow).
  mockPrisma.claudeJob.findUnique.mockResolvedValue({ sprint_run_id: null, sprint_run: null })
  mockPrisma.sprintTaskExecution.deleteMany.mockResolvedValue({ count: 0 })
  mockBackupPush.mockResolvedValue('pushed')
})

describe('resolveRepoRoot', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SCRUM4ME_REPO_ROOT_')) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  it('returns value from env var when set', async () => {
    process.env['SCRUM4ME_REPO_ROOT_prod-001'] = '/repos/my-project'
    const result = await resolveRepoRoot('prod-001')
    expect(result).toBe('/repos/my-project')
  })

  it('returns null when no env var and no config file', async () => {
    delete process.env['SCRUM4ME_REPO_ROOT_prod-999']
    // Config file at home won't have this productId in CI
    const result = await resolveRepoRoot('prod-999-nonexistent')
    expect(result).toBeNull()
  })

  it('reads from config file when env var is absent', async () => {
    const configPath = path.join(os.homedir(), '.scrum4me-agent-config.json')
    const config = { repoRoots: { 'prod-config': '/repos/from-config' } }
    let wroteConfig = false
    try {
      await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')
      wroteConfig = true
      delete process.env['SCRUM4ME_REPO_ROOT_prod-config']

      const result = await resolveRepoRoot('prod-config')
      expect(result).toBe('/repos/from-config')
    } finally {
      // Clean up only what we wrote — don't delete if it pre-existed
      if (wroteConfig) {
        try {
          const existing = JSON.parse(await fs.readFile(configPath, 'utf-8'))
          delete existing.repoRoots?.['prod-config']
          if (Object.keys(existing.repoRoots ?? {}).length === 0 && Object.keys(existing).length === 1) {
            await fs.rm(configPath)
          } else {
            await fs.writeFile(configPath, JSON.stringify(existing), 'utf-8')
          }
        } catch {
          await fs.rm(configPath).catch(() => {})
        }
      }
    }
  })
})

describe('attachWorktreeToJob', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SCRUM4ME_REPO_ROOT_')) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  it('returns worktree_path and branch_name on success (no sibling → fresh story branch)', async () => {
    process.env['SCRUM4ME_REPO_ROOT_prod-001'] = '/repos/my-project'
    mockPrisma.claudeJob.findFirst.mockResolvedValue(null)
    mockCreateWorktree.mockResolvedValue({
      worktreePath: '/home/user/.scrum4me-agent-worktrees/job-abc12345',
      branchName: 'feat/story-XXXstory',
    })
    mockPrisma.$executeRaw.mockResolvedValue(0)

    const result = await attachWorktreeToJob('prod-001', 'job-abc12345', 'story-XXXstory')

    expect(result).toEqual({
      worktree_path: '/home/user/.scrum4me-agent-worktrees/job-abc12345',
      branch_name: 'feat/story-XXXstory',
      reused_branch: false,
    })
    expect(mockCreateWorktree).toHaveBeenCalledWith({
      repoRoot: '/repos/my-project',
      jobId: 'job-abc12345',
      branchName: 'feat/story-XXXstory',
      reuseBranch: false,
    })
  })

  it('reuses sibling branch when sibling job already has a branch in same story', async () => {
    process.env['SCRUM4ME_REPO_ROOT_prod-001'] = '/repos/my-project'
    mockPrisma.claudeJob.findFirst.mockResolvedValue({ branch: 'feat/story-existing' })
    mockCreateWorktree.mockResolvedValue({
      worktreePath: '/home/user/.scrum4me-agent-worktrees/job-zzz',
      branchName: 'feat/story-existing',
    })
    mockPrisma.$executeRaw.mockResolvedValue(0)

    const result = await attachWorktreeToJob('prod-001', 'job-zzz', 'story-shared')

    expect(result).toMatchObject({ branch_name: 'feat/story-existing', reused_branch: true })
    expect(mockCreateWorktree).toHaveBeenCalledWith(expect.objectContaining({ reuseBranch: true }))
  })

  it('rolls back claim and returns error when no repoRoot configured', async () => {
    delete process.env['SCRUM4ME_REPO_ROOT_prod-no-root']
    mockPrisma.product.findUnique.mockResolvedValue({ repo_url: null })
    mockPrisma.$executeRaw.mockResolvedValue(0)

    const result = await attachWorktreeToJob('prod-no-root', 'job-xyz', 'story-y')

    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toContain('No repo root configured')
    expect(mockPrisma.$executeRaw).toHaveBeenCalledOnce()
    const sqlParts: string[] = mockPrisma.$executeRaw.mock.calls[0][0]
    expect(sqlParts.join('')).toContain("status = 'QUEUED'")
  })

  it('rolls back claim and returns error when createWorktreeForJob throws', async () => {
    process.env['SCRUM4ME_REPO_ROOT_prod-001'] = '/repos/my-project'
    mockPrisma.claudeJob.findFirst.mockResolvedValue(null)
    mockCreateWorktree.mockRejectedValue(new Error('git fetch failed'))
    mockPrisma.$executeRaw.mockResolvedValue(0)

    const result = await attachWorktreeToJob('prod-001', 'job-fail', 'story-z')

    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toContain('git fetch failed')
    expect(mockPrisma.$executeRaw).toHaveBeenCalledOnce()
    const sqlParts: string[] = mockPrisma.$executeRaw.mock.calls[0][0]
    expect(sqlParts.join('')).toContain("status = 'QUEUED'")
  })
})

describe('rollbackClaim', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('SCRUM4ME_REPO_ROOT_')) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  it('cleans rollback worktrees through task.repo_url when the task lives in another repo', async () => {
    process.env['SCRUM4ME_REPO_ROOT_REPO_scrum4me-mcp'] = '/repos/scrum4me-mcp'
    mockPrisma.claudeJob.findUnique.mockResolvedValueOnce({
      kind: 'TASK_IMPLEMENTATION',
      product_id: 'scrum4me-product',
      task: { repo_url: 'https://git.jp-visser.nl/janpeter/scrum4me-mcp.git' },
    })
    mockPrisma.$executeRaw.mockResolvedValue(0)
    mockRemoveWorktree.mockResolvedValue({ removed: true })

    await rollbackClaim('job-cross-repo', null)

    expect(mockRemoveWorktree).toHaveBeenCalledWith({
      repoRoot: '/repos/scrum4me-mcp',
      jobId: 'job-cross-repo',
    })
  })

  // M38 T6 — spec §3.4: ownership-gefenced en atomisch geordend
  it('rollback is een volledige no-op wanneer de lease-bump 0 rijen raakt', async () => {
    mockPrisma.$executeRaw.mockResolvedValueOnce(0) // bump

    await rollbackClaim('j1', { tokenId: 'tA', instanceId: 'iA' })

    expect(mockPrisma.claudeJob.findUnique).not.toHaveBeenCalled()
    expect(mockRemoveWorktree).not.toHaveBeenCalled()
    // slechts één $executeRaw: de bump zelf
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1)
  })

  it('rollback-volgorde: bump → push → refresh → executions → refresh → cleanup → QUEUED-slotstap', async () => {
    const calls: string[] = []
    mockPrisma.$executeRaw.mockImplementation(async () => {
      calls.push('raw')
      return 1
    })
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      kind: 'SPRINT_IMPLEMENTATION',
      product_id: 'p',
      branch: 'feat/x',
      task: { repo_url: null },
    })
    mockBackupPush.mockImplementation(async () => {
      calls.push('push')
      return 'pushed'
    })
    mockPrisma.sprintTaskExecution.deleteMany.mockImplementation(async () => {
      calls.push('del')
      return { count: 1 }
    })
    mockRemoveWorktree.mockImplementation(async () => {
      calls.push('cleanup')
      return { removed: true }
    })
    process.env['SCRUM4ME_REPO_ROOT_p'] = '/repo'

    await rollbackClaim('j1', { tokenId: 'tA', instanceId: 'iA' })

    // start-bump, push, refresh, executions-delete, refresh, worktree, slotstap
    expect(calls).toEqual(['raw', 'push', 'raw', 'del', 'raw', 'cleanup', 'raw'])
  })

  it('interleaving: eigendom verloren ná de push → geen destructieve stap meer', async () => {
    // 1e raw (start-bump) slaagt; 2e raw (refresh vóór executions) raakt 0 rijen.
    mockPrisma.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      kind: 'SPRINT_IMPLEMENTATION',
      product_id: 'p',
      branch: 'feat/x',
      task: { repo_url: null },
    })
    process.env['SCRUM4ME_REPO_ROOT_p'] = '/repo'

    await rollbackClaim('j1', { tokenId: 'tA', instanceId: 'iA' })

    expect(mockPrisma.sprintTaskExecution.deleteMany).not.toHaveBeenCalled()
    expect(mockRemoveWorktree).not.toHaveBeenCalled()
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2) // géén QUEUED-slotstap
  })

  it('pusht de jobbranch vóór de cleanup, met het job-worktree-pad', async () => {
    process.env['SCRUM4ME_REPO_ROOT_p'] = '/repo'
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    mockPrisma.$executeRaw.mockResolvedValue(1)
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      kind: 'TASK_IMPLEMENTATION',
      product_id: 'p',
      branch: 'feat/story-x',
      task: { repo_url: null },
    })
    mockRemoveWorktree.mockResolvedValue({ removed: true })

    await rollbackClaim('j2', { tokenId: 'tA', instanceId: 'iA' })

    expect(mockBackupPush).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: path.join('/wt', 'j2'),
        branchName: 'feat/story-x',
      }),
    )
  })
})
