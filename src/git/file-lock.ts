import lockfile from 'proper-lockfile'

export async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const release = await lockfile.lock(lockPath, {
    realpath: false,
    stale: 30_000,
    update: 5_000,
    retries: { retries: 60, factor: 1, minTimeout: 1_000, maxTimeout: 1_000 },
  })
  let released = false
  return async () => {
    if (released) return
    released = true
    await release()
  }
}

export async function acquireFileLocksOrdered(
  lockPaths: string[],
): Promise<() => Promise<void>> {
  const sorted = [...lockPaths].sort()
  const releases: Array<() => Promise<void>> = []
  try {
    for (const p of sorted) {
      releases.push(await acquireFileLock(p))
    }
  } catch (err) {
    for (const r of releases.reverse()) {
      await r().catch(() => {})
    }
    throw err
  }
  return async () => {
    for (const r of releases.reverse()) {
      await r().catch(() => {})
    }
  }
}
