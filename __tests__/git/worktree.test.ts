import { describe, it, expect, vi, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

// Deze tests dekken de niet-lokale weg (geen HARNESS- of local_llm-job); de findUnique-mock
// zorgt dat isHarnessJob() standaard false teruggeeft zonder een echte DB nodig
// te hebben. Het bewaakte pad zelf zit in __tests__/git/local-llm.test.ts en in het blok
// 'bewaakte jobs' onderaan dit bestand, dat de mock per test omzet.
vi.mock('../../src/prisma.js', () => ({
  prisma: { claudeJob: { findUnique: vi.fn().mockResolvedValue(null) } },
}))

// Delegerende execFile-spy (zelfde patroon als __tests__/git/local-llm.test.ts): de aanroepen worden vastgelegd
// en lopen daarna echt, zodat een test kan bewijzen dat de worktree van een bewaakte job nooit via git wordt
// opgeruimd (het eindresultaat op schijf is voor beide wegen gelijk).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify: p } = await import('node:util')
  const originalPromisified = (
    actual.execFile as unknown as Record<symbol, (...a: unknown[]) => unknown>
  )[p.custom]
  const execFileMock = vi.fn((...args: unknown[]) =>
    (actual.execFile as unknown as (...a: unknown[]) => unknown)(...args),
  )
  Object.defineProperty(execFileMock, p.custom, {
    value: (...args: unknown[]) => {
      execFileMock.mock.calls.push(args as never)
      return originalPromisified(...args)
    },
  })
  return { ...actual, execFile: execFileMock }
})

import { prisma } from '../../src/prisma.js'
import { createWorktreeForJob, removeWorktreeForJob } from '../../src/git/worktree.js'
import { GUARDED_JOBS, ORDINARY_JOB, type JobRow } from '../helpers/guarded-jobs.js'

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

    // Pre-create an orphan branch (no worktree attached). M38 laag 3: de
    // orphan-delete gebeurt alleen wanneer origin de tip bevat — hier dus
    // eerst pushen. Het ongepushte geval (branch blijft staan, suffix-uitwijk)
    // staat in __tests__/worktree-branch-safety.test.ts.
    await git(['branch', 'feat/job-002'], repoDir)
    await git(['push', 'origin', 'feat/job-002'], repoDir)
    await git(['fetch', 'origin', '--prune'], repoDir)

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

  it('symlinks repoRoot node_modules into the worktree when present', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    await makeWorktreeParent()

    // repoRoot has installed deps
    await fs.mkdir(path.join(repoDir, 'node_modules', '.bin'), { recursive: true })
    await fs.writeFile(path.join(repoDir, 'node_modules', 'marker.txt'), 'deps')

    const { worktreePath } = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-nm',
      branchName: 'feat/job-nm',
      baseRef: 'origin/main',
    })

    const link = path.join(worktreePath, 'node_modules')
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
    // resolves THROUGH the symlink to the repoRoot's node_modules
    expect(await fs.readFile(path.join(link, 'marker.txt'), 'utf8')).toBe('deps')
  })

  it('skips the node_modules symlink when repoRoot has none', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    await makeWorktreeParent()

    const { worktreePath } = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-nonm',
      branchName: 'feat/job-nonm',
      baseRef: 'origin/main',
    })

    await expect(fs.access(path.join(worktreePath, 'node_modules'))).rejects.toThrow()
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

  it('removes worktree directory and deletes the branch when origin has the tip', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    const wtParent = await makeWorktreeParent()

    const { worktreePath, branchName } = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-rm-01',
      branchName: 'feat/job-rm-01',
      baseRef: 'origin/main',
    })

    // M38 laag 3: de branch wordt alleen verwijderd wanneer origin de tip
    // aantoonbaar bevat. Het ongepushte geval (branch blijft bewaard) staat
    // in __tests__/worktree-branch-safety.test.ts.
    await git(['push', 'origin', branchName], worktreePath)

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

  it('removal unlinks the node_modules symlink without deleting the shared repoRoot node_modules', async () => {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    await makeWorktreeParent()

    await fs.mkdir(path.join(repoDir, 'node_modules'), { recursive: true })
    await fs.writeFile(path.join(repoDir, 'node_modules', 'marker.txt'), 'deps')

    const { worktreePath } = await createWorktreeForJob({
      repoRoot: repoDir, jobId: 'job-rm-nm', branchName: 'feat/job-rm-nm', baseRef: 'origin/main',
    })
    expect((await fs.lstat(path.join(worktreePath, 'node_modules'))).isSymbolicLink()).toBe(true)

    await removeWorktreeForJob({ repoRoot: repoDir, jobId: 'job-rm-nm' })

    await expect(fs.access(worktreePath)).rejects.toThrow()                     // worktree gone
    expect(await fs.readFile(path.join(repoDir, 'node_modules', 'marker.txt'), 'utf8')).toBe('deps') // shared deps intact
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

// Spec §5.6: een HARNESS-job (of local_llm-job) krijgt dezelfde bewaking: de worktree kan door een container zijn
// omgebogen, dus draait de MCP nooit git met dat pad als werkmap of als `worktree remove`-doel. Beide soorten staan
// per test in GUARDED_JOBS; de gewone job is steeds de controle dat de spy de aanroep wél ziet.
describe('bewaakte jobs: oude worktrees opruimen zonder git', () => {
  const tmpDirs: string[] = []
  const originalWorktreeDir = process.env.SCRUM4ME_AGENT_WORKTREE_DIR
  const findUnique = vi.mocked(prisma.claudeJob.findUnique)
  const execMock = vi.mocked(execFile)

  afterEach(async () => {
    findUnique.mockReset()
    findUnique.mockResolvedValue(null)
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

  // De DB-rij per job-id; een onbekend id geeft null (zoals Prisma).
  function mockJobs(map: Record<string, JobRow>) {
    findUnique.mockImplementation((async (args: { where: { id: string } }) =>
      map[args.where.id] ?? null) as typeof findUnique)
  }

  function worktreeRemoveCalls() {
    return execMock.mock.calls.filter((call) => {
      const [file, args] = call as unknown as [string, string[] | undefined]
      return file === 'git' && Array.isArray(args) && args.includes('worktree') && args.includes('remove')
    })
  }

  function callsWithCwdIn(dir: string) {
    return execMock.mock.calls.filter((call) => {
      const cwd = (call as unknown as [string, string[], { cwd?: string } | undefined])[2]?.cwd
      return typeof cwd === 'string' && path.resolve(cwd) === path.resolve(dir)
    })
  }

  // Een oude job laat zijn worktree op `branchName` achter; daarna vraagt een nieuwe job dezelfde branch.
  async function createStaleOccupant(job: JobRow) {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    await makeWorktreeParent()
    mockJobs({})
    const occupant = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-occupant',
      branchName: 'feat/shared',
      baseRef: 'origin/main',
    })
    // Pushen, zodat de orphan-branch later op de verse-branchroute weer onder dezelfde naam kan terugkomen.
    await git(['push', 'origin', 'feat/shared'], occupant.worktreePath)
    mockJobs({ 'job-occupant': job })
    execMock.mockClear()
    return { repoDir, occupantPath: occupant.worktreePath }
  }

  it.each(GUARDED_JOBS)('reuseBranch: ruimt de bezetter van een $label op zonder git worktree remove', async ({ job }) => {
    const { repoDir, occupantPath } = await createStaleOccupant(job)

    const next = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-next',
      branchName: 'feat/shared',
      baseRef: 'origin/main',
      reuseBranch: true,
    })

    expect(worktreeRemoveCalls()).toEqual([])
    await expect(fs.access(occupantPath)).rejects.toThrow()
    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], next.worktreePath)
    expect(stdout.trim()).toBe('feat/shared')
  })

  it.each(GUARDED_JOBS)('verse branch: ruimt de bezetter van een $label op zonder git worktree remove', async ({ job }) => {
    const { repoDir, occupantPath } = await createStaleOccupant(job)

    const next = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-next',
      branchName: 'feat/shared',
      baseRef: 'origin/main',
    })

    expect(worktreeRemoveCalls()).toEqual([])
    await expect(fs.access(occupantPath)).rejects.toThrow()
    // De bezetter is echt weg: anders kon de orphan-branch niet verwijderd worden en kreeg de nieuwe een suffix.
    expect(next.branchName).toBe('feat/shared')
  })

  it.each([
    { label: 'reuseBranch', reuseBranch: true },
    { label: 'verse branch', reuseBranch: false },
  ])('controle ($label): de bezetter van een gewone job gaat wél via git worktree remove --force', async ({ reuseBranch }) => {
    const { repoDir, occupantPath } = await createStaleOccupant(ORDINARY_JOB)

    await createWorktreeForJob({
      repoRoot: repoDir,
      jobId: 'job-next',
      branchName: 'feat/shared',
      baseRef: 'origin/main',
      reuseBranch,
    })

    expect(worktreeRemoveCalls()).toHaveLength(1)
    expect((worktreeRemoveCalls()[0] as unknown as [string, string[]])[1]).toContain('--force')
    await expect(fs.access(occupantPath)).rejects.toThrow()
  })

  async function createJobWorktree(jobId: string) {
    const { repoDir, originDir } = await setupRepo()
    tmpDirs.push(repoDir, originDir)
    await makeWorktreeParent()
    mockJobs({})
    const created = await createWorktreeForJob({
      repoRoot: repoDir,
      jobId,
      branchName: `feat/${jobId}`,
      baseRef: 'origin/main',
    })
    // Origin heeft de tip: een gewone job zou zijn branch hierna verwijderen.
    await git(['push', 'origin', created.branchName], created.worktreePath)
    return { repoDir, ...created }
  }

  it.each(GUARDED_JOBS)('removeWorktreeForJob: ruimt de worktree van een $label op zonder git in de worktree', async ({ job }) => {
    const { repoDir, worktreePath, branchName } = await createJobWorktree('job-guarded-rm')
    mockJobs({ 'job-guarded-rm': job })
    execMock.mockClear()

    const result = await removeWorktreeForJob({ repoRoot: repoDir, jobId: 'job-guarded-rm' })

    expect(result.removed).toBe(true)
    expect(callsWithCwdIn(worktreePath)).toEqual([])
    expect(worktreeRemoveCalls()).toEqual([])
    await expect(fs.access(worktreePath)).rejects.toThrow()
    // De branch-ref blijft in de clone staan, ook al heeft origin de tip.
    const { stdout } = await exec('git', ['show-ref', '--verify', `refs/heads/${branchName}`], { cwd: repoDir })
    expect(stdout).toContain(branchName)
  })

  it('controle: removeWorktreeForJob van een gewone job draait wél git in de worktree en verwijdert de branch', async () => {
    const { repoDir, worktreePath, branchName } = await createJobWorktree('job-ordinary-rm')
    mockJobs({ 'job-ordinary-rm': ORDINARY_JOB })
    execMock.mockClear()

    const result = await removeWorktreeForJob({ repoRoot: repoDir, jobId: 'job-ordinary-rm' })

    expect(result.removed).toBe(true)
    expect(callsWithCwdIn(worktreePath).length).toBeGreaterThan(0)
    expect(worktreeRemoveCalls()).toHaveLength(1)
    await expect(
      exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd: repoDir }),
    ).rejects.toThrow()
  })
})
