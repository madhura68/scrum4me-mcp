import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import {
  cloneRepoOnDemand,
  TerminalJobError,
  TransientRepoError,
  OwnershipLostError,
  type CloneOwnerCtx,
} from '../src/git/on-demand-clone.js'

function execError(stderr: string): Error {
  const e = new Error('Command failed') as Error & { stderr?: string }
  e.stderr = stderr
  return e
}

// A routing exec double. Real filesystem side effects (creating <dest>/.git)
// so the helper's atomicity/rename logic runs for real.
function makeExec(opts: {
  cloneError?: Error
  installError?: Error
  withPackage?: boolean
  withLock?: boolean
  corruptDirs?: string[]
}) {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = []
  const exec = async (cmd: string, args: string[], o?: { cwd?: string }) => {
    calls.push({ cmd, args, cwd: o?.cwd })
    if (cmd === 'git' && args[0] === 'clone') {
      if (opts.cloneError) throw opts.cloneError
      const dest = args[2]
      await fs.mkdir(path.join(dest, '.git'), { recursive: true })
      if (opts.withPackage) {
        await fs.writeFile(path.join(dest, 'package.json'), '{}')
        if (opts.withLock !== false) await fs.writeFile(path.join(dest, 'package-lock.json'), '{}')
      }
      return { stdout: '', stderr: '' }
    }
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return { stdout: 'origin/main\n', stderr: '' }
    }
    if (cmd === 'git' && args[0] === 'reset') return { stdout: '', stderr: '' }
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      if (opts.corruptDirs?.includes(o?.cwd ?? '')) throw new Error('fatal: not a git repository')
      return { stdout: 'true\n', stderr: '' }
    }
    if (cmd === 'npm') {
      if (opts.installError) throw opts.installError
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  return { exec, calls }
}

const noLock = async () => async () => {}
const owner: CloneOwnerCtx = { jobId: 'job1', instanceId: 'inst1', tokenId: 'tok1' }

let projectsDir: string
beforeEach(async () => {
  projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'od-clone-'))
})
afterEach(async () => {
  await fs.rm(projectsDir, { recursive: true, force: true })
})

const cloneCount = (calls: Array<{ cmd: string; args: string[] }>) =>
  calls.filter((c) => c.cmd === 'git' && c.args[0] === 'clone').length

describe('cloneRepoOnDemand', () => {
  it('clones fresh, promotes atomically, cleans up the temp dir', async () => {
    const { exec, calls } = makeExec({})
    const result = await cloneRepoOnDemand(
      { repoUrl: 'https://x/repo.git', name: 'repo', ownerCtx: owner },
      { projectsDir, pid: 111, exec, acquireLock: noLock, renewLease: async () => 1 },
    )
    expect(result).toBe(path.join(projectsDir, 'repo'))
    expect(await fs.access(path.join(result, '.git')).then(() => true)).toBe(true)
    // temp gone
    await expect(fs.access(path.join(projectsDir, 'repo.tmp.111'))).rejects.toThrow()
    expect(cloneCount(calls)).toBe(1)
  })

  it('re-check under lock: a sibling clone short-circuits (no second clone)', async () => {
    // target already present + valid
    await fs.mkdir(path.join(projectsDir, 'repo', '.git'), { recursive: true })
    const { exec, calls } = makeExec({})
    const result = await cloneRepoOnDemand(
      { repoUrl: 'https://x/repo.git', name: 'repo', ownerCtx: owner },
      { projectsDir, exec, acquireLock: noLock, renewLease: async () => 1 },
    )
    expect(result).toBe(path.join(projectsDir, 'repo'))
    expect(cloneCount(calls)).toBe(0)
  })

  it('a corrupt existing target is wiped and re-cloned', async () => {
    const target = path.join(projectsDir, 'repo')
    await fs.mkdir(path.join(target, '.git'), { recursive: true })
    const { exec, calls } = makeExec({ corruptDirs: [target] })
    const result = await cloneRepoOnDemand(
      { repoUrl: 'https://x/repo.git', name: 'repo' },
      { projectsDir, pid: 222, exec, acquireLock: noLock, renewLease: async () => 1 },
    )
    expect(result).toBe(target)
    expect(cloneCount(calls)).toBe(1)
  })

  it('terminal clone failure throws TerminalJobError and leaves no target', async () => {
    const { exec } = makeExec({ cloneError: execError('remote: Repository not found') })
    await expect(
      cloneRepoOnDemand(
        { repoUrl: 'https://x/nope.git', name: 'nope' },
        { projectsDir, pid: 333, exec, acquireLock: noLock, renewLease: async () => 1 },
      ),
    ).rejects.toBeInstanceOf(TerminalJobError)
    await expect(fs.access(path.join(projectsDir, 'nope'))).rejects.toThrow()
    await expect(fs.access(path.join(projectsDir, 'nope.tmp.333'))).rejects.toThrow()
  })

  it('lost ownership before work throws OwnershipLostError and never clones', async () => {
    const { exec, calls } = makeExec({})
    await expect(
      cloneRepoOnDemand(
        { repoUrl: 'https://x/repo.git', name: 'repo', ownerCtx: owner },
        { projectsDir, exec, acquireLock: noLock, renewLease: async () => 0 },
      ),
    ).rejects.toBeInstanceOf(OwnershipLostError)
    expect(cloneCount(calls)).toBe(0)
    await expect(fs.access(path.join(projectsDir, 'repo'))).rejects.toThrow()
  })

  it('deterministic install failure (lockfile) is terminal, temp not promoted', async () => {
    const { exec } = makeExec({
      withPackage: true,
      installError: execError(
        'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync',
      ),
    })
    await expect(
      cloneRepoOnDemand(
        { repoUrl: 'https://x/repo.git', name: 'repo' },
        { projectsDir, pid: 444, exec, acquireLock: noLock, renewLease: async () => 1 },
      ),
    ).rejects.toBeInstanceOf(TerminalJobError)
    await expect(fs.access(path.join(projectsDir, 'repo'))).rejects.toThrow()
  })

  it('transient install failure (network) is transient, temp not promoted', async () => {
    const { exec } = makeExec({
      withPackage: true,
      installError: execError('npm error network request failed, reason: connect ETIMEDOUT'),
    })
    await expect(
      cloneRepoOnDemand(
        { repoUrl: 'https://x/repo.git', name: 'repo' },
        { projectsDir, pid: 555, exec, acquireLock: noLock, renewLease: async () => 1 },
      ),
    ).rejects.toBeInstanceOf(TransientRepoError)
    await expect(fs.access(path.join(projectsDir, 'repo'))).rejects.toThrow()
  })

  it('serializes concurrent callers via the lock: only one clone happens', async () => {
    // shared FIFO mutex acquireLock across both calls
    let chain = Promise.resolve()
    const acquireLock = async () => {
      let release!: () => void
      const prev = chain
      chain = new Promise<void>((r) => (release = r))
      await prev
      return async () => release()
    }
    const { exec, calls } = makeExec({})
    const args = { repoUrl: 'https://x/repo.git', name: 'repo' as const }
    const deps = { projectsDir, exec, acquireLock, renewLease: async () => 1 }
    const [a, b] = await Promise.all([
      cloneRepoOnDemand({ ...args, ownerCtx: null }, { ...deps, pid: 1 }),
      cloneRepoOnDemand({ ...args, ownerCtx: null }, { ...deps, pid: 2 }),
    ])
    expect(a).toBe(path.join(projectsDir, 'repo'))
    expect(b).toBe(path.join(projectsDir, 'repo'))
    expect(cloneCount(calls)).toBe(1) // second caller hit the re-check
  })
})
