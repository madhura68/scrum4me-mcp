// ISS-16: een weggevallen LISTEN-verbinding (ETIMEDOUT, DB-herstart) laat pg een
// 'error' emitten. Zonder luisteraar is dat een unhandled 'error' en crasht het
// hele MCP-proces; met de handler loopt de wacht door op het poll-vangnet.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('pg', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class Client extends Emitter {
    connect = vi.fn().mockResolvedValue(undefined)
    query = vi.fn().mockResolvedValue(undefined)
    end = vi.fn().mockResolvedValue(undefined)
  }
  return { Client }
})

import { openQueueListener, waitForQueueWakeup, QUEUE_POLL_INTERVAL_MS } from '../src/queue/listen.js'

afterEach(() => vi.useRealTimers())

describe('openQueueListener — LISTEN-fout crasht het proces niet (ISS-16)', () => {
  it('vangt een error-event af', async () => {
    const client = await openQueueListener()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => client.emit('error', new Error('read ETIMEDOUT'))).not.toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('na de fout eindigt een lopende wacht gewoon op het poll-interval', async () => {
    vi.useFakeTimers()
    const client = await openQueueListener()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = waitForQueueWakeup(client, new AbortController().signal, () => false)
    client.emit('error', new Error('Connection terminated unexpectedly'))
    vi.advanceTimersByTime(QUEUE_POLL_INTERVAL_MS)
    await expect(p).resolves.toBeUndefined()
    spy.mockRestore()
  })
})

// Vangnet tegen regressie: elk bronbestand dat een LISTEN-verbinding opent,
// moet ook een error-handler op die client zetten (anders crasht het proces
// bij een netwerk-/DB-hapering). Vóór ISS-16 faalde wait-for-job.ts hierop.
describe('elke LISTEN-client heeft een error-handler', () => {
  it('geldt voor alle bestanden in src/ die LISTEN uitvoeren', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) files.push(p)
      }
    }
    walk(join(__dirname, '..', 'src'))
    const listening = files.filter((f) => /query\((`|')LISTEN/.test(readFileSync(f, 'utf8')))
    expect(listening.length).toBeGreaterThan(0)
    const missing = listening.filter(
      (f) => !/survivePgClientErrors\(|\.on\('error'/.test(readFileSync(f, 'utf8')),
    )
    expect(missing).toEqual([])
  })
})
