// Taak 4: resolveOriginDefaultRef draait zowel op het groene pad (cwd =
// local_llm-jobworktree, via push.ts) als bij claim (cwd = repoRoot, via
// createWorktreeForJob) — beide `git`-aanroepen (remote set-head, symbolic-ref)
// krijgen gitPrefixFor(cwd) vóór de subcommand. Losse mocked-execFile-tests
// (niet de real-git-fixture-tests in __tests__/default-branch.test.ts) zodat
// we de exacte argumenten kunnen asserten zonder de bestaande ISS-3-fixtures
// aan te raken.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('../../src/prisma.js', () => ({
  prisma: { claudeJob: { findUnique: vi.fn() } },
}))

import { execFile } from 'node:child_process'
import { prisma } from '../../src/prisma.js'
import { resolveOriginDefaultRef } from '../../src/git/default-branch.js'
import { SAFE_GIT_CONFIG } from '../../src/git/local-llm.js'

type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void
const mockExec = execFile as unknown as ReturnType<typeof vi.fn>
const findUnique = vi.mocked(prisma.claudeJob.findUnique)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveOriginDefaultRef: SAFE_GIT_CONFIG voor local_llm (Taak 4)', () => {
  const originalEnv = process.env.SCRUM4ME_AGENT_WORKTREE_DIR

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    else process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv
  })

  it('voegt SAFE_GIT_CONFIG toe aan remote set-head en symbolic-ref voor een local_llm-worktree', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    findUnique.mockResolvedValue(
      { required_capability: 'local_llm' } as unknown as Awaited<ReturnType<typeof findUnique>>,
    )
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes('symbolic-ref')) return cb(null, { stdout: 'origin/main\n', stderr: '' })
      return cb(null, { stdout: '', stderr: '' })
    })

    const ref = await resolveOriginDefaultRef('/wt/job-1')

    expect(ref).toBe('origin/main')
    const setHeadCall = mockExec.mock.calls.find((c) => (c[1] as string[]).includes('set-head'))
    const symbolicRefCall = mockExec.mock.calls.find((c) => (c[1] as string[]).includes('symbolic-ref'))
    expect(setHeadCall).toBeDefined()
    expect(symbolicRefCall).toBeDefined()
    expect(setHeadCall![1]).toEqual([...SAFE_GIT_CONFIG, 'remote', 'set-head', 'origin', '--auto'])
    expect(symbolicRefCall![1]).toEqual([...SAFE_GIT_CONFIG, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  })

  it('laat de argumenten ongewijzigd voor een niet-lokale cwd', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    findUnique.mockResolvedValue(null)
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes('symbolic-ref')) return cb(null, { stdout: 'origin/main\n', stderr: '' })
      return cb(null, { stdout: '', stderr: '' })
    })

    await resolveOriginDefaultRef('/wt/job-2')

    const setHeadCall = mockExec.mock.calls.find((c) => (c[1] as string[]).includes('set-head'))
    const symbolicRefCall = mockExec.mock.calls.find((c) => (c[1] as string[]).includes('symbolic-ref'))
    expect(setHeadCall![1]).toEqual(['remote', 'set-head', 'origin', '--auto'])
    expect(symbolicRefCall![1]).toEqual(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  })

  it('laat de argumenten ongewijzigd voor repoRoot (geen jobworktree-pad, geen DB-lookup)', async () => {
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes('symbolic-ref')) return cb(null, { stdout: 'origin/master\n', stderr: '' })
      return cb(null, { stdout: '', stderr: '' })
    })

    const ref = await resolveOriginDefaultRef('/repos/my-project')

    expect(ref).toBe('origin/master')
    expect(findUnique).not.toHaveBeenCalled()
    const setHeadCall = mockExec.mock.calls.find((c) => (c[1] as string[]).includes('set-head'))
    expect(setHeadCall![1]).toEqual(['remote', 'set-head', 'origin', '--auto'])
  })
})
