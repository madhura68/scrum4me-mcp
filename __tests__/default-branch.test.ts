// ISS-3: repo's met een andere default dan `main` (bv. scrum4me-docker →
// master) konden geen job-worktree krijgen en werden nooit gepusht.
// Echte git-fixtures: een bare origin met `master` als default naast één met
// `main`, zodat de regressie zichtbaar is zonder mocks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveOriginDefaultRef } from '../src/git/default-branch.js'
import { createWorktreeForJob } from '../src/git/worktree.js'
import { pushBranchForJob } from '../src/git/push.js'

const exec = promisify(execFile)
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd })

let dir: string
const originalEnv = process.env.SCRUM4ME_AGENT_WORKTREE_DIR

async function commit(cwd: string, name: string) {
  await fs.writeFile(path.join(cwd, name), name)
  await git(cwd, 'add', '-A')
  await git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', name)
}

/** Bare origin met `defaultBranch` als HEAD, plus een clone ervan. */
async function setupRepo(defaultBranch: string): Promise<{ repo: string; origin: string }> {
  const base = await fs.mkdtemp(path.join(dir, `${defaultBranch}-`))
  const origin = path.join(base, 'origin.git')
  const repo = path.join(base, 'repo')
  await exec('git', ['init', '--bare', '-b', defaultBranch, origin])
  await exec('git', ['init', '-b', defaultBranch, repo])
  await git(repo, 'remote', 'add', 'origin', origin)
  await commit(repo, 'base.txt')
  await git(repo, 'push', '-u', 'origin', defaultBranch)
  // origin/HEAD bewust NIET zetten: dat is precies de situatie op de workers,
  // waar de clone via preclone ontstaat. resolveOriginDefaultRef moet hem
  // zelf kunnen bepalen.
  await git(repo, 'fetch', 'origin', '--prune')
  return { repo, origin }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iss3-'))
  process.env.SCRUM4ME_AGENT_WORKTREE_DIR = path.join(dir, 'wt')
})

afterEach(async () => {
  process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv
  await fs.rm(dir, { recursive: true, force: true })
})

describe('resolveOriginDefaultRef', () => {
  it('vindt master in een master-repo', async () => {
    const { repo } = await setupRepo('master')
    expect(await resolveOriginDefaultRef(repo)).toBe('origin/master')
  })

  it('vindt main in een main-repo', async () => {
    const { repo } = await setupRepo('main')
    expect(await resolveOriginDefaultRef(repo)).toBe('origin/main')
  })

  it('valt terug op origin/main bij een onleesbare repo', async () => {
    expect(await resolveOriginDefaultRef(path.join(dir, 'bestaat-niet'))).toBe('origin/main')
  })
})

describe('createWorktreeForJob op een repo zonder main (ISS-3)', () => {
  it('maakt een worktree in een master-repo zonder expliciete baseRef', async () => {
    const { repo } = await setupRepo('master')

    const r = await createWorktreeForJob({
      repoRoot: repo,
      jobId: 'job-master',
      branchName: 'feat/sprint-master',
    })

    expect(r.branchName).toBe('feat/sprint-master')
    const { stdout } = await git(r.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')
    expect(stdout.trim()).toBe('feat/sprint-master')
    // en hij staat op de tip van origin/master
    const tip = (await git(repo, 'rev-parse', 'origin/master')).stdout.trim()
    const head = (await git(r.worktreePath, 'rev-parse', 'HEAD')).stdout.trim()
    expect(head).toBe(tip)
  })

  it('een expliciete baseRef van de caller wint', async () => {
    const { repo } = await setupRepo('master')
    await git(repo, 'branch', 'release')
    await git(repo, 'push', 'origin', 'release')
    await git(repo, 'fetch', 'origin', '--prune')

    const r = await createWorktreeForJob({
      repoRoot: repo,
      jobId: 'job-explicit',
      branchName: 'feat/from-release',
      baseRef: 'origin/release',
    })

    const head = (await git(r.worktreePath, 'rev-parse', 'HEAD')).stdout.trim()
    const releaseTip = (await git(repo, 'rev-parse', 'origin/release')).stdout.trim()
    expect(head).toBe(releaseTip)
  })
})

describe('pushBranchForJob op een repo zonder main (ISS-3)', () => {
  it('pusht nieuw werk in een master-repo', async () => {
    const { repo, origin } = await setupRepo('master')
    const wt = await createWorktreeForJob({
      repoRoot: repo,
      jobId: 'job-push',
      branchName: 'feat/sprint-push',
    })
    await commit(wt.worktreePath, 'werk.txt')

    const result = await pushBranchForJob({
      worktreePath: wt.worktreePath,
      branchName: 'feat/sprint-push',
    })

    expect(result.pushed).toBe(true)
    const { stdout } = await exec('git', ['ls-remote', origin, 'refs/heads/feat/sprint-push'])
    expect(stdout.trim()).not.toBe('')
  })

  it('meldt no-changes wanneer de branch gelijk is aan de default branch', async () => {
    const { repo } = await setupRepo('master')
    const wt = await createWorktreeForJob({
      repoRoot: repo,
      jobId: 'job-nochanges',
      branchName: 'feat/leeg',
    })

    const result = await pushBranchForJob({
      worktreePath: wt.worktreePath,
      branchName: 'feat/leeg',
    })

    expect(result).toMatchObject({ pushed: false, reason: 'no-changes' })
  })
})
