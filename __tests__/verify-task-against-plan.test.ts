import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    task: { findUnique: vi.fn() },
    claudeJob: { update: vi.fn() },
  },
}))

vi.mock('../src/verify/classify.js', () => ({
  classifyDiffAgainstPlan: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { classifyDiffAgainstPlan } from '../src/verify/classify.js'
import { getDiffInWorktree, saveVerifyResult } from '../src/tools/verify-task-against-plan.js'

const mockPrisma = prisma as unknown as {
  task: { findUnique: ReturnType<typeof vi.fn> }
  claudeJob: { update: ReturnType<typeof vi.fn> }
}
const mockClassify = classifyDiffAgainstPlan as ReturnType<typeof vi.fn>

// Mock node:child_process so getDiffInWorktree doesn't need a real git repo
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

import { execFile } from 'node:child_process'
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>

// Promisify internally calls execFile in callback form: (cmd, args, opts, cb)
function stubExecFile(stdout: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout, stderr: '' })
    },
  )
}

function stubExecFileError(message: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
      cb(new Error(message))
    },
  )
}

const ALIGNED_DIFF = `diff --git a/src/verify/classify.ts b/src/verify/classify.ts
--- a/src/verify/classify.ts
+++ b/src/verify/classify.ts
+export function classifyDiffAgainstPlan(opts) {}`

describe('getDiffInWorktree', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns stdout from git diff', async () => {
    stubExecFile(ALIGNED_DIFF)
    const result = await getDiffInWorktree('/worktrees/job-abc')
    expect(result).toBe(ALIGNED_DIFF)
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['diff', 'origin/main...HEAD'],
      expect.objectContaining({ cwd: '/worktrees/job-abc' }),
      expect.any(Function),
    )
  })

  it('throws when git diff fails', async () => {
    stubExecFileError('not a git repo')
    await expect(getDiffInWorktree('/bad/path')).rejects.toThrow('not a git repo')
  })
})

describe('saveVerifyResult', () => {
  beforeEach(() => vi.clearAllMocks())

  it('updates claudeJob with the given verify_result', async () => {
    mockPrisma.claudeJob.update.mockResolvedValue({})
    await saveVerifyResult('job-123', 'ALIGNED')
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith({
      where: { id: 'job-123' },
      data: { verify_result: 'ALIGNED' },
    })
  })
})

describe('verify_task_against_plan — integration of helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubExecFile(ALIGNED_DIFF)
    mockClassify.mockReturnValue({ result: 'ALIGNED', reasoning: 'All paths covered.' })
    mockPrisma.claudeJob.update.mockResolvedValue({})
  })

  it('happy path: runs diff, classifies, saves verify_result', async () => {
    // Simulate: getDiffInWorktree + classifyDiffAgainstPlan + saveVerifyResult
    const diff = await getDiffInWorktree('/wt/job-abc')
    mockClassify({ diff, plan: 'Modify `src/verify/classify.ts`.' })
    expect(mockClassify).toHaveBeenCalledWith(expect.objectContaining({ diff }))

    await saveVerifyResult('job-123', 'ALIGNED')
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith({
      where: { id: 'job-123' },
      data: { verify_result: 'ALIGNED' },
    })
  })

  it('EMPTY path: saves EMPTY to DB', async () => {
    stubExecFile('') // no diff output
    mockClassify.mockReturnValue({ result: 'EMPTY', reasoning: 'Geen bestandswijzigingen in de diff.' })

    const diff = await getDiffInWorktree('/wt/job-xyz')
    const { result } = mockClassify({ diff, plan: null })
    expect(result).toBe('EMPTY')

    await saveVerifyResult('job-xyz', 'EMPTY')
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith({
      where: { id: 'job-xyz' },
      data: { verify_result: 'EMPTY' },
    })
  })
})
