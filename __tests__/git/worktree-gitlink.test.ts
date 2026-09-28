import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

// Forgejo-review PR #169 (BLOCKER): de MCP draait op het groene pad van een
// local_llm-job (push bij done, verify) alleen git tegen een vertrouwde
// worktree-gitlink. Unit-tests per regel van assertTrustedWorktreeGitlink,
// met echte tijdelijke repo's (bare remote, clone, `git worktree add`),
// afgeschermd van de globale git-config (GIT_CONFIG_GLOBAL + NOSYSTEM).
// Daarnaast: gitPrefixFor raakt de controle niet voor een niet-lokale job,
// en verify_task_against_plan geeft een fout bij een afgekeurde gitlink
// zonder git in de worktree.

const authMocks = vi.hoisted(() => ({ getAuth: vi.fn() }))
const resolveMocks = vi.hoisted(() => ({ resolveTaskRef: vi.fn() }))
vi.mock('../../src/auth.js', () => authMocks)
vi.mock('../../src/lib/resolve-entity.js', () => resolveMocks)

vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn(), update: vi.fn() },
    task: { findUnique: vi.fn() },
  },
}))

// Delegerende execFile-spy (zelfde patroon als
// __tests__/update-job-status-local-llm-chain.test.ts), zodat we kunnen
// bewijzen dat er geen git met cwd in de worktree draaide.
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
import {
  assertTrustedWorktreeGitlink,
  assertTrustedLocalJobWorktree,
  gitPrefixFor,
  SAFE_GIT_CONFIG,
  UntrustedWorktreeGitlinkError,
} from '../../src/git/local-llm.js'
import { registerVerifyTaskAgainstPlanTool } from '../../src/tools/verify-task-against-plan.js'

const exec = promisify(execFile)
const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd })
const execMock = vi.mocked(execFile)
const mockPrisma = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  task: { findUnique: ReturnType<typeof vi.fn> }
}

const ENV_KEYS = [
  'SCRUM4ME_AGENT_WORKTREE_DIR', 'SCRUM4ME_REPO_ROOT_prod-1',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
]
const savedEnv: Record<string, string | undefined> = {}
let dir: string, origin: string, clone: string, wtRoot: string, worktreePath: string
const jobId = 'job-gitlink-1'

async function commit(cwd: string, name: string) {
  await fs.writeFile(path.join(cwd, name), name)
  await git(cwd, 'add', '-A')
  await git(cwd, 'commit', '-m', name)
}

async function makeClone(name: string): Promise<string> {
  const c = path.join(dir, name)
  await exec('git', ['clone', '-q', origin, c])
  return c
}

async function adminDirOf(wt: string): Promise<string> {
  const line = (await fs.readFile(path.join(wt, '.git'), 'utf-8')).trim()
  return path.resolve(wt, line.replace(/^gitdir: /, ''))
}

async function expectRejects(reason: RegExp) {
  const p = assertTrustedWorktreeGitlink(worktreePath, clone)
  await expect(p).rejects.toBeInstanceOf(UntrustedWorktreeGitlinkError)
  await expect(p).rejects.toThrow(reason)
}

beforeEach(async () => {
  vi.clearAllMocks()
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-gitlink-'))
  const globalCfg = path.join(dir, 'gitconfig-global')
  await fs.writeFile(globalCfg, '[user]\n\temail = t@t\n\tname = t\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = globalCfg
  process.env.GIT_CONFIG_NOSYSTEM = '1'

  origin = path.join(dir, 'origin.git')
  wtRoot = path.join(dir, 'wt')
  await fs.mkdir(wtRoot)
  process.env.SCRUM4ME_AGENT_WORKTREE_DIR = wtRoot
  await exec('git', ['init', '-q', '--bare', '-b', 'main', origin])
  const seed = path.join(dir, 'seed')
  await exec('git', ['init', '-q', '-b', 'main', seed])
  await commit(seed, 'base.txt')
  await git(seed, 'push', '-q', origin, 'main')

  clone = await makeClone('clone')
  worktreePath = path.join(wtRoot, jobId)
  await git(clone, 'worktree', 'add', '-q', '-b', 'feat/x', worktreePath, 'origin/main')
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await fs.rm(dir, { recursive: true, force: true })
})

describe('assertTrustedWorktreeGitlink', () => {
  it('accepteert een onaangetaste worktree van de clone', async () => {
    await expect(assertTrustedWorktreeGitlink(worktreePath, clone)).resolves.toBeUndefined()
  })

  it('accepteert ook een worktree met relatieve paden (worktree.useRelativePaths)', async () => {
    const rel = path.join(wtRoot, 'job-rel')
    await git(clone, '-c', 'worktree.useRelativePaths=true', 'worktree', 'add', '-q', '-b', 'feat/rel', rel, 'origin/main')
    await expect(assertTrustedWorktreeGitlink(rel, clone)).resolves.toBeUndefined()
  })

  it('weigert een gesymlinkte .git', async () => {
    const real = path.join(dir, 'gitlink-copy')
    await fs.copyFile(path.join(worktreePath, '.git'), real)
    await fs.rm(path.join(worktreePath, '.git'))
    await fs.symlink(real, path.join(worktreePath, '.git'))
    await expectRejects(/\.git van de worktree is een symlink/)
  })

  it('weigert een .git-map', async () => {
    await fs.rm(path.join(worktreePath, '.git'))
    await exec('git', ['init', '-q', worktreePath])
    await expectRejects(/\.git van de worktree is een map/)
  })

  it('weigert een gitlink die niet precies één `gitdir: <pad>`-regel is', async () => {
    const admin = await adminDirOf(worktreePath)
    await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${admin}\ngitdir: /elders\n`)
    await expectRejects(/niet precies één regel/)
  })

  it('weigert een gitdir buiten <repoRoot>/.git/worktrees (worktree van een andere clone)', async () => {
    const other = await makeClone('other')
    const otherWt = path.join(dir, 'other-wt')
    await git(other, 'worktree', 'add', '-q', '-b', 'feat/o', otherWt, 'origin/main')
    await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${await adminDirOf(otherWt)}\n`)
    await expectRejects(/gitdir ligt niet direct onder/)
  })

  it('weigert een gitdir binnen de worktree (container-gemaakte administratie)', async () => {
    const evil = path.join(worktreePath, '.evil')
    await exec('git', ['init', '-q', '--bare', evil])
    await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${evil}\n`)
    await expectRejects(/gitdir ligt niet direct onder/)
  })

  it('weigert een verkeerde terugwijzer <gitdir>/gitdir', async () => {
    const admin = await adminDirOf(worktreePath)
    const otherWt = path.join(wtRoot, 'job-other')
    await git(clone, 'worktree', 'add', '-q', '-b', 'feat/other', otherWt, 'origin/main')
    await fs.writeFile(path.join(admin, 'gitdir'), `${path.join(otherWt, '.git')}\n`)
    await expectRejects(/terugwijzer wijst naar/)
  })

  it('weigert een commondir die niet naar <repoRoot>/.git wijst', async () => {
    const admin = await adminDirOf(worktreePath)
    const other = await makeClone('other')
    await fs.writeFile(path.join(admin, 'commondir'), `${path.join(other, '.git')}\n`)
    await expectRejects(/commondir wijst naar/)
  })

  it('weigert een symlink in de worktree-administratie (HEAD)', async () => {
    const admin = await adminDirOf(worktreePath)
    const outside = path.join(dir, 'HEAD-outside')
    await fs.copyFile(path.join(admin, 'HEAD'), outside)
    await fs.rm(path.join(admin, 'HEAD'))
    await fs.symlink(outside, path.join(admin, 'HEAD'))
    await expectRejects(/HEAD in gitdir is een symlink/)
  })

  it('weigert een repo-root waarvan .git zelf een gitlink is', async () => {
    const linkedRoot = path.join(dir, 'linked-root')
    await git(clone, 'worktree', 'add', '-q', '-b', 'feat/root', linkedRoot, 'origin/main')
    await expect(assertTrustedWorktreeGitlink(worktreePath, linkedRoot)).rejects.toThrow(
      /gitlink-clone niet ondersteund/,
    )
  })

  it('draait zelf nooit git', async () => {
    execMock.mockClear()
    await assertTrustedWorktreeGitlink(worktreePath, clone)
    await fs.writeFile(path.join(worktreePath, '.git'), 'gitdir: /nergens\n')
    await expect(assertTrustedWorktreeGitlink(worktreePath, clone)).rejects.toThrow()
    expect(execMock).not.toHaveBeenCalled()
  })
})

describe('assertTrustedLocalJobWorktree: clone via expliciete roots (zoals de claim)', () => {
  it('resolvet de clone via SCRUM4ME_REPO_ROOT_<productId> en accepteert de worktree', async () => {
    process.env['SCRUM4ME_REPO_ROOT_prod-1'] = clone
    mockPrisma.claudeJob.findUnique.mockResolvedValue({ product_id: 'prod-1', task: { repo_url: null } })
    await expect(assertTrustedLocalJobWorktree(jobId, worktreePath)).resolves.toBeUndefined()
  })

  it('weigert zonder expliciete repo-root (geen ~/Projects-conventie, geen clone)', async () => {
    delete process.env['SCRUM4ME_REPO_ROOT_prod-1']
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      product_id: 'prod-1',
      task: { repo_url: 'https://example.invalid/x/nooit-geconfigureerd-repo.git' },
    })
    await expect(assertTrustedLocalJobWorktree(jobId, worktreePath)).rejects.toThrow(
      /geen expliciete repo-root/,
    )
  })

  it('weigert wanneer de job of het product onbekend is', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(null)
    await expect(assertTrustedLocalJobWorktree(jobId, worktreePath)).rejects.toThrow(/onbekend/)
  })
})

describe('gitPrefixFor: controle alleen voor local_llm', () => {
  it('niet-lokale job: prefix [] en de controle wordt niet aangeroepen (ook niet bij een .git-map)', async () => {
    await fs.rm(path.join(worktreePath, '.git'))
    await fs.mkdir(path.join(worktreePath, '.git')) // zou de controle laten falen
    mockPrisma.claudeJob.findUnique.mockResolvedValue({ required_capability: null })

    await expect(gitPrefixFor(worktreePath)).resolves.toEqual([])
    // Alleen de bestaande required_capability-lookup — geen job/repo-lookup
    // voor de repo-root-resolutie van de controle.
    expect(mockPrisma.claudeJob.findUnique).toHaveBeenCalledTimes(1)
    expect(mockPrisma.claudeJob.findUnique).toHaveBeenCalledWith({
      where: { id: jobId },
      select: { required_capability: true },
    })
  })

  it('local_llm-job met onaangetaste worktree: SAFE_GIT_CONFIG', async () => {
    process.env['SCRUM4ME_REPO_ROOT_prod-1'] = clone
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      required_capability: 'local_llm', product_id: 'prod-1', task: { repo_url: null },
    })
    await expect(gitPrefixFor(worktreePath)).resolves.toEqual([...SAFE_GIT_CONFIG])
  })
})

describe('verify_task_against_plan: afgekeurde gitlink ⇒ fout, geen git in de worktree', () => {
  function registerHandler() {
    let handler: ((input: { task_id: string; worktree_path: string }) => Promise<unknown>) | null = null
    registerVerifyTaskAgainstPlanTool({
      registerTool: (_n: string, _c: unknown, cb: typeof handler) => {
        handler = cb
      },
    } as never)
    return handler!
  }

  it('geeft een toolfout met de gitlink-melding en slaat geen verify_result op', async () => {
    process.env['SCRUM4ME_REPO_ROOT_prod-1'] = clone
    authMocks.getAuth.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' })
    resolveMocks.resolveTaskRef.mockResolvedValue({ id: 'task-1' })
    mockPrisma.task.findUnique.mockResolvedValue({
      id: 'task-1',
      verify_only: false,
      claude_jobs: [{ id: jobId, plan_snapshot: 'plan', base_sha: 'abc123' }],
    })
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      required_capability: 'local_llm', product_id: 'prod-1', task: { repo_url: null },
    })
    const evil = path.join(worktreePath, '.evil')
    await exec('git', ['init', '-q', '--bare', evil])
    await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${evil}\n`)

    execMock.mockClear()
    const result = (await registerHandler()({ task_id: 'task-1', worktree_path: worktreePath })) as {
      isError?: boolean
      content: Array<{ text: string }>
    }

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/git-administratie van de worktree wijst niet naar de clone/)
    expect(execMock).not.toHaveBeenCalled()
    expect(mockPrisma.claudeJob.update).not.toHaveBeenCalled()
  })
})
