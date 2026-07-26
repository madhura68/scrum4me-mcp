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
})
