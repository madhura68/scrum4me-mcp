import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  registerJobLockReleases,
  releaseLocksOnTerminal,
  setupProductWorktrees,
  _resetJobReleasesForTest,
} from '../../src/git/job-locks.js'

const exec = promisify(execFile)

describe('job-locks: registerJobLockReleases + releaseLocksOnTerminal', () => {
  beforeEach(() => _resetJobReleasesForTest())

  it('releaseLocksOnTerminal for unknown job is a no-op', async () => {
    await expect(releaseLocksOnTerminal('nonexistent')).resolves.toBeUndefined()
  })

  it('runs registered releases and clears the entry', async () => {
    const release = vi.fn().mockResolvedValue(undefined)
    registerJobLockReleases('job-1', [release])
    await releaseLocksOnTerminal('job-1')
    expect(release).toHaveBeenCalledTimes(1)
    // Second call → no-op (cleared)
    await releaseLocksOnTerminal('job-1')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('failures in one release do not abort others', async () => {
    const r1 = vi.fn().mockRejectedValue(new Error('boom'))
    const r2 = vi.fn().mockResolvedValue(undefined)
    registerJobLockReleases('job-2', [r1, r2])
    await expect(releaseLocksOnTerminal('job-2')).resolves.toBeUndefined()
    expect(r1).toHaveBeenCalled()
    expect(r2).toHaveBeenCalled()
  })

  it('append-mode: multiple registers accumulate', async () => {
    const r1 = vi.fn().mockResolvedValue(undefined)
    const r2 = vi.fn().mockResolvedValue(undefined)
    registerJobLockReleases('job-3', [r1])
    registerJobLockReleases('job-3', [r2])
    await releaseLocksOnTerminal('job-3')
    expect(r1).toHaveBeenCalledTimes(1)
    expect(r2).toHaveBeenCalledTimes(1)
  })
})

describe('job-locks: setupProductWorktrees', () => {
  let tmpRoot: string
  let originalEnv: string | undefined
  let bareRepo: string
  let originRepo: string

  beforeEach(async () => {
    _resetJobReleasesForTest()
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'job-locks-'))
    originalEnv = process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = path.join(tmpRoot, 'agent-worktrees')

    // Set up a bare repo as origin and a clone with origin/main
    bareRepo = path.join(tmpRoot, 'origin.git')
    await exec('git', ['init', '--bare', '-b', 'main', bareRepo])

    originRepo = path.join(tmpRoot, 'work')
    await exec('git', ['init', '-b', 'main', originRepo])
    await exec('git', ['config', 'user.email', 't@t.local'], { cwd: originRepo })
    await exec('git', ['config', 'user.name', 'Test'], { cwd: originRepo })
    await exec('git', ['remote', 'add', 'origin', bareRepo], { cwd: originRepo })
    await fs.writeFile(path.join(originRepo, 'README.md'), '# init\n')
    await exec('git', ['add', '-A'], { cwd: originRepo })
    await exec('git', ['commit', '-m', 'init'], { cwd: originRepo })
    await exec('git', ['push', '-u', 'origin', 'main'], { cwd: originRepo })
  })

  afterEach(async () => {
    if (originalEnv) process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv
    else delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('returns empty when productIds is empty', async () => {
    const result = await setupProductWorktrees('j1', [], async () => null)
    expect(result).toEqual([])
  })

  it('creates a product-worktree, registers a lock-release, and releases it', async () => {
    const result = await setupProductWorktrees('j2', ['prod-a'], async () => originRepo)
    expect(result).toHaveLength(1)
    expect(result[0].productId).toBe('prod-a')
    expect(result[0].worktreePath).toContain('_products/prod-a')

    // Worktree dir exists with detached HEAD on origin/main
    const stat = await fs.stat(result[0].worktreePath)
    expect(stat.isDirectory()).toBe(true)

    // Lockfile is held during the job (proper-lockfile creates a .lock dir)
    const lockDir = path.join(
      process.env.SCRUM4ME_AGENT_WORKTREE_DIR!,
      '_products',
      'prod-a.lock.lock',
    )
    const lockStat = await fs.stat(lockDir).catch(() => null)
    expect(lockStat).not.toBeNull()

    await releaseLocksOnTerminal('j2')
    const lockAfter = await fs.stat(lockDir).catch(() => null)
    expect(lockAfter).toBeNull()
  })

  it('skips products where resolveRepoRoot returns null', async () => {
    const result = await setupProductWorktrees('j3', ['no-repo'], async () => null)
    expect(result).toEqual([])
    // Lock was still acquired and registered — release cleans up
    await releaseLocksOnTerminal('j3')
  })

  it('output preserves input order regardless of alphabetical lock-acquire order', async () => {
    // 'z-primary' sorts AFTER 'a-secondary' alphabetically, but caller passes
    // primary first → output[0] must be 'z-primary' so wait_for_job's
    // primary_worktree_path = worktrees[0]?.worktreePath points at the right repo.
    const result = await setupProductWorktrees(
      'j4',
      ['z-primary', 'a-secondary'],
      async () => originRepo,
    )
    expect(result).toHaveLength(2)
    expect(result[0].productId).toBe('z-primary')
    expect(result[1].productId).toBe('a-secondary')
    await releaseLocksOnTerminal('j4')
  })
})
