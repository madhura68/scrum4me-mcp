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

// A fresh clone + `npm ci` can take minutes; the default 60s retry budget is
// too short for a waiter queued behind a healthy in-progress clone (it would
// fail while the winner is still working). proper-lockfile auto-refreshes the
// lock mtime every `update` ms while the holder lives, so `stale` only trips for
// a genuinely dead holder — not for a slow-but-alive one.
export async function acquireCloneLock(lockPath: string): Promise<() => Promise<void>> {
  const release = await lockfile.lock(lockPath, {
    realpath: false, // lockPath (the target repo dir) need not exist yet
    stale: 15 * 60_000, // only steal from a holder dead >15 min
    update: 60_000, // refresh our lock mtime every 60s while cloning/installing
    retries: { retries: 300, factor: 1, minTimeout: 2_000, maxTimeout: 2_000 }, // wait up to ~10 min
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
