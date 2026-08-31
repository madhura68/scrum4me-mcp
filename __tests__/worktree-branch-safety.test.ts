import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createWorktreeForJob, removeWorktreeForJob } from '../src/git/worktree.js'

const exec = promisify(execFile)
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd })
let dir: string, origin: string, repo: string, wtRoot: string
const originalEnv = process.env.SCRUM4ME_AGENT_WORKTREE_DIR

async function commit(cwd: string, name: string) {
  await fs.writeFile(path.join(cwd, name), name)
  await git(cwd, 'add', '-A')
  await git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', name)
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-safety-'))
  origin = path.join(dir, 'origin.git')
  repo = path.join(dir, 'repo')
  wtRoot = path.join(dir, 'wt')
  process.env.SCRUM4ME_AGENT_WORKTREE_DIR = wtRoot
  await exec('git', ['init', '--bare', '-b', 'main', origin])
  await exec('git', ['init', '-b', 'main', repo])
  await git(repo, 'remote', 'add', 'origin', origin)
  await commit(repo, 'base.txt')
  await git(repo, 'push', '-u', 'origin', 'main')
})
afterEach(async () => {
  process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv
  await fs.rm(dir, { recursive: true, force: true })
})

describe('removeWorktreeForJob laag-3', () => {
  it('verwijdert de branch wanneer origin de tip heeft', async () => {
    await createWorktreeForJob({ repoRoot: repo, jobId: 'j1', branchName: 'feat/a' })
    await commit(path.join(wtRoot, 'j1'), 'w.txt')
    await git(path.join(wtRoot, 'j1'), 'push', '-u', 'origin', 'feat/a')
    await removeWorktreeForJob({ repoRoot: repo, jobId: 'j1' })
    await expect(git(repo, 'show-ref', '--verify', 'refs/heads/feat/a')).rejects.toThrow()
  })
  it('bewaart de branch wanneer origin de tip mist', async () => {
    await createWorktreeForJob({ repoRoot: repo, jobId: 'j2', branchName: 'feat/b' })
    await commit(path.join(wtRoot, 'j2'), 'w.txt') // niet gepusht
    await removeWorktreeForJob({ repoRoot: repo, jobId: 'j2' })
    const { stdout } = await git(repo, 'show-ref', '--verify', 'refs/heads/feat/b')
    expect(stdout.trim()).not.toBe('')
  })
})

describe('createWorktreeForJob fresh-pad', () => {
  it('neemt de suffix-uitwijk i.p.v. een unpushed orphan te vernietigen', async () => {
    await git(repo, 'checkout', '-b', 'feat/c')
    await commit(repo, 'orphan.txt')
    await git(repo, 'checkout', 'main')
    const r = await createWorktreeForJob({ repoRoot: repo, jobId: 'j3', branchName: 'feat/c' })
    expect(r.branchName).toMatch(/^feat\/c-\d+$/)
    const { stdout } = await git(repo, 'show-ref', '--verify', 'refs/heads/feat/c')
    expect(stdout.trim()).not.toBe('') // orphan bewaard
  })
})

describe('createWorktreeForJob reuse-pad', () => {
  it('push-faalpad: lokaal vóór origin + push faalt → branchExists-tak zonder reset', async () => {
    // Deterministisch faalpad: de push-URL wijst naar een niet-bestaand pad,
    // de fetch-URL blijft intact (ls-remote/ancestor-checks blijven werken).
    await git(repo, 'checkout', '-b', 'feat/d')
    await commit(repo, 'r1.txt')
    await git(repo, 'push', '-u', 'origin', 'feat/d')
    const remoteTipBefore = (await exec('git', ['ls-remote', origin, 'refs/heads/feat/d'])).stdout
      .trim()
      .split(/\s+/)[0]
    await commit(repo, 'r2.txt') // lokaal vóór origin
    const localTip = (await git(repo, 'rev-parse', 'feat/d')).stdout.trim()
    await git(repo, 'checkout', 'main')
    await git(repo, 'remote', 'set-url', '--push', 'origin', path.join(dir, 'nonexistent.git'))
    const r = await createWorktreeForJob({
      repoRoot: repo,
      jobId: 'j4',
      branchName: 'feat/d',
      reuseBranch: true,
    })
    await git(repo, 'remote', 'set-url', '--push', 'origin', origin)
    const newTip = (await git(path.join(wtRoot, 'j4'), 'rev-parse', 'HEAD')).stdout.trim()
    const remoteTipAfter = (await exec('git', ['ls-remote', origin, 'refs/heads/feat/d'])).stdout
      .trim()
      .split(/\s+/)[0]
    // Onderscheidend: de push is écht niet geland…
    expect(remoteTipAfter).toBe(remoteTipBefore)
    // …en tóch staat de worktree op de voorliggende lokale tip — een foute
    // implementatie die alsnog `-B origin/feat/d` doet, eindigt op
    // remoteTipBefore en laat deze assertie falen.
    expect(newTip).toBe(localTip)
    expect(r.branchName).toBe('feat/d')
  })
  it('push-slaagpad: voorliggende branch wordt éérst gepusht, daarna is de -B-reset veilig', async () => {
    await git(repo, 'checkout', '-b', 'feat/f')
    await git(repo, 'push', '-u', 'origin', 'feat/f') // origin/feat/f == main-tip
    await commit(repo, 'ahead.txt') // lokaal vóór origin
    const localTip = (await git(repo, 'rev-parse', 'feat/f')).stdout.trim()
    await git(repo, 'checkout', 'main') // repoRoot-HEAD == origin/feat/f
    const r = await createWorktreeForJob({
      repoRoot: repo,
      jobId: 'j6',
      branchName: 'feat/f',
      reuseBranch: true,
    })
    const remoteTip = (await exec('git', ['ls-remote', origin, 'refs/heads/feat/f'])).stdout
      .trim()
      .split(/\s+/)[0]
    expect(remoteTip).toBe(localTip) // de backup landde vóór de reset
    const newTip = (await git(path.join(wtRoot, 'j6'), 'rev-parse', 'HEAD')).stdout.trim()
    expect(newTip).toBe(localTip)
    expect(r.branchName).toBe('feat/f')
  })
  it('reset wél (en veilig) wanneer origin de lokale tip bevat', async () => {
    await git(repo, 'checkout', '-b', 'feat/e')
    await commit(repo, 'r1.txt')
    await git(repo, 'push', '-u', 'origin', 'feat/e')
    await git(repo, 'checkout', 'main')
    const r = await createWorktreeForJob({
      repoRoot: repo,
      jobId: 'j5',
      branchName: 'feat/e',
      reuseBranch: true,
    })
    expect(r.branchName).toBe('feat/e')
  })
})
