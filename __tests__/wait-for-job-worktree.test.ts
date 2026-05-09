import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $executeRaw: vi.fn(),
    claudeJob: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    product: { findUnique: vi.fn() },
  },
}))

vi.mock('../src/git/worktree.js', () => ({
  createWorktreeForJob: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { createWorktreeForJob } from '../src/git/worktree.js'
import { resolveRepoRoot, rollbackClaim, attachWorktreeToJob } from '../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  $executeRaw: ReturnType<typeof vi.fn>
  claudeJob: { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  product: { findUnique: ReturnType<typeof vi.fn> }
}
const mockCreateWorktree = createWorktreeForJob as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  // Default: legacy job zonder sprint_run (oude flow).
  mockPrisma.claudeJob.findUnique.mockResolvedValue({ sprint_run_id: null, sprint_run: null })
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
