import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

// Alleen de bewaakte-job-tests hieronder lezen de job uit de database (het worktree-pad ligt dan onder de
// worktree-root); voor elk ander pad raakt maybeBackupPush de database niet.
vi.mock('../src/prisma.js', () => ({
  prisma: { claudeJob: { findUnique: vi.fn() } },
}))

import { prisma } from '../src/prisma.js'
import {
  resolveWorktreeHead,
  maybeBackupPush,
  maybeBackupPushBranch,
  localTipContainedInRemote,
  remoteTipMergedIntoMain,
} from '../src/git/branch-safety.js'
import { GUARDED_JOBS, ORDINARY_JOB } from './helpers/guarded-jobs.js'

const exec = promisify(execFile)
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd })

let dir: string, origin: string, clone: string

async function commit(cwd: string, name: string) {
  await fs.writeFile(path.join(cwd, name), name)
  await git(cwd, 'add', '-A')
  await git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', name)
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-safety-'))
  origin = path.join(dir, 'origin.git')
  clone = path.join(dir, 'clone')
  await exec('git', ['init', '--bare', '-b', 'main', origin])
  await exec('git', ['init', '-b', 'main', clone])
  await git(clone, 'remote', 'add', 'origin', origin)
  await commit(clone, 'base.txt')
  await git(clone, 'push', '-u', 'origin', 'main')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('resolveWorktreeHead', () => {
  it('geeft de HEAD-sha van de worktree', async () => {
    const { stdout } = await git(clone, 'rev-parse', 'HEAD')
    expect(await resolveWorktreeHead(clone)).toBe(stdout.trim())
  })
  it('geeft null buiten een repo', async () => {
    expect(await resolveWorktreeHead(dir)).toBeNull()
  })
})

describe('maybeBackupPush', () => {
  it('pusht een branch met nieuw werk naar origin', async () => {
    await git(clone, 'checkout', '-b', 'feat/x')
    await commit(clone, 'w1.txt')
    const r = await maybeBackupPush({ worktreePath: clone, branchName: 'feat/x', context: 't' })
    expect(r).toBe('pushed')
    const { stdout } = await exec('git', ['ls-remote', origin, 'refs/heads/feat/x'])
    expect(stdout.trim()).not.toBe('')
  })
  it('meldt up-to-date wanneer origin de tip al heeft', async () => {
    await git(clone, 'checkout', '-b', 'feat/x')
    await commit(clone, 'w1.txt')
    await git(clone, 'push', '-u', 'origin', 'feat/x')
    const r = await maybeBackupPush({ worktreePath: clone, branchName: 'feat/x', context: 't' })
    expect(r).toBe('up-to-date')
  })
  it('throwt nooit bij een kapot pad', async () => {
    const r = await maybeBackupPush({
      worktreePath: path.join(dir, 'nope'),
      branchName: 'x',
      context: 't',
    })
    expect(r).toBe('skipped')
  })
})

// Spec §4.5/§5.3: voor een bewaakte job (HARNESS of local_llm) draait de MCP geen git met de worktree als werkmap
// buiten de claim en het groene pad; de backup-push slaat dan over. De job-id komt uit het pad
// (<worktree-root>/<job-id>); of de job bewaakt is, beslist de database.
describe('maybeBackupPush: bewaakte jobs', () => {
  const originalEnv = process.env.SCRUM4ME_AGENT_WORKTREE_DIR

  beforeEach(() => {
    // `clone` ligt direct onder `dir`: met dir als worktree-root is `clone` de jobworktree van de job 'clone'.
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = dir
  })
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    else process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv
    vi.mocked(prisma.claudeJob.findUnique).mockReset()
  })

  function mockJob(row: { runtime: string; required_capability: string | null }) {
    vi.mocked(prisma.claudeJob.findUnique).mockImplementation((async (args: { where: { id: string } }) =>
      args.where.id === 'clone' ? row : null) as never)
  }

  it.each(GUARDED_JOBS)('slaat een $label over: geen push naar origin', async ({ job }) => {
    mockJob(job)
    await git(clone, 'checkout', '-b', 'feat/x')
    await commit(clone, 'w1.txt')

    const r = await maybeBackupPush({ worktreePath: clone, branchName: 'feat/x', context: 't' })

    expect(r).toBe('skipped')
    const { stdout } = await exec('git', ['ls-remote', origin, 'refs/heads/feat/x'])
    expect(stdout.trim()).toBe('')
  })

  it('controle: dezelfde opzet met een gewone job pusht wél', async () => {
    mockJob(ORDINARY_JOB)
    await git(clone, 'checkout', '-b', 'feat/x')
    await commit(clone, 'w1.txt')

    const r = await maybeBackupPush({ worktreePath: clone, branchName: 'feat/x', context: 't' })

    expect(r).toBe('pushed')
    const { stdout } = await exec('git', ['ls-remote', origin, 'refs/heads/feat/x'])
    expect(stdout.trim()).not.toBe('')
  })
})

describe('maybeBackupPushBranch', () => {
  it('pusht een voorliggende branch óók wanneer de clone op main staat en origin/<branch> == main', async () => {
    // origin/feat/x aanmaken op de main-tip, dan lokaal op feat/x één commit
    // vóór, en terug naar main — cwd-HEAD == origin/feat/x, branch-tip niet.
    await git(clone, 'checkout', '-b', 'feat/x')
    await git(clone, 'push', '-u', 'origin', 'feat/x') // origin/feat/x == main
    await commit(clone, 'ahead.txt')
    const tip = (await git(clone, 'rev-parse', 'feat/x')).stdout.trim()
    await git(clone, 'checkout', 'main')
    const r = await maybeBackupPushBranch({ repoRoot: clone, branchName: 'feat/x', context: 't' })
    expect(r).toBe('pushed')
    const { stdout } = await exec('git', ['ls-remote', origin, 'refs/heads/feat/x'])
    expect(stdout.trim().split(/\s+/)[0]).toBe(tip)
  })
  it('meldt up-to-date wanneer de tracking-ref al op de branch-tip staat', async () => {
    await git(clone, 'checkout', '-b', 'feat/x')
    await commit(clone, 'w.txt')
    await git(clone, 'push', '-u', 'origin', 'feat/x')
    await git(clone, 'checkout', 'main')
    const r = await maybeBackupPushBranch({ repoRoot: clone, branchName: 'feat/x', context: 't' })
    expect(r).toBe('up-to-date')
  })
  it('skipped wanneer de lokale branch niet bestaat', async () => {
    const r = await maybeBackupPushBranch({
      repoRoot: clone,
      branchName: 'feat/nope',
      context: 't',
    })
    expect(r).toBe('skipped')
  })
})

describe('localTipContainedInRemote', () => {
  it('true wanneer remote exact op de lokale tip staat', async () => {
    await git(clone, 'checkout', '-b', 'feat/x')
    await commit(clone, 'w1.txt')
    await git(clone, 'push', '-u', 'origin', 'feat/x')
    expect(await localTipContainedInRemote(clone, 'feat/x')).toBe(true)
  })
  it('false wanneer lokaal vóór origin ligt (unpushed commit)', async () => {
    await git(clone, 'checkout', '-b', 'feat/x')
    await commit(clone, 'w1.txt')
    await git(clone, 'push', '-u', 'origin', 'feat/x')
    await commit(clone, 'w2.txt')
    expect(await localTipContainedInRemote(clone, 'feat/x')).toBe(false)
  })
  it('false wanneer de branch niet op origin bestaat', async () => {
    await git(clone, 'checkout', '-b', 'feat/only-local')
    await commit(clone, 'w1.txt')
    expect(await localTipContainedInRemote(clone, 'feat/only-local')).toBe(false)
  })
  it('false bij een kapot repo-pad (faalrichting = bewaren)', async () => {
    expect(await localTipContainedInRemote(path.join(dir, 'nope'), 'feat/x')).toBe(false)
  })
})

describe('remoteTipMergedIntoMain', () => {
  it('true voor een branch waarvan de tip in origin/main zit', async () => {
    await git(clone, 'checkout', '-b', 'feat/x')
    await commit(clone, 'w1.txt')
    await git(clone, 'push', '-u', 'origin', 'feat/x')
    await git(clone, 'checkout', 'main')
    await git(clone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '--no-ff', '-m', 'merge', 'feat/x')
    await git(clone, 'push', 'origin', 'main')
    await git(clone, 'fetch', 'origin')
    expect(await remoteTipMergedIntoMain(clone, 'feat/x')).toBe(true)
  })
  it('false voor een niet-gemergde branch', async () => {
    await git(clone, 'checkout', '-b', 'feat/x')
    await commit(clone, 'w1.txt')
    await git(clone, 'push', '-u', 'origin', 'feat/x')
    await git(clone, 'fetch', 'origin')
    expect(await remoteTipMergedIntoMain(clone, 'feat/x')).toBe(false)
  })
  it('false bij een kapot repo-pad (faalrichting = bewaren)', async () => {
    expect(await remoteTipMergedIntoMain(path.join(dir, 'nope'), 'feat/x')).toBe(false)
  })
})
