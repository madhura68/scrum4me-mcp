import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

import { execFile } from 'node:child_process'
import { pushBranchForJob } from '../../src/git/push.js'

// promisify(execFile) will call execFile(cmd, args, opts, cb) internally
type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void
const mockExec = execFile as unknown as ReturnType<typeof vi.fn>

const SHA_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SHA_BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

beforeEach(() => {
  vi.clearAllMocks()
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
