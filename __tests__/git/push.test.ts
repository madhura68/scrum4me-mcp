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

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

// Deze tests dekken de niet-lokale weg (geen local_llm-job); de findUnique-mock
// zorgt dat isLocalLlmJob() altijd false teruggeeft zonder een echte DB nodig
// te hebben. Het local_llm-pad (SAFE_GIT_CONFIG + --no-verify) zit in het
// 'pushBranchForJob: local_llm-vlaggen'-blok hieronder.
vi.mock('../../src/prisma.js', () => ({
  prisma: { claudeJob: { findUnique: vi.fn().mockResolvedValue(null) } },
}))

import { execFile } from 'node:child_process'
import { prisma } from '../../src/prisma.js'
import { pushBranchForJob } from '../../src/git/push.js'
import { SAFE_GIT_CONFIG } from '../../src/git/local-llm.js'

// promisify(execFile) will call execFile(cmd, args, opts, cb) internally
type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void
const mockExec = execFile as unknown as ReturnType<typeof vi.fn>
const findUnique = vi.mocked(prisma.claudeJob.findUnique)

const SHA_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SHA_BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

beforeEach(() => {
  vi.clearAllMocks()
  findUnique.mockResolvedValue(null)
})

describe('pushBranchForJob', () => {
  it('returns pushed=true with remoteRef on successful push', async () => {
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes('HEAD')) return cb(null, { stdout: `${SHA_HEAD}\n`, stderr: '' })
      if (args.includes('origin/main')) return cb(null, { stdout: `${SHA_BASE}\n`, stderr: '' })
      // git push -u origin <branch>
      return cb(null, { stdout: '', stderr: '' })
    })

    const result = await pushBranchForJob({ worktreePath: '/wt/job-abc', branchName: 'feat/job-abc' })

    expect(result).toEqual({ pushed: true, remoteRef: 'refs/heads/feat/job-abc' })
  })

  it('returns no-changes when HEAD equals origin/main', async () => {
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes('HEAD') || args.includes('origin/main')) {
        return cb(null, { stdout: `${SHA_BASE}\n`, stderr: '' })
      }
      return cb(null, { stdout: '', stderr: '' })
    })

    const result = await pushBranchForJob({ worktreePath: '/wt/job-abc', branchName: 'feat/job-abc' })

    expect(result).toEqual({ pushed: false, reason: 'no-changes', stderr: '' })
  })

  it('returns no-credentials when push fails with Authentication failed', async () => {
    const authError = Object.assign(new Error('git push failed'), {
      stderr: 'fatal: Authentication failed for https://github.com/...',
    })
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes('HEAD')) return cb(null, { stdout: `${SHA_HEAD}\n`, stderr: '' })
      if (args.includes('origin/main')) return cb(null, { stdout: `${SHA_BASE}\n`, stderr: '' })
      return cb(authError)
    })

    const result = await pushBranchForJob({ worktreePath: '/wt/job-abc', branchName: 'feat/job-abc' })

    expect(result).toMatchObject({ pushed: false, reason: 'no-credentials' })
    expect((result as { stderr: string }).stderr).toContain('Authentication failed')
  })

  it('returns conflict when push is rejected (non-fast-forward)', async () => {
    const conflictError = Object.assign(new Error('git push failed'), {
      stderr: '! [rejected] feat/job-abc -> feat/job-abc (non-fast-forward)',
    })
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes('HEAD')) return cb(null, { stdout: `${SHA_HEAD}\n`, stderr: '' })
      if (args.includes('origin/main')) return cb(null, { stdout: `${SHA_BASE}\n`, stderr: '' })
      return cb(conflictError)
    })

    const result = await pushBranchForJob({ worktreePath: '/wt/job-abc', branchName: 'feat/job-abc' })

    expect(result).toMatchObject({ pushed: false, reason: 'conflict' })
  })

  it('returns unknown for unrecognised push errors', async () => {
    const unknownError = Object.assign(new Error('git push failed'), {
      stderr: 'error: some unexpected thing happened',
    })
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes('HEAD')) return cb(null, { stdout: `${SHA_HEAD}\n`, stderr: '' })
      if (args.includes('origin/main')) return cb(null, { stdout: `${SHA_BASE}\n`, stderr: '' })
      return cb(unknownError)
    })

    const result = await pushBranchForJob({ worktreePath: '/wt/job-abc', branchName: 'feat/job-abc' })

    expect(result).toMatchObject({ pushed: false, reason: 'unknown' })
  })
})

// Taak 4: pushBranchForJob draait op het groene pad ná de harness-scan — voor
// een local_llm-job krijgen alle git-aanroepen (de twee rev-parses en de push
// zelf) SAFE_GIT_CONFIG, en de push zelf ook --no-verify.
describe('pushBranchForJob: local_llm-vlaggen (Taak 4)', () => {
  const originalEnv = process.env.SCRUM4ME_AGENT_WORKTREE_DIR

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    else process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv
  })

  it('voegt SAFE_GIT_CONFIG en --no-verify toe voor een local_llm-job', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    findUnique.mockResolvedValue(
      { required_capability: 'local_llm' } as unknown as Awaited<ReturnType<typeof findUnique>>,
    )
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes('HEAD')) return cb(null, { stdout: `${SHA_HEAD}\n`, stderr: '' })
      if (args.includes('origin/main')) return cb(null, { stdout: `${SHA_BASE}\n`, stderr: '' })
      return cb(null, { stdout: '', stderr: '' })
    })

    const result = await pushBranchForJob({ worktreePath: '/wt/job-local', branchName: 'feat/job-local' })

    expect(result).toEqual({ pushed: true, remoteRef: 'refs/heads/feat/job-local' })
    const pushCall = mockExec.mock.calls.find((c) => (c[1] as string[]).includes('push'))
    expect(pushCall![1]).toEqual([...SAFE_GIT_CONFIG, 'push', '--no-verify', '-u', 'origin', 'feat/job-local'])
    const revParseCalls = mockExec.mock.calls.filter((c) => (c[1] as string[]).includes('rev-parse'))
    expect(revParseCalls.length).toBeGreaterThan(0)
    for (const call of revParseCalls) {
      expect((call[1] as string[]).slice(0, SAFE_GIT_CONFIG.length)).toEqual([...SAFE_GIT_CONFIG])
    }
    expect(gitlinkMocks.assertTrustedLocalJobWorktree).toHaveBeenCalled()
  })

  it('laat de argumenten ongewijzigd voor een niet-lokale job (geen --no-verify)', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    findUnique.mockResolvedValue(null)
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args.includes('HEAD')) return cb(null, { stdout: `${SHA_HEAD}\n`, stderr: '' })
      if (args.includes('origin/main')) return cb(null, { stdout: `${SHA_BASE}\n`, stderr: '' })
      return cb(null, { stdout: '', stderr: '' })
    })

    const result = await pushBranchForJob({ worktreePath: '/wt/job-normal', branchName: 'feat/job-normal' })

    expect(result).toEqual({ pushed: true, remoteRef: 'refs/heads/feat/job-normal' })
    const pushCall = mockExec.mock.calls.find((c) => (c[1] as string[]).includes('push'))
    expect(pushCall![1]).toEqual(['push', '-u', 'origin', 'feat/job-normal'])
    expect(gitlinkMocks.assertTrustedLocalJobWorktree).not.toHaveBeenCalled()
  })
})
