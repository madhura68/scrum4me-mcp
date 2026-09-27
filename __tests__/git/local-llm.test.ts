import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../src/prisma.js', () => ({
  prisma: { claudeJob: { findUnique: vi.fn() } },
}))

import { prisma } from '../../src/prisma.js'
import {
  SAFE_GIT_CONFIG,
  isLocalLlmJob,
  jobIdFromWorktreePath,
  isLocalLlmWorktree,
  gitPrefixFor,
} from '../../src/git/local-llm.js'
import { createWorktreeForJob, removeWorktreeForJob } from '../../src/git/worktree.js'
import { maybeBackupPush } from '../../src/git/branch-safety.js'

const exec = promisify(execFile)
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd })

const findUnique = vi.mocked(prisma.claudeJob.findUnique)

function mockCapability(map: Record<string, string | null>) {
  findUnique.mockImplementation((async (args: { where: { id: string } }) => {
    const id = args.where.id
    if (!(id in map)) return null
    return { required_capability: map[id] }
  }) as typeof findUnique)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SAFE_GIT_CONFIG', () => {
  it('bevat exact de veilige host-git-config uit de spec', () => {
    expect(SAFE_GIT_CONFIG).toEqual([
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      '-c', 'diff.ignoreSubmodules=all',
      '-c', 'status.submoduleSummary=false',
      '-c', 'submodule.recurse=false',
    ])
  })
})

describe('isLocalLlmJob', () => {
  it('true wanneer required_capability = local_llm', async () => {
    mockCapability({ 'job-1': 'local_llm' })
    expect(await isLocalLlmJob('job-1')).toBe(true)
  })
  it('false voor een andere capability', async () => {
    mockCapability({ 'job-2': 'deploy' })
    expect(await isLocalLlmJob('job-2')).toBe(false)
  })
  it('false voor een onbekende job', async () => {
    mockCapability({})
    expect(await isLocalLlmJob('nope')).toBe(false)
  })
})

describe('jobIdFromWorktreePath', () => {
  const originalEnv = process.env.SCRUM4ME_AGENT_WORKTREE_DIR
  beforeEach(() => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/tmp/wtroot'
  })
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    else process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv
  })
  it('geeft jobId voor <root>/<jobId>', () => {
    expect(jobIdFromWorktreePath('/tmp/wtroot/job-abc')).toBe('job-abc')
  })
  it('null voor een pad buiten de root', () => {
    expect(jobIdFromWorktreePath('/tmp/other/job-abc')).toBeNull()
  })
  it('null voor de root zelf', () => {
    expect(jobIdFromWorktreePath('/tmp/wtroot')).toBeNull()
  })
  it('null voor een pad dieper dan één niveau', () => {
    expect(jobIdFromWorktreePath('/tmp/wtroot/job-abc/sub')).toBeNull()
  })
})

describe('isLocalLlmWorktree / gitPrefixFor', () => {
  const originalEnv = process.env.SCRUM4ME_AGENT_WORKTREE_DIR
  beforeEach(() => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/tmp/wtroot'
  })
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    else process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv
  })
  it('true + SAFE_GIT_CONFIG voor een local_llm-jobworktree', async () => {
    mockCapability({ 'job-x': 'local_llm' })
    expect(await isLocalLlmWorktree('/tmp/wtroot/job-x')).toBe(true)
    expect(await gitPrefixFor('/tmp/wtroot/job-x')).toEqual([...SAFE_GIT_CONFIG])
  })
  it('false + [] voor een niet-lokale jobworktree', async () => {
    mockCapability({ 'job-y': null })
    expect(await isLocalLlmWorktree('/tmp/wtroot/job-y')).toBe(false)
    expect(await gitPrefixFor('/tmp/wtroot/job-y')).toEqual([])
  })
  it('false voor een pad buiten de root (geen DB-lookup nodig)', async () => {
    expect(await isLocalLlmWorktree('/elsewhere/job-x')).toBe(false)
    expect(findUnique).not.toHaveBeenCalled()
  })
})

describe('local_llm-worktree: geen git in de worktree op niet-groene paden (markerproef)', () => {
  let dir: string, origin: string, clone: string, wtRoot: string, scripts: string
  const originalEnv = process.env.SCRUM4ME_AGENT_WORKTREE_DIR

  async function commit(cwd: string, name: string) {
    await fs.writeFile(path.join(cwd, name), name)
    await git(cwd, 'add', '-A')
    await git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', name)
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-llm-marker-'))
    origin = path.join(dir, 'origin.git')
    clone = path.join(dir, 'clone')
    wtRoot = path.join(dir, 'wt')
    scripts = path.join(dir, 'scripts')
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = wtRoot

    await exec('git', ['init', '--bare', '-b', 'main', origin])
    await exec('git', ['init', '-b', 'main', clone])
    await git(clone, 'remote', 'add', 'origin', origin)
    await commit(clone, 'base.txt')
    await git(clone, 'push', '-u', 'origin', 'main')

    await fs.mkdir(scripts, { recursive: true })
    const fsmonitorScript = path.join(scripts, 'fsmonitor.sh')
    const sshScript = path.join(scripts, 'ssh.sh')
    // Schrijven van de marker bewijst dat het script daadwerkelijk gestart is
    // (fsmonitor-hook resp. ssh-transport) — niet dat er echt verbonden werd.
    await fs.writeFile(
      fsmonitorScript,
      `#!/bin/sh\necho invoked > ${JSON.stringify(path.join(dir, 'marker-fsmonitor'))}\nexit 0\n`,
    )
    await fs.writeFile(
      sshScript,
      `#!/bin/sh\necho invoked > ${JSON.stringify(path.join(dir, 'marker-ssh'))}\nexit 1\n`,
    )
    await fs.chmod(fsmonitorScript, 0o755)
    await fs.chmod(sshScript, 0o755)
  })

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    else process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('maybeBackupPush en removeWorktreeForJob raken de omgebogen gitlink nooit aan', async () => {
    const jobId = 'local-job-1'
    const branchName = 'feat/local-job-1'
    const { worktreePath } = await createWorktreeForJob({
      repoRoot: clone,
      jobId,
      branchName,
      baseRef: 'origin/main',
    })

    // Buig de gitlink om naar zelfgemaakte git-administratie BINNEN de
    // worktree — simuleert een container met schrijftoegang die .git omleidt
    // (spec §4.5). Deze fake gitdir bevat executable core.fsmonitor/
    // core.sshCommand-config en een ssh-remote die nooit echt bereikt mag
    // worden.
    const evilGitDir = path.join(worktreePath, '.evil-git-admin')
    await exec('git', ['init', '--bare', '-b', 'main', evilGitDir])
    const evilConfig = path.join(evilGitDir, 'config')
    await exec('git', [
      'config', '--file', evilConfig, 'core.fsmonitor', path.join(scripts, 'fsmonitor.sh'),
    ])
    await exec('git', [
      'config', '--file', evilConfig, 'core.sshCommand', path.join(scripts, 'ssh.sh'),
    ])
    await exec('git', [
      'config', '--file', evilConfig, 'remote.origin.url', 'ssh://example.invalid/x',
    ])
    // De fake gitdir heeft een echte commit nodig — anders faalt elke
    // git-aanroep er al op "unborn HEAD" vóórdat sshCommand/fsmonitor ooit
    // geraakt wordt, en zou de markerproef niets bewijzen.
    const evilEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'evil', GIT_AUTHOR_EMAIL: 'evil@evil',
      GIT_COMMITTER_NAME: 'evil', GIT_COMMITTER_EMAIL: 'evil@evil',
    }
    const emptyTree = execFileSync(
      'git',
      ['--git-dir', evilGitDir, 'hash-object', '-t', 'tree', '--stdin', '-w'],
      { input: '' },
    ).toString().trim()
    const evilCommit = (
      await exec(
        'git',
        ['--git-dir', evilGitDir, 'commit-tree', emptyTree, '-m', 'evil'],
        { env: evilEnv },
      )
    ).stdout.trim()
    await exec('git', ['--git-dir', evilGitDir, 'update-ref', 'refs/heads/main', evilCommit])
    await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${evilGitDir}\n`)

    const fsmonitorMarker = path.join(dir, 'marker-fsmonitor')
    const sshMarker = path.join(dir, 'marker-ssh')

    mockCapability({ [jobId]: 'local_llm' })

    const pushResult = await maybeBackupPush({ worktreePath, branchName, context: 'test' })
    expect(pushResult).toBe('skipped')
    await expect(fs.access(fsmonitorMarker)).rejects.toThrow()
    await expect(fs.access(sshMarker)).rejects.toThrow()

    const removeResult = await removeWorktreeForJob({ repoRoot: clone, jobId })
    expect(removeResult.removed).toBe(true)
    await expect(fs.access(worktreePath)).rejects.toThrow()

    const { stdout: listOut } = await git(clone, 'worktree', 'list', '--porcelain')
    expect(listOut).not.toContain(worktreePath)

    const { stdout: refOut } = await git(clone, 'show-ref', '--verify', `refs/heads/${branchName}`)
    expect(refOut.trim()).not.toBe('')

    await expect(fs.access(fsmonitorMarker)).rejects.toThrow()
    await expect(fs.access(sshMarker)).rejects.toThrow()
  })

  it('een niet-lokale job gedraagt zich als vóór de wijziging (bestaand gedrag ongewijzigd)', async () => {
    const jobId = 'normal-job-1'
    const branchName = 'feat/normal-job-1'
    const { worktreePath } = await createWorktreeForJob({
      repoRoot: clone,
      jobId,
      branchName,
      baseRef: 'origin/main',
    })
    await commit(worktreePath, 'w1.txt')

    mockCapability({ [jobId]: null })

    const pushResult = await maybeBackupPush({ worktreePath, branchName, context: 'test' })
    expect(pushResult).toBe('pushed')

    const removeResult = await removeWorktreeForJob({ repoRoot: clone, jobId })
    expect(removeResult.removed).toBe(true)
    await expect(fs.access(worktreePath)).rejects.toThrow()
    // origin had de tip (net gepusht) → branch wordt verwijderd, zoals vóór de wijziging.
    await expect(
      git(clone, 'show-ref', '--verify', `refs/heads/${branchName}`),
    ).rejects.toThrow()
  })
})
