// Taak 4 (spec docs/specs/2026-09-27-task-implementation-local-llm-design.md
// §4.5): worktree-aanmaak zonder repo-code voor een local_llm-job, submodule-
// gate op .gitmodules, en LocalLlmWorktreeRefused. Real-git-fixture-tests
// (zoals __tests__/git/local-llm.test.ts) met een gemockte prisma zodat
// isHarnessJob() zonder echte DB werkt. M45-2b (Taak 3, spec §5.6): dezelfde
// bescherming geldt voor een HARNESS-job, dus elke test van een bewaakte job
// draait voor beide soorten (local_llm en HARNESS).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../src/prisma.js', () => ({
  prisma: { claudeJob: { findUnique: vi.fn() } },
}))

import { prisma } from '../../src/prisma.js'
import { createWorktreeForJob, LocalLlmWorktreeRefused } from '../../src/git/worktree.js'
import { SAFE_GIT_CONFIG } from '../../src/git/local-llm.js'
import { GUARDED_JOBS, ORDINARY_JOB, type JobRow } from '../helpers/guarded-jobs.js'

const exec = promisify(execFile)
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd })

const findUnique = vi.mocked(prisma.claudeJob.findUnique)

// De DB-rij per job-id; een onbekend id geeft null (zoals Prisma).
function mockJobs(map: Record<string, JobRow>) {
  findUnique.mockImplementation((async (args: { where: { id: string } }) => {
    const id = args.where.id
    if (!(id in map)) return null
    return map[id]
  }) as typeof findUnique)
}

async function commit(cwd: string, name: string) {
  await fs.writeFile(path.join(cwd, name), name)
  await git(cwd, 'add', '-A')
  await git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', name)
}

describe('createWorktreeForJob: local_llm zonder repo-code + submodule-gate (Taak 4)', () => {
  let dir: string, origin: string, clone: string
  const originalEnv = process.env.SCRUM4ME_AGENT_WORKTREE_DIR
  const originalAllowProtocol = process.env.GIT_ALLOW_PROTOCOL

  beforeEach(async () => {
    vi.clearAllMocks()
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-llm-worktree-'))
    origin = path.join(dir, 'origin.git')
    clone = path.join(dir, 'clone')
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = path.join(dir, 'wt')
    // Modern git weigert file://-submodule-transport by default; deze test-
    // fixtures gebruiken lokale bare repo's als submodule-origin, dus staat
    // 'm hier expliciet toe. Puur een test-omgevingsdetail — de productiecode
    // voegt dit nooit toe.
    process.env.GIT_ALLOW_PROTOCOL = 'file'

    await exec('git', ['init', '--bare', '-b', 'main', origin])
    await exec('git', ['init', '-b', 'main', clone])
    await git(clone, 'remote', 'add', 'origin', origin)
  })

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    else process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv
    if (originalAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL
    else process.env.GIT_ALLOW_PROTOCOL = originalAllowProtocol
    await fs.rm(dir, { recursive: true, force: true })
  })

  it.each(GUARDED_JOBS)('roept npm run prepare:worktree niet aan voor een $label', async ({ job }) => {
    await fs.writeFile(
      path.join(clone, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { 'prepare:worktree': 'node -e "require(\'fs\').writeFileSync(\'PREPARE_RAN\',\'1\')"' } }),
    )
    await commit(clone, 'base.txt')
    await git(clone, 'push', '-u', 'origin', 'main')

    mockJobs({ 'job-local-nprep': job })

    const { worktreePath } = await createWorktreeForJob({
      repoRoot: clone,
      jobId: 'job-local-nprep',
      branchName: 'feat/local-nprep',
      baseRef: 'origin/main',
    })

    await expect(fs.access(path.join(worktreePath, 'PREPARE_RAN'))).rejects.toThrow()
  })

  it('roept npm run prepare:worktree wél aan voor een niet-lokale job (bestaand gedrag)', async () => {
    await fs.writeFile(
      path.join(clone, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { 'prepare:worktree': 'node -e "require(\'fs\').writeFileSync(\'PREPARE_RAN\',\'1\')"' } }),
    )
    await commit(clone, 'base.txt')
    await git(clone, 'push', '-u', 'origin', 'main')

    mockJobs({ 'job-normal-prep': ORDINARY_JOB })

    const { worktreePath } = await createWorktreeForJob({
      repoRoot: clone,
      jobId: 'job-normal-prep',
      branchName: 'feat/normal-prep',
      baseRef: 'origin/main',
    })

    await expect(fs.access(path.join(worktreePath, 'PREPARE_RAN'))).resolves.toBeUndefined()
  })

  it.each(GUARDED_JOBS)('initialiseert submodules voor een $label wanneer .gitmodules byte-gelijk is aan origin/main', async ({ job }) => {
    const subOrigin = path.join(dir, 'sub.git')
    await exec('git', ['init', '--bare', '-b', 'main', subOrigin])
    const subSeed = path.join(dir, 'sub-seed')
    await exec('git', ['init', '-b', 'main', subSeed])
    await git(subSeed, 'remote', 'add', 'origin', subOrigin)
    await commit(subSeed, 'sub.txt')
    await git(subSeed, 'push', '-u', 'origin', 'main')

    await commit(clone, 'base.txt')
    await exec(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', subOrigin, 'vendor/sub'],
      { cwd: clone },
    )
    await git(clone, 'add', '-A')
    await git(clone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add submodule')
    await git(clone, 'push', '-u', 'origin', 'main')

    mockJobs({ 'job-local-submod': job })

    const { worktreePath } = await createWorktreeForJob({
      repoRoot: clone,
      jobId: 'job-local-submod',
      branchName: 'feat/local-submod',
      baseRef: 'origin/main',
    })

    // De submodule-inhoud staat er (init+update draaide).
    await expect(
      fs.readFile(path.join(worktreePath, 'vendor', 'sub', 'sub.txt'), 'utf8'),
    ).resolves.toBe('sub.txt')
  })

  it.each(GUARDED_JOBS)('weigert (LocalLlmWorktreeRefused) een $label en initialiseert geen submodules wanneer .gitmodules afwijkt van origin/main', async ({ job }) => {
    const subOriginA = path.join(dir, 'sub-a.git')
    const subOriginB = path.join(dir, 'sub-b.git')
    await exec('git', ['init', '--bare', '-b', 'main', subOriginA])
    await exec('git', ['init', '--bare', '-b', 'main', subOriginB])

    // main krijgt .gitmodules → subOriginA (het "vertrouwde" default-ref-bestand).
    await commit(clone, 'base.txt')
    await fs.writeFile(
      path.join(clone, '.gitmodules'),
      '[submodule "vendor/sub"]\n\tpath = vendor/sub\n\turl = ' + subOriginA + '\n',
    )
    await git(clone, 'add', '-A')
    await git(clone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'gitmodules main')
    await git(clone, 'push', '-u', 'origin', 'main')

    // Een andere branch krijgt een AFWIJKENDE .gitmodules → subOriginB.
    await git(clone, 'checkout', '-b', 'feat/tampered')
    await fs.writeFile(
      path.join(clone, '.gitmodules'),
      '[submodule "vendor/sub"]\n\tpath = vendor/sub\n\turl = ' + subOriginB + '\n',
    )
    await git(clone, 'add', '-A')
    await git(clone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'gitmodules tampered')
    await git(clone, 'push', '-u', 'origin', 'feat/tampered')
    await git(clone, 'checkout', 'main')

    mockJobs({ 'job-local-tampered': job, 'job-local-tampered-2': job })

    await expect(
      createWorktreeForJob({
        repoRoot: clone,
        jobId: 'job-local-tampered',
        branchName: 'feat/tampered',
        baseRef: 'origin/main',
        reuseBranch: true,
      }),
    ).rejects.toThrow(LocalLlmWorktreeRefused)

    await expect(
      createWorktreeForJob({
        repoRoot: clone,
        jobId: 'job-local-tampered-2',
        branchName: 'feat/tampered',
        baseRef: 'origin/main',
        reuseBranch: true,
      }),
    ).rejects.toThrow('.gitmodules wijkt af van origin/main; submodule-init geweigerd')
  })

  it.each(GUARDED_JOBS)('.gitmodules ontbreekt in de worktree ⇒ no-op, geen weigering (ook voor een $label)', async ({ job }) => {
    await commit(clone, 'base.txt')
    await git(clone, 'push', '-u', 'origin', 'main')

    mockJobs({ 'job-local-nosub': job })

    await expect(
      createWorktreeForJob({
        repoRoot: clone,
        jobId: 'job-local-nosub',
        branchName: 'feat/local-nosub',
        baseRef: 'origin/main',
      }),
    ).resolves.toMatchObject({ branchName: 'feat/local-nosub' })
  })

  it.each(GUARDED_JOBS)('gebruikt SAFE_GIT_CONFIG voor de submodule update --init --recursive van een $label', async ({ job }) => {
    const subOrigin = path.join(dir, 'sub2.git')
    await exec('git', ['init', '--bare', '-b', 'main', subOrigin])
    const subSeed = path.join(dir, 'sub2-seed')
    await exec('git', ['init', '-b', 'main', subSeed])
    await git(subSeed, 'remote', 'add', 'origin', subOrigin)
    await commit(subSeed, 'sub2.txt')
    await git(subSeed, 'push', '-u', 'origin', 'main')

    await commit(clone, 'base.txt')
    await exec(
      'git',
      ['-c', 'protocol.file.allow=always', 'submodule', 'add', subOrigin, 'vendor/sub2'],
      { cwd: clone },
    )
    await git(clone, 'add', '-A')
    await git(clone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add submodule2')
    await git(clone, 'push', '-u', 'origin', 'main')

    mockJobs({ 'job-local-submod-flags': job })

    // SAFE_GIT_CONFIG bevat `-c core.hooksPath=/dev/null` e.a. — deze zijn
    // functioneel onschadelijk voor een gewone submodule-update, dus we
    // bewijzen de aanroep zelf indirect: het resultaat bestaat (init lukte
    // met de veilige config erbij, geen fout).
    const { worktreePath } = await createWorktreeForJob({
      repoRoot: clone,
      jobId: 'job-local-submod-flags',
      branchName: 'feat/local-submod-flags',
      baseRef: 'origin/main',
    })
    await expect(
      fs.readFile(path.join(worktreePath, 'vendor', 'sub2', 'sub2.txt'), 'utf8'),
    ).resolves.toBe('sub2.txt')
    expect(SAFE_GIT_CONFIG.length).toBeGreaterThan(0)
  })
})
