import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { waitForEnqueueNotification } from '../src/tools/wait-for-job.js'

const matchesUser = (payload: { type?: unknown; user_id?: unknown }) =>
  payload.type === 'claude_job_enqueued' && payload.user_id === 'u1'

describe('waitForEnqueueNotification (ISS-8)', () => {
  it('leaves no notification listener behind when the poll timer wins', async () => {
    const client = new EventEmitter()
    for (let i = 0; i < 12; i++) await waitForEnqueueNotification(client, 5, matchesUser)
    expect(client.listenerCount('notification')).toBe(0)
  })

  it('resolves early on a matching notification and removes its listener', async () => {
    const client = new EventEmitter()
    const started = Date.now()
    const waiting = waitForEnqueueNotification(client, 5_000, matchesUser)
    client.emit('notification', { payload: JSON.stringify({ type: 'claude_job_enqueued', user_id: 'u1' }) })
    await waiting
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(client.listenerCount('notification')).toBe(0)
  })

  it('keeps waiting after a non-matching or unparsable notification, then cleans up at the timeout', async () => {
    const client = new EventEmitter()
    let done = false
    const waiting = waitForEnqueueNotification(client, 60, matchesUser).then(() => { done = true })
    client.emit('notification', { payload: JSON.stringify({ type: 'claude_job_enqueued', user_id: 'someone-else' }) })
    client.emit('notification', { payload: 'geen json' })
    await new Promise((r) => setTimeout(r, 10))
    expect(done).toBe(false)
    expect(client.listenerCount('notification')).toBe(1)
    await waiting
    expect(client.listenerCount('notification')).toBe(0)
  })
})
