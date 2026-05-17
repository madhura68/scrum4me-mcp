import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

import { execFile } from 'node:child_process'
import { deleteRemoteBranch } from '../../src/git/push.js'

type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void
const mockExec = execFile as unknown as ReturnType<typeof vi.fn>

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('deleteRemoteBranch — head-SHA-guard', () => {
  it('zonder guard: pusht direct delete (backward-compat)', async () => {
    const calls: string[][] = []
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      calls.push(args)
      cb(null, { stdout: '', stderr: '' })
    })

    const result = await deleteRemoteBranch({ repoRoot: '/repo', branch: 'feat/x' })

    expect(result).toEqual({ deleted: true })
    // Geen ls-remote call: alleen 1 git-call (de push --delete).
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual(['push', 'origin', '--delete', 'feat/x'])
  })

  it('met match: ls-remote SHA equals expected → push --delete uitgevoerd', async () => {
    const calls: string[][] = []
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      calls.push(args)
      if (args[0] === 'ls-remote') {
        return cb(null, { stdout: `${SHA_A}\trefs/heads/feat/x\n`, stderr: '' })
      }
      cb(null, { stdout: '', stderr: '' })
    })

    const result = await deleteRemoteBranch({
      repoRoot: '/repo',
      branch: 'feat/x',
      expectedHeadSha: SHA_A,
    })

    expect(result).toEqual({ deleted: true })
    expect(calls[0]).toEqual(['ls-remote', 'origin', 'refs/heads/feat/x'])
    expect(calls[1]).toEqual(['push', 'origin', '--delete', 'feat/x'])
  })

  it('met mismatch: weigert delete met head-mismatch reason', async () => {
    const calls: string[][] = []
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      calls.push(args)
      if (args[0] === 'ls-remote') {
        return cb(null, { stdout: `${SHA_B}\trefs/heads/feat/x\n`, stderr: '' })
      }
      cb(null, { stdout: '', stderr: '' })
    })

    const result = await deleteRemoteBranch({
      repoRoot: '/repo',
      branch: 'feat/x',
      expectedHeadSha: SHA_A,
    })

    expect(result).toMatchObject({
      deleted: false,
      reason: 'head-mismatch',
    })
    expect((result as { stderr: string }).stderr).toContain(SHA_A)
    expect((result as { stderr: string }).stderr).toContain(SHA_B)
    // Push --delete moet NIET zijn aangeroepen.
    expect(calls.find((c) => c[0] === 'push')).toBeUndefined()
  })

  it('met guard + remote ref al weg: delete returnt not-found', async () => {
    const calls: string[][] = []
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      calls.push(args)
      if (args[0] === 'ls-remote') {
        // Empty stdout = branch al weg
        return cb(null, { stdout: '', stderr: '' })
      }
      // push --delete tegen niet-bestaande ref
      const err = Object.assign(new Error('git push failed'), {
        stderr: "error: unable to delete 'feat/x': remote ref does not exist",
      })
      cb(err)
    })

    const result = await deleteRemoteBranch({
      repoRoot: '/repo',
      branch: 'feat/x',
      expectedHeadSha: SHA_A,
    })

    expect(result).toMatchObject({ deleted: false, reason: 'not-found' })
  })

  it('ls-remote failure → unknown reason zonder delete', async () => {
    mockExec.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      if (args[0] === 'ls-remote') {
        const err = Object.assign(new Error('ls-remote failed'), {
          stderr: 'fatal: unable to access origin',
        })
        return cb(err)
      }
      cb(null, { stdout: '', stderr: '' })
    })

    const result = await deleteRemoteBranch({
      repoRoot: '/repo',
      branch: 'feat/x',
      expectedHeadSha: SHA_A,
    })

    expect(result).toMatchObject({ deleted: false, reason: 'unknown' })
  })
})
