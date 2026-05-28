import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createWorktreeForJob, removeWorktreeForJob } from '../../src/git/worktree.js'

const exec = promisify(execFile)

async function git(args: string[], cwd: string) {
  return exec('git', args, { cwd })
}

async function setupRepo(): Promise<{ repoDir: string; originDir: string }> {
  const base = os.tmpdir()
  const originDir = await fs.mkdtemp(path.join(base, 'scrum4me-origin-'))
  const repoDir = await fs.mkdtemp(path.join(base, 'scrum4me-repo-'))

  await git(['init', '--bare'], originDir)
  await git(['init'], repoDir)
  await git(['config', 'user.email', 'test@test.com'], repoDir)
  await git(['config', 'user.name', 'Test'], repoDir)
  await git(['remote', 'add', 'origin', originDir], repoDir)
  await fs.writeFile(path.join(repoDir, 'README.md'), '# test')
  await git(['add', '.'], repoDir)
  await git(['commit', '-m', 'init'], repoDir)
  await git(['push', 'origin', 'HEAD:main'], repoDir)

  return { repoDir, originDir }
}

describe('createWorktreeForJob', () => {
  const tmpDirs: string[] = []
  const originalWorktreeDir = process.env.SCRUM4ME_AGENT_WORKTREE_DIR

  afterEach(async () => {
    if (originalWorktreeDir === undefined) {
      delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    } else {
      process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalWorktreeDir
    }
    for (const dir of tmpDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  async function makeWorktreeParent(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrum4me-worktrees-'))
    tmpDirs.push(dir)
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = dir
    return dir
  }

  it('creates a worktree directory with the correct branch as HEAD', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    const wtParent = await makeWorktreeParent()

    const result = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-001',
      branchName: 'feat/job-001',
      baseRef: 'origin/main',
    })

    const stat = await fs.stat(result.worktreePath)
    expect(stat.isDirectory()).toBe(true)

    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], result.worktreePath)
    expect(stdout.trim()).toBe('feat/job-001')

    expect(result.branchName).toBe('feat/job-001')
    expect(result.worktreePath).toBe(path.join(wtParent, 'job-001'))
  })

  it('removes orphan branch and reuses the predictable name when no worktree owns it', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    await makeWorktreeParent()

    // Pre-create an orphan branch (no worktree attached)
    await git(['branch', 'feat/job-002'], repoDir)

    const result = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-002',
      branchName: 'feat/job-002',
      baseRef: 'origin/main',
    })

    // Orphan was deleted → predictable name reused, no timestamp suffix
    expect(result.branchName).toBe('feat/job-002')

    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], result.worktreePath)
    expect(stdout.trim()).toBe('feat/job-002')
  })

  it('rejects when worktree path already exists', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    const wtParent = await makeWorktreeParent()

    const existingPath = path.join(wtParent, 'job-003')
    await fs.mkdir(existingPath)

    await expect(
      createWorktreeForJob({
        repoRoot: repoDir,
        jobId: 'job-003',
        branchName: 'feat/job-003',
        baseRef: 'origin/main',
      }),
    ).rejects.toThrow('Worktree path already exists')
  })

  it('reuseBranch: reuses an existing local branch', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    await makeWorktreeParent()

    // Sibling already created the branch locally.
    await git(['branch', 'feat/sprint-abc', 'origin/main'], repoDir)

    const result = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-reuse-local',
      branchName: 'feat/sprint-abc',
      baseRef: 'origin/main',
      reuseBranch: true,
    })

    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], result.worktreePath)
    expect(stdout.trim()).toBe('feat/sprint-abc')
    expect(result.branchName).toBe('feat/sprint-abc')
  })

  it('reuseBranch: recreates a local branch from origin when only the remote has it', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    await makeWorktreeParent()

    // Branch exists on origin (a sibling pushed it, or the container was
    // recreated and the local clone is fresh) but not as a local branch.
    await git(['branch', 'feat/sprint-xyz', 'origin/main'], repoDir)
    await git(['push', 'origin', 'feat/sprint-xyz'], repoDir)
    await git(['branch', '-D', 'feat/sprint-xyz'], repoDir)

    const result = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-reuse-origin',
      branchName: 'feat/sprint-xyz',
      baseRef: 'origin/main',
      reuseBranch: true,
    })

    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], result.worktreePath)
    expect(stdout.trim()).toBe('feat/sprint-xyz')
  })

  it('reuseBranch: uses the current origin tip, not a stale local branch', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    await makeWorktreeParent()

    // Branch exists on origin AND locally, both at the initial commit.
    await git(['branch', 'feat/story-x', 'origin/main'], repoDir)
    await git(['push', 'origin', 'feat/story-x'], repoDir)

    // Another worker advances origin/feat/story-x; this clone's local ref stays behind.
    const clone2 = await fs.mkdtemp(path.join(os.tmpdir(), 'scrum4me-clone2-'))
    tmpDirs.push(clone2)
    await git(['clone', originDir, clone2], os.tmpdir())
    await git(['config', 'user.email', 'c2@test.com'], clone2)
    await git(['config', 'user.name', 'C2'], clone2)
    await git(['checkout', 'feat/story-x'], clone2)
    await fs.writeFile(path.join(clone2, 'c2.txt'), 'c2')
    await git(['add', '.'], clone2)
    await git(['commit', '-m', 'C2 from another worker'], clone2)
    await git(['push', 'origin', 'feat/story-x'], clone2)
    const { stdout: c2sha } = await git(['rev-parse', 'HEAD'], clone2)

    const result = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-reuse-stale-local',
      branchName: 'feat/story-x',
      baseRef: 'origin/main',
      reuseBranch: true,
    })

    const { stdout: head } = await git(['rev-parse', 'HEAD'], result.worktreePath)
    expect(head.trim()).toBe(c2sha.trim())
  })

  it('reuseBranch: falls back to a fresh branch when it exists nowhere (cross-repo sprint)', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    await makeWorktreeParent()

    // reuseBranch is decided sprint-wide; for the first job targeting THIS
    // repo the branch exists neither locally nor on origin. Must not throw
    // "invalid reference" — should create it fresh from baseRef.
    const result = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-reuse-fresh',
      branchName: 'feat/sprint-newrepo',
      baseRef: 'origin/main',
      reuseBranch: true,
    })

    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], result.worktreePath)
    expect(stdout.trim()).toBe('feat/sprint-newrepo')
    expect(result.branchName).toBe('feat/sprint-newrepo')
  })
})

describe('removeWorktreeForJob', () => {
  const tmpDirs: string[] = []
  const originalWorktreeDir = process.env.SCRUM4ME_AGENT_WORKTREE_DIR

  afterEach(async () => {
    if (originalWorktreeDir === undefined) {
      delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    } else {
      process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalWorktreeDir
    }
    for (const dir of tmpDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  async function makeWorktreeParent(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrum4me-worktrees-'))
    tmpDirs.push(dir)
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = dir
    return dir
  }

  it('removes worktree directory and deletes branch by default', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    const wtParent = await makeWorktreeParent()

    const { worktreePath, branchName } = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-rm-01',
      branchName: 'feat/job-rm-01',
      baseRef: 'origin/main',
    })

    const result = await removeWorktreeForJob({ repoRoot: repoDir, jobId: 'job-rm-01' })

    expect(result.removed).toBe(true)
    await expect(fs.access(worktreePath)).rejects.toThrow()
    await expect(fs.access(path.join(wtParent, 'job-rm-01'))).rejects.toThrow()

    // Branch should be deleted
    await expect(
      exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
        cwd: repoDir,
      }),
    ).rejects.toThrow()
  })

  it('removes worktree directory but keeps branch when keepBranch=true', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    const wtParent = await makeWorktreeParent()

    const { worktreePath, branchName } = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-rm-02',
      branchName: 'feat/job-rm-02',
      baseRef: 'origin/main',
    })

    const result = await removeWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-rm-02',
      keepBranch: true,
    })

    expect(result.removed).toBe(true)
    await expect(fs.access(worktreePath)).rejects.toThrow()
    await expect(fs.access(path.join(wtParent, 'job-rm-02'))).rejects.toThrow()

    // Branch should still exist
    const { stdout } = await exec(
      'git',
      ['show-ref', '--verify', `refs/heads/${branchName}`],
      { cwd: repoDir },
    )
    expect(stdout).toContain(branchName)
  })

  it('returns { removed: false } when worktree does not exist', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    await makeWorktreeParent()

    const result = await removeWorktreeForJob({ repoRoot: repoDir, jobId: 'job-rm-nonexistent' })

    expect(result.removed).toBe(false)
  })

  it('force-removes a leftover directory that git does not track as a worktree', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    const wtParent = await makeWorktreeParent()

    // A partially-failed `git worktree add`, a manual leftover, or a container
    // recreate can leave a plain directory at the job's worktree path that git
    // has no registration for. `git worktree remove` then errors; cleanup must
    // still delete the directory so a later claim doesn't loop forever on
    // "Worktree path already exists".
    const leftover = path.join(wtParent, 'job-orphan-dir')
    await fs.mkdir(leftover, { recursive: true })
    await fs.writeFile(path.join(leftover, 'stale.txt'), 'leftover')

    const result = await removeWorktreeForJob({ repoRoot: repoDir, jobId: 'job-orphan-dir' })

    expect(result.removed).toBe(true)
    await expect(fs.access(leftover)).rejects.toThrow()
  })
})
