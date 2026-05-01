import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createWorktreeForJob } from '../../src/git/worktree.js'

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

  it('suffixes branch name with timestamp when branch already exists', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    await makeWorktreeParent()

    await git(['branch', 'feat/job-002'], repoDir)

    const result = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-002',
      branchName: 'feat/job-002',
      baseRef: 'origin/main',
    })

    expect(result.branchName).toMatch(/^feat\/job-002-\d+$/)

    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], result.worktreePath)
    expect(stdout.trim()).toBe(result.branchName)
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
})
