import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Client } from 'pg'
import { QUEUE_POLL_INTERVAL_MS, waitForQueueWakeup } from '../src/queue/listen.js'

function fakeClient() {
  return new EventEmitter() as unknown as Client & EventEmitter
}

afterEach(() => vi.useRealTimers())

describe('waitForQueueWakeup — NOTIFY is wake-up-only (§5 LISTEN-mechaniek)', () => {
  it('resolvet op een relevante notification en ruimt zijn listener op', async () => {
    const client = fakeClient()
    const ac = new AbortController()
    const p = waitForQueueWakeup(client, ac.signal, (payload) => payload.in_reply_to === 'msg-1')
    client.emit('notification', {
      channel: 'agent_queue',
      payload: JSON.stringify({ in_reply_to: 'msg-1' }),
    })
    await expect(p).resolves.toBeUndefined()
    expect(client.listenerCount('notification')).toBe(0)
  })

  it('negeert irrelevante payloads en kapotte JSON; het poll-vangnet resolvet alsnog', async () => {
    vi.useFakeTimers()
    const client = fakeClient()
    const ac = new AbortController()
    const resolved = vi.fn()
    const p = waitForQueueWakeup(client, ac.signal, (payload) => payload.in_reply_to === 'msg-1')
      .then(resolved)
    client.emit('notification', {
      channel: 'agent_queue',
      payload: JSON.stringify({ in_reply_to: 'ander' }),
    })
    client.emit('notification', { channel: 'agent_queue', payload: 'geen json' })
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    vi.advanceTimersByTime(QUEUE_POLL_INTERVAL_MS)
    await p
    expect(resolved).toHaveBeenCalled()
  })

  it('resolvet op het poll-interval zonder notification (gemiste NOTIFY kost hooguit latency)', async () => {
    vi.useFakeTimers()
    const client = fakeClient()
    const ac = new AbortController()
    const p = waitForQueueWakeup(client, ac.signal, () => false)
    vi.advanceTimersByTime(QUEUE_POLL_INTERVAL_MS)
    await expect(p).resolves.toBeUndefined()
  })

  it('resolvet direct op abort (MCP-cancel tijdens wait)', async () => {
    const client = fakeClient()
    const ac = new AbortController()
    const p = waitForQueueWakeup(client, ac.signal, () => false)
    ac.abort()
    await expect(p).resolves.toBeUndefined()
    expect(client.listenerCount('notification')).toBe(0)
  })

  it('negeert notifications op een ander kanaal', async () => {
    vi.useFakeTimers()
    const client = fakeClient()
    const ac = new AbortController()
    const resolved = vi.fn()
    void waitForQueueWakeup(client, ac.signal, () => true).then(resolved)
    client.emit('notification', { channel: 'scrum4me_changes', payload: '{}' })
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    ac.abort()
  })

  it('resolvet direct als het signal al afgebroken is vóór de aanroep', async () => {
    // Gemeten vóór de fix: 5002 ms wachten. Een listener die je toevoegt nadat
    // het abort-event al gevuurd is wordt niet alsnog aangeroepen, dus de wait
    // viel terug op het poll-vangnet. MCP-cancel die de setup-race verliest
    // kostte daarmee vijf seconden.
    const client = fakeClient()
    const ac = new AbortController()
    ac.abort()
    await expect(waitForQueueWakeup(client, ac.signal, () => false)).resolves.toBeUndefined()
    expect(client.listenerCount('notification')).toBe(0)
  })

  it('ruimt ook de abort-listener op, niet alleen die op de client', async () => {
    // Een bounded wait roept deze functie in een lus aan met hetzelfde signal,
    // dus een lek hier stapelt binnen één tool-call op.
    const { getEventListeners } = await import('node:events')
    const client = fakeClient()
    const ac = new AbortController()
    const p = waitForQueueWakeup(client, ac.signal, (payload) => payload.in_reply_to === 'msg-1')
    client.emit('notification', {
      channel: 'agent_queue',
      payload: JSON.stringify({ in_reply_to: 'msg-1' }),
    })
    await p
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0)
  })

  it('pint het poll-interval exact vast, niet alleen als bovengrens', async () => {
    // De bestaande timer-tests bewijzen alleen dat het binnen
    // QUEUE_POLL_INTERVAL_MS gebeurt; een stille verkorting bleef onzichtbaar.
    vi.useFakeTimers()
    const client = fakeClient()
    const ac = new AbortController()
    const resolved = vi.fn()
    const p = waitForQueueWakeup(client, ac.signal, () => false).then(resolved)
    vi.advanceTimersByTime(QUEUE_POLL_INTERVAL_MS - 1)
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await p
    expect(resolved).toHaveBeenCalled()
  })
})
