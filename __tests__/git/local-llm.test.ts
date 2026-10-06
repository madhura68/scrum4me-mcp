import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Forgejo-review PR #169: gitPrefixFor controleert voor een local_llm-worktree
// eerst de gitlink tegen de clone (fs-only). Deze tests gaan over de
// prefix-argumenten met fictieve paden; de controle zelf is gestubd en wordt
// getest in __tests__/git/worktree-gitlink.test.ts en de done-pad-ketentest.
const gitlinkMocks = vi.hoisted(() => ({ assertTrustedLocalJobWorktree: vi.fn() }))
vi.mock('../../src/git/worktree-gitlink.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/git/worktree-gitlink.js')>()),
  assertTrustedLocalJobWorktree: gitlinkMocks.assertTrustedLocalJobWorktree,
}))
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../src/prisma.js', () => ({
  prisma: { claudeJob: { findUnique: vi.fn() } },
}))

// Spy op child_process.execFile die naar de echte implementatie delegeert —
// nodig om te kunnen bewijzen dat een fix géén `git worktree remove` meer
// aanroept voor een local_llm-bezetter (i.p.v. alleen het eindresultaat op
// de schijf te controleren, wat voor beide code-paden identiek is).
//
// De hele codebase roept git aan via `promisify(execFile)`, niet via de
// callback-vorm rechtstreeks. `util.promisify` kijkt eerst naar
// `fn[util.promisify.custom]` — Node's `execFile` heeft die, en als je die
// custom-implementatie zomaar meekopieert naar een `vi.fn(actual.execFile)`-
// wrapper, retourneert `promisify(execFileMock)` alsnog de ORIGINELE
// (ongewrapte) promisified functie en omzeilt de mock volledig: alle
// `.mock.calls` blijven dan leeg terwijl de echte git-calls wél degelijk
// lopen. Daarom registreren we de aanroep hier expliciet zelf, vóór we naar
// de originele custom-promisify-implementatie delegeren.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const originalPromisified = (
    actual.execFile as unknown as Record<symbol, (...a: unknown[]) => unknown>
  )[promisify.custom]
  const execFileMock = vi.fn((...args: unknown[]) =>
    (actual.execFile as unknown as (...a: unknown[]) => unknown)(...args),
  )
  Object.defineProperty(execFileMock, promisify.custom, {
    value: (...args: unknown[]) => {
      execFileMock.mock.calls.push(args as never)
      return originalPromisified(...args)
    },
  })
  return { ...actual, execFile: execFileMock }
})

import { prisma } from '../../src/prisma.js'
import {
  SAFE_GIT_CONFIG,
  UntrustedWorktreeGitlinkError,
  isHarnessJob,
  isHarnessJobRow,
  jobIdFromWorktreePath,
  isLocalLlmWorktree,
  gitPrefixFor,
} from '../../src/git/local-llm.js'
import { createWorktreeForJob, removeWorktreeForJob } from '../../src/git/worktree.js'
import { maybeBackupPush } from '../../src/git/branch-safety.js'
import { GUARDED_JOBS, ORDINARY_JOB, type JobRow } from '../helpers/guarded-jobs.js'

const exec = promisify(execFile)
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd })

const findUnique = vi.mocked(prisma.claudeJob.findUnique)

// De DB-rij per job-id; een onbekend id geeft null (zoals Prisma). `status` hoort bij de rij maar telt voor het
// predicaat niet mee: de worktree van een afgesloten job blijft bewaakt.
function mockJobs(map: Record<string, JobRow & { status?: string }>) {
  findUnique.mockImplementation((async (args: { where: { id: string } }) => {
    const id = args.where.id
    if (!(id in map)) return null
    return map[id]
  }) as typeof findUnique)
}

// De `git worktree remove`-aanroepen sinds de laatste mockClear van de execFile-spy.
function worktreeRemoveCalls() {
  return vi.mocked(execFile).mock.calls.filter((call) => {
    const [file, args] = call as unknown as [string, string[] | undefined]
    return file === 'git' && Array.isArray(args) && args.includes('remove') && args.includes('worktree')
  })
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

describe('isHarnessJobRow', () => {
  it.each([
    { runtime: 'HARNESS', required_capability: null, expected: true },
    { runtime: 'HARNESS', required_capability: 'local_llm', expected: true },
    { runtime: 'CLAUDE', required_capability: 'local_llm', expected: true },
    { runtime: 'CODEX', required_capability: null, expected: false },
    { runtime: 'CLAUDE', required_capability: null, expected: false },
    { runtime: 'CLAUDE', required_capability: 'deploy', expected: false },
  ])('runtime $runtime met capability $required_capability ⇒ $expected', ({ expected, ...row }) => {
    expect(isHarnessJobRow(row)).toBe(expected)
  })
})

describe('isHarnessJob', () => {
  it('leest runtime én required_capability uit de database (nooit uit de worktree)', async () => {
    mockJobs({ 'job-1': ORDINARY_JOB })
    await isHarnessJob('job-1')
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      select: { runtime: true, required_capability: true },
    })
  })
  it.each(GUARDED_JOBS)('true voor een $label', async ({ job }) => {
    mockJobs({ 'job-1': job })
    expect(await isHarnessJob('job-1')).toBe(true)
  })
  it('false voor een gewone job', async () => {
    mockJobs({ 'job-1': ORDINARY_JOB })
    expect(await isHarnessJob('job-1')).toBe(false)
  })
  it('false voor een andere capability', async () => {
    mockJobs({ 'job-2': { runtime: 'CLAUDE', required_capability: 'deploy' } })
    expect(await isHarnessJob('job-2')).toBe(false)
  })
  it('false voor een onbekende job', async () => {
    mockJobs({})
    expect(await isHarnessJob('nope')).toBe(false)
  })
  // Spec §5.6: de local_llm-tak blijft permanent. Een afgesloten job laat een worktree achter die bewaakt blijft;
  // het predicaat kijkt dus niet naar de status.
  it.each(GUARDED_JOBS)('true voor een afgesloten $label (DONE)', async ({ job }) => {
    mockJobs({ 'job-1': { ...job, status: 'DONE' } })
    expect(await isHarnessJob('job-1')).toBe(true)
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
  it.each(GUARDED_JOBS)('true + SAFE_GIT_CONFIG voor de jobworktree van een $label', async ({ job }) => {
    mockJobs({ 'job-x': job })
    expect(await isLocalLlmWorktree('/tmp/wtroot/job-x')).toBe(true)
    expect(await gitPrefixFor('/tmp/wtroot/job-x')).toEqual([...SAFE_GIT_CONFIG])
    expect(gitlinkMocks.assertTrustedLocalJobWorktree).toHaveBeenCalledWith('job-x', '/tmp/wtroot/job-x')
  })
  it.each(GUARDED_JOBS)(
    'gitPrefixFor gooit (en geeft geen prefix) wanneer de gitlink-controle van een $label faalt',
    async ({ job }) => {
      mockJobs({ 'job-x': job })
      gitlinkMocks.assertTrustedLocalJobWorktree.mockRejectedValueOnce(
        new UntrustedWorktreeGitlinkError('test'),
      )
      await expect(gitPrefixFor('/tmp/wtroot/job-x')).rejects.toBeInstanceOf(UntrustedWorktreeGitlinkError)
    },
  )
  it('false + [] voor een niet-lokale jobworktree', async () => {
    mockJobs({ 'job-y': ORDINARY_JOB })
    expect(await isLocalLlmWorktree('/tmp/wtroot/job-y')).toBe(false)
    expect(await gitPrefixFor('/tmp/wtroot/job-y')).toEqual([])
    expect(gitlinkMocks.assertTrustedLocalJobWorktree).not.toHaveBeenCalled()
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

  it.each(GUARDED_JOBS)('maybeBackupPush en removeWorktreeForJob raken de omgebogen gitlink van een $label nooit aan', async ({ job }) => {
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

    mockJobs({ [jobId]: job })

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

    mockJobs({ [jobId]: ORDINARY_JOB })

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

describe('createWorktreeForJob: bezetter-detectie onder een gesymlinkte worktree-root', () => {
  let dir: string, origin: string, clone: string, realRoot: string, linkRoot: string
  const originalEnv = process.env.SCRUM4ME_AGENT_WORKTREE_DIR

  async function commit(cwd: string, name: string) {
    await fs.writeFile(path.join(cwd, name), name)
    await git(cwd, 'add', '-A')
    await git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', name)
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-llm-symlink-'))
    origin = path.join(dir, 'origin.git')
    clone = path.join(dir, 'clone')
    realRoot = path.join(dir, 'real-root')
    linkRoot = path.join(dir, 'link-root')
    await fs.mkdir(realRoot, { recursive: true })
    await fs.symlink(realRoot, linkRoot)
    // SCRUM4ME_AGENT_WORKTREE_DIR wijst naar de symlink — zoals bv. macOS'
    // /tmp → /private/tmp, of een expliciet gesymlinkte $HOME.
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = linkRoot

    await exec('git', ['init', '--bare', '-b', 'main', origin])
    await exec('git', ['init', '-b', 'main', clone])
    await git(clone, 'remote', 'add', 'origin', origin)
    await commit(clone, 'base.txt')
    await git(clone, 'push', '-u', 'origin', 'main')
  })

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    else process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('jobIdFromWorktreePath matcht het door git gerealpathte occupant-pad', async () => {
    // Bewijst de kernclaim zonder de trage worktree-integratie: git geeft
    // straks het realpath'te pad terug, niet het pad zoals opgebouwd via
    // getWorktreeRoot(). jobIdFromWorktreePath moet dat toch herkennen.
    //
    // `resolvedRealRoot` volgt zowel onze eigen symlink (linkRoot → realRoot)
    // als eventuele OS-niveau-symlinks in het pad ervoor (bv. macOS'
    // os.tmpdir() onder /var, wat zelf een symlink naar /private/var is) —
    // exact wat git bij `worktree list --porcelain` teruggeeft. `job-abc`
    // zelf hoeft niet te bestaan; alleen het al-bestaande prefix wordt
    // gerealpath't.
    const resolvedRealRoot = await fs.realpath(realRoot)
    const realPath = path.join(resolvedRealRoot, 'job-abc')
    const literalPath = path.join(linkRoot, 'job-abc')
    expect(jobIdFromWorktreePath(realPath)).toBe('job-abc')
    expect(jobIdFromWorktreePath(literalPath)).toBe('job-abc')
  })

  it.each(GUARDED_JOBS)('herkent de bezetter van een $label ook via het gerealpathte git-pad — geen git worktree remove', async ({ job }) => {
    const branchName = 'feat/shared-symlink'
    const { worktreePath: occupantPath } = await createWorktreeForJob({
      repoRoot: clone,
      jobId: 'local-occupant',
      branchName,
      baseRef: 'origin/main',
    })
    // Het pad dat wij opbouwden ligt onder de symlink (linkRoot) — het
    // onopgeloste pad, exact zoals `getWorktreeRoot()` het teruggeeft.
    expect(occupantPath).toBe(path.join(linkRoot, 'local-occupant'))

    // Bevestig de bevinding zelf: git rapporteert het realpath'te pad, niet
    // het pad waarmee de worktree werd aangemaakt.
    const { stdout: listOut } = await git(clone, 'worktree', 'list', '--porcelain')
    expect(listOut).toContain(path.join(realRoot, 'local-occupant'))
    expect(listOut).not.toContain(path.join(linkRoot, 'local-occupant'))

    mockJobs({ 'local-occupant': job })

    const execMock = vi.mocked(execFile)
    execMock.mockClear()

    // reuseBranch: true op dezelfde branchnaam ⇒ createWorktreeForJob vindt
    // de bezetter via findWorktreeForBranch (het realpath'te pad) en moet 'm
    // opruimen zonder ooit git met dat pad als werkmap of als
    // `worktree remove`-target aan te roepen.
    await createWorktreeForJob({
      repoRoot: clone,
      jobId: 'local-occupant-2',
      branchName,
      baseRef: 'origin/main',
      reuseBranch: true,
    })

    expect(worktreeRemoveCalls()).toEqual([])

    // De bezetter-map is weg — via fs.rm, ongeacht welke padvorm.
    await expect(fs.access(occupantPath)).rejects.toThrow()
    await expect(fs.access(path.join(realRoot, 'local-occupant'))).rejects.toThrow()
  })
})

// Spec §5.6: de local_llm-tak van het predicaat blijft permanent. Een job die al is afgesloten laat zijn worktree
// achter, en een volgende job die dezelfde branch hergebruikt, vindt die als bezetter. Die map was container-
// beschrijfbaar en blijft dus bewaakt: opruimen zonder git, ook als de job DONE is.
describe('createWorktreeForJob: de bezetter is de worktree van een afgesloten job', () => {
  let dir: string, origin: string, clone: string, wtRoot: string
  const originalEnv = process.env.SCRUM4ME_AGENT_WORKTREE_DIR

  async function commit(cwd: string, name: string) {
    await fs.writeFile(path.join(cwd, name), name)
    await git(cwd, 'add', '-A')
    await git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', name)
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-llm-closed-occupant-'))
    origin = path.join(dir, 'origin.git')
    clone = path.join(dir, 'clone')
    wtRoot = path.join(dir, 'wt')
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = wtRoot

    await exec('git', ['init', '--bare', '-b', 'main', origin])
    await exec('git', ['init', '-b', 'main', clone])
    await git(clone, 'remote', 'add', 'origin', origin)
    await commit(clone, 'base.txt')
    await git(clone, 'push', '-u', 'origin', 'main')
  })

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    else process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv
    await fs.rm(dir, { recursive: true, force: true })
  })

  // Maakt de worktree van een job die daarna DONE is en laat een tweede job dezelfde branch hergebruiken.
  async function reuseBranchOfClosedJob(closedJob: JobRow) {
    const branchName = 'feat/shared-closed'
    mockJobs({})
    const { worktreePath: occupantPath } = await createWorktreeForJob({
      repoRoot: clone,
      jobId: 'closed-occupant',
      branchName,
      baseRef: 'origin/main',
    })
    mockJobs({ 'closed-occupant': { ...closedJob, status: 'DONE' } })

    vi.mocked(execFile).mockClear()
    await createWorktreeForJob({
      repoRoot: clone,
      jobId: 'next-job',
      branchName,
      baseRef: 'origin/main',
      reuseBranch: true,
    })
    return occupantPath
  }

  it.each(GUARDED_JOBS)('ruimt de bezetter van een afgesloten $label op zonder git worktree remove', async ({ job }) => {
    const occupantPath = await reuseBranchOfClosedJob(job)

    expect(worktreeRemoveCalls()).toEqual([])
    await expect(fs.access(occupantPath)).rejects.toThrow()
  })

  it('controle: de bezetter van een afgesloten gewone job gaat wél via git worktree remove --force', async () => {
    const occupantPath = await reuseBranchOfClosedJob(ORDINARY_JOB)

    expect(worktreeRemoveCalls()).toHaveLength(1)
    expect(worktreeRemoveCalls()[0][1]).toEqual(
      expect.arrayContaining(['worktree', 'remove', '--force']),
    )
    await expect(fs.access(occupantPath)).rejects.toThrow()
  })
})
