// Taak 4: getGitDiff (verify_task_against_plan) draait op het groene pad
// ná de harness-scan en krijgt daarom gitPrefixFor(worktreePath) vóór `diff`.
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

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('../../src/prisma.js', () => ({
  prisma: { claudeJob: { findUnique: vi.fn() } },
}))

import { execFile } from 'node:child_process'
import { prisma } from '../../src/prisma.js'
import { getGitDiff } from '../../src/git/diff.js'
import { SAFE_GIT_CONFIG } from '../../src/git/local-llm.js'

type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void
const mockExec = execFile as unknown as ReturnType<typeof vi.fn>
const findUnique = vi.mocked(prisma.claudeJob.findUnique)

beforeEach(() => {
  vi.clearAllMocks()
  mockExec.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) =>
    cb(null, { stdout: 'diff --git a/x b/x\n', stderr: '' }),
  )
})

describe('getGitDiff', () => {
  const originalEnv = process.env.SCRUM4ME_AGENT_WORKTREE_DIR

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    else process.env.SCRUM4ME_AGENT_WORKTREE_DIR = originalEnv
  })

  it('voegt SAFE_GIT_CONFIG toe vóór diff voor een local_llm-worktree', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    findUnique.mockResolvedValue(
      { required_capability: 'local_llm' } as unknown as Awaited<ReturnType<typeof findUnique>>,
    )

    const result = await getGitDiff('/wt/job-1', 'abc..def')

    expect(result).toBe('diff --git a/x b/x\n')
    expect(mockExec).toHaveBeenCalledWith(
      'git',
      [...SAFE_GIT_CONFIG, 'diff', 'abc..def'],
      expect.objectContaining({ cwd: '/wt/job-1' }),
      expect.any(Function),
    )
    expect(gitlinkMocks.assertTrustedLocalJobWorktree).toHaveBeenCalledWith('job-1', '/wt/job-1')
  })

  it('draait geen git diff wanneer de gitlink-controle van een local_llm-worktree faalt', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    findUnique.mockResolvedValue(
      { required_capability: 'local_llm' } as unknown as Awaited<ReturnType<typeof findUnique>>,
    )
    gitlinkMocks.assertTrustedLocalJobWorktree.mockRejectedValueOnce(new Error('gitlink afgekeurd'))

    await expect(getGitDiff('/wt/job-1', 'abc..def')).rejects.toThrow('gitlink afgekeurd')
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('laat de argumenten ongewijzigd voor een niet-lokale worktree', async () => {
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
    findUnique.mockResolvedValue(null)

    await getGitDiff('/wt/job-2', 'abc..def')

    expect(mockExec).toHaveBeenCalledWith(
      'git',
      ['diff', 'abc..def'],
      expect.objectContaining({ cwd: '/wt/job-2' }),
      expect.any(Function),
    )
    expect(gitlinkMocks.assertTrustedLocalJobWorktree).not.toHaveBeenCalled()
  })

  it('laat de argumenten ongewijzigd wanneer het pad geen jobworktree is (geen DB-lookup)', async () => {
    // Geen SCRUM4ME_AGENT_WORKTREE_DIR-match ⇒ jobIdFromWorktreePath geeft
    // null, dus isLocalLlmJob wordt nooit aangeroepen.
    await getGitDiff('/elsewhere/job-3', 'abc..def')

    expect(findUnique).not.toHaveBeenCalled()
    expect(mockExec).toHaveBeenCalledWith(
      'git',
      ['diff', 'abc..def'],
      expect.objectContaining({ cwd: '/elsewhere/job-3' }),
      expect.any(Function),
    )
  })
})
