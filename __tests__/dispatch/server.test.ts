import { describe, expect, it, vi } from 'vitest'
import { createDispatchTickRunner } from '../../src/dispatch/server.js'
import type { DispatchTickResult } from '../../src/dispatch/tick.js'

const empty: DispatchTickResult = {
  prepared: 0, reserved: 0, retired: 0, uncertain: 0, publications: 0, publicationsFailed: 0,
  delivered: 0, deliveryFailed: 0, replyReadsRecovered: 0, threadsArchived: 0, threadsRefused: 0, errors: 0,
}
/** An explicit gate instead of a sleep: the tick hangs until the test releases it. */
function gate() {
  let open: () => void
  const opened = new Promise<void>(resolve => { open = resolve })
  return { opened, open: () => open() }
}

describe('dispatch tick runner', () => {
  it('never lets a second tick start while one is in flight', async () => {
    const barrier = gate()
    const tick = vi.fn(async () => { await barrier.opened; return empty })
    const runner = createDispatchTickRunner({ tick, log: () => {} })
    const first = runner.run(), second = runner.run()
    expect(tick).toHaveBeenCalledTimes(1)
    barrier.open()
    await Promise.all([first, second])
    expect(tick).toHaveBeenCalledTimes(1)
    await runner.run()
    expect(tick).toHaveBeenCalledTimes(2)
  })

  it('stops accepting work at once and only then waits for the tick in flight', async () => {
    const barrier = gate()
    let settled = false
    const tick = vi.fn(async () => { await barrier.opened; settled = true; return empty })
    const runner = createDispatchTickRunner({ tick, log: () => {} })
    const inFlight = runner.run()
    // Stopping is immediate for new work — a timer that fires during shutdown starts nothing …
    const drained = runner.stop()
    await runner.run()
    expect(tick).toHaveBeenCalledTimes(1)
    let drainedBeforeTick = true
    void drained.then(() => { drainedBeforeTick = !settled })
    barrier.open()
    await Promise.all([inFlight, drained])
    // … and the tick that was already running keeps its own transactions.
    expect(settled).toBe(true)
    expect(drainedBeforeTick).toBe(false)
    await runner.run()
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('logs a tick result, and a failed tick by name only', async () => {
    const events: Record<string, unknown>[] = []
    const good = createDispatchTickRunner({ tick: async () => ({ ...empty, reserved: 2 }), log: event => events.push(event) })
    await good.run()
    expect(events).toEqual([{ tick: { ...empty, reserved: 2 } }])
    const failing = createDispatchTickRunner({
      tick: async () => { throw new TypeError('postgres://dispatch:secret@host/db is unreachable') },
      log: event => events.push(event),
    })
    await expect(failing.run()).resolves.toBeUndefined()
    expect(events[1]).toEqual({ tick_failed: 'TypeError' })
    expect(JSON.stringify(events)).not.toMatch(/secret|postgres:/)
    // A failed tick is not a stopped runner: the next interval tries again.
    await failing.run()
    expect(events).toHaveLength(3)
  })

  it('runs a woken tick at once when nothing is in flight', async () => {
    const tick = vi.fn(async () => empty)
    const runner = createDispatchTickRunner({ tick, log: () => {} })
    runner.wake()
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('turns any number of wakes during one tick into exactly one follow-up', async () => {
    const barrier = gate()
    let calls = 0
    const tick = vi.fn(async () => { calls++; if (calls === 1) await barrier.opened; return empty })
    const runner = createDispatchTickRunner({ tick, log: () => {} })
    const inFlight = runner.run()
    expect(tick).toHaveBeenCalledTimes(1)
    // A burst that arrives while the tick holds its transactions never becomes a second
    // concurrent tick, and never becomes five sequential ones either.
    for (let i = 0; i < 5; i++) runner.wake()
    expect(tick).toHaveBeenCalledTimes(1)
    barrier.open()
    await inFlight
    expect(tick).toHaveBeenCalledTimes(2)
  })

  it('does not wake a stopped runner, before or after the tick in flight', async () => {
    const barrier = gate()
    const tick = vi.fn(async () => { await barrier.opened; return empty })
    const runner = createDispatchTickRunner({ tick, log: () => {} })
    const inFlight = runner.run()
    runner.wake()
    const drained = runner.stop()
    barrier.open()
    await Promise.all([inFlight, drained])
    // The follow-up a wake asked for belongs to a running service, not to a shutting-down one.
    expect(tick).toHaveBeenCalledTimes(1)
    runner.wake()
    expect(tick).toHaveBeenCalledTimes(1)
  })
})
