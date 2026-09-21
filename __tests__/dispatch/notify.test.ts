import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Client, PoolClient } from 'pg'
import {
  DISPATCH_TICK_CHANNEL, createDispatchTickListener, notifyDispatchTick, parseDispatchTickSignal,
} from '../../src/dispatch/notify.js'

/** A LISTEN session as the listener uses it: it answers queries, emits notifications and can be
 * dropped from under the listener the way a lost backend would. */
class FakeClient extends EventEmitter {
  readonly queries: string[] = []
  ended = false
  async query(text: string) { this.queries.push(text); return { rows: [] } }
  async end() { this.ended = true }
  notify(payload: unknown, channel = DISPATCH_TICK_CHANNEL) {
    this.emit('notification', { channel, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) })
  }
}
/** The coalescing window as an explicit gate: the test closes it, never a timer. */
function manualSchedule() {
  const pending: (() => void)[] = []
  return {
    schedule: (run: () => void) => { pending.push(run); return () => { pending.splice(pending.indexOf(run), 1) } },
    close: () => { for (const run of pending.splice(0)) run() },
    get size() { return pending.length },
  }
}
function listener(overrides: Partial<Parameters<typeof createDispatchTickListener>[0]> = {}) {
  const clients: FakeClient[] = []
  const wake = vi.fn()
  const window = manualSchedule()
  const events: Record<string, unknown>[] = []
  const instance = createDispatchTickListener({
    connect: async () => { const client = new FakeClient(); clients.push(client); return client as unknown as Client },
    wake, schedule: window.schedule, log: event => events.push(event), backoffMs: () => 1, ...overrides,
  })
  return { instance, clients, wake, window, events, last: () => clients[clients.length - 1] }
}

describe('dispatch tick notifications', () => {
  it('emits an id-only signal inside the caller transaction', async () => {
    const calls: [string, unknown[]][] = []
    const db = { query: async (text: string, params: unknown[]) => { calls.push([text, params]); return { rows: [] } } } as unknown as PoolClient
    await notifyDispatchTick(db, 'request', '2b1f0d3c-0000-4000-8000-000000000001')
    await notifyDispatchTick(db, 'capacity')
    expect(calls.map(([text]) => text)).toEqual(['SELECT pg_notify($1,$2)', 'SELECT pg_notify($1,$2)'])
    expect(calls.map(([, params]) => params[0])).toEqual([DISPATCH_TICK_CHANNEL, DISPATCH_TICK_CHANNEL])
    expect(JSON.parse(calls[0][1][1] as string)).toEqual({ v: 1, reason: 'request', request_id: '2b1f0d3c-0000-4000-8000-000000000001' })
    expect(JSON.parse(calls[1][1][1] as string)).toEqual({ v: 1, reason: 'capacity', request_id: null })
  })

  it('reads only its own versioned vocabulary', () => {
    expect(parseDispatchTickSignal('{"v":1,"reason":"request","request_id":null}')).toEqual({ v: 1, reason: 'request', request_id: null })
    for (const bad of [undefined, '', 'null', '{', '{"v":2,"reason":"request"}', '{"v":1,"reason":"deploy"}']) {
      expect(parseDispatchTickSignal(bad)).toBeNull()
    }
  })

  it('listens to nothing until it is explicitly started', async () => {
    const x = listener()
    expect(x.clients).toHaveLength(0)
    await x.instance.start()
    expect(x.last().queries).toEqual([`LISTEN ${DISPATCH_TICK_CHANNEL}`])
    await x.instance.stop()
  })

  it('folds a burst inside one window into a single wake', async () => {
    const x = listener()
    await x.instance.start()
    // Connecting wakes nothing by itself; the first interval tick covers what it missed.
    x.window.close()
    expect(x.wake).not.toHaveBeenCalled()
    for (let i = 0; i < 10; i++) x.last().notify({ v: 1, reason: 'request', request_id: null })
    expect(x.window.size).toBe(1)
    x.window.close()
    expect(x.wake).toHaveBeenCalledTimes(1)
    // A new window opens only for what arrives after the previous one closed.
    x.last().notify({ v: 1, reason: 'capacity', request_id: null })
    x.window.close()
    expect(x.wake).toHaveBeenCalledTimes(2)
    await x.instance.stop()
  })

  it('ignores a foreign channel and an unreadable payload', async () => {
    const x = listener()
    await x.instance.start()
    x.window.close()
    x.wake.mockClear()
    x.last().notify({ v: 1, reason: 'request', request_id: null }, 'agent_queue')
    x.last().notify('not json')
    expect(x.window.size).toBe(0)
    x.window.close()
    expect(x.wake).not.toHaveBeenCalled()
    await x.instance.stop()
  })

  it('reconnects after a dropped session and keeps waking on the new one', async () => {
    const x = listener()
    await x.instance.start()
    const dropped = x.last()
    const reconnected = new Promise<void>(resolve => {
      const poll = setInterval(() => { if (x.clients.length === 2) { clearInterval(poll); resolve() } }, 1)
    })
    dropped.emit('error', new Error('connection terminated'))
    await reconnected
    expect(dropped.ended).toBe(true)
    expect(x.events).toContainEqual({ tick_listener: 'dropped_on_error' })
    expect(x.last().queries).toEqual([`LISTEN ${DISPATCH_TICK_CHANNEL}`])
    x.last().notify({ v: 1, reason: 'request', request_id: null })
    x.window.close()
    expect(x.wake).toHaveBeenCalledTimes(1)
    await x.instance.stop()
  })

  it('retries a refused connection instead of failing the service, and start still resolves', async () => {
    let attempts = 0
    const clients: FakeClient[] = []
    const events: Record<string, unknown>[] = []
    const instance = createDispatchTickListener({
      connect: async () => {
        if (++attempts === 1) throw new TypeError('postgres://dispatch:secret@host/db refused')
        const client = new FakeClient(); clients.push(client); return client as unknown as Client
      },
      wake: () => {}, schedule: () => () => {}, backoffMs: () => 1, log: event => events.push(event),
    })
    await expect(instance.start()).resolves.toBeUndefined()
    await new Promise<void>(resolve => {
      const poll = setInterval(() => { if (clients.length === 1) { clearInterval(poll); resolve() } }, 1)
    })
    // The failure is reported by error name only; no DSN reaches the log.
    expect(events[0]).toEqual({ tick_listener_failed: 'TypeError', attempt: 1 })
    expect(JSON.stringify(events)).not.toMatch(/secret|postgres:/)
    await instance.stop()
  })

  it('stops the connection and wakes nothing afterwards', async () => {
    const x = listener()
    await x.instance.start()
    const client = x.last()
    await x.instance.stop()
    expect(client.ended).toBe(true)
    x.window.close()
    client.notify({ v: 1, reason: 'request', request_id: null })
    x.window.close()
    expect(x.wake).not.toHaveBeenCalled()
  })
})
