import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { acquireFileLock, acquireFileLocksOrdered } from '../../src/git/file-lock.js'

describe('file-lock', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-lock-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('acquires and releases a lock; lockfile is gone after release', async () => {
    const lockPath = path.join(tmpDir, 'a.lock')
    const release = await acquireFileLock(lockPath)
    // proper-lockfile creates a directory at <lockPath>.lock for the actual lock
    const stat = await fs.stat(`${lockPath}.lock`).catch(() => null)
    expect(stat).not.toBeNull()
    await release()
    // After release, the .lock dir should be gone
    const after = await fs.stat(`${lockPath}.lock`).catch(() => null)
    expect(after).toBeNull()
  })

  it('release is idempotent (second call is no-op)', async () => {
    const lockPath = path.join(tmpDir, 'b.lock')
    const release = await acquireFileLock(lockPath)
    await release()
    await expect(release()).resolves.toBeUndefined()
  })

  it('second acquire blocks until first release', async () => {
    const lockPath = path.join(tmpDir, 'c.lock')
    const release1 = await acquireFileLock(lockPath)

    let secondAcquired = false
    const second = acquireFileLock(lockPath).then((r) => {
      secondAcquired = true
      return r
    })

    // Give the second acquire a moment to attempt
    await new Promise((r) => setTimeout(r, 200))
    expect(secondAcquired).toBe(false)

    await release1()
    const release2 = await second
    expect(secondAcquired).toBe(true)
    await release2()
  }, 10_000)

  it('acquireFileLocksOrdered sorts paths alphabetically (deadlock-free for crossed sets)', async () => {
    const a = path.join(tmpDir, 'A.lock')
    const b = path.join(tmpDir, 'B.lock')

    // Two concurrent multi-locks with crossed orders both sort to [A, B]
    const r1Promise = acquireFileLocksOrdered([b, a])

    // First should grab both since paths sort the same
    const r1 = await r1Promise

    let secondAcquired = false
    const r2Promise = acquireFileLocksOrdered([a, b]).then((r) => {
      secondAcquired = true
      return r
    })

    await new Promise((r) => setTimeout(r, 200))
    expect(secondAcquired).toBe(false)

    await r1()
    const r2 = await r2Promise
    expect(secondAcquired).toBe(true)
    await r2()
  }, 15_000)

  it('partial failure releases held locks', async () => {
    // Force the second acquire to fail by writing a regular file at the lockfile
    // location proper-lockfile wants to create as a directory.
    const a = path.join(tmpDir, 'A.lock')
    const bPath = path.join(tmpDir, 'B.lock')
    // Create a regular file at `${bPath}.lock` so proper-lockfile's mkdir fails with EEXIST
    await fs.writeFile(`${bPath}.lock`, 'blocked')

    await expect(acquireFileLocksOrdered([a, bPath])).rejects.toThrow()

    // After failure, A's lock should be released — re-acquire immediately
    const r = await acquireFileLock(a)
    await r()
  }, 90_000)
})
