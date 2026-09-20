import { describe, expect, it, vi } from 'vitest'
import {
  DISPATCH_DB_ROLE, DISPATCH_HEALTH_TTL_MS, DISPATCH_PROTOCOL, DISPATCH_SCHEMA_TABLES,
  DISPATCH_SERVICE_VERSION, createDispatchHealth,
} from '../../src/dispatch/health.js'

const ready = { tables: DISPATCH_SCHEMA_TABLES.length, role: DISPATCH_DB_ROLE, elevated: false }
const health = (rows: Record<string, unknown>[], now: () => number) => {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows }))
  return { query, probe: createDispatchHealth({ store: { query } as never, now }) }
}

describe('dispatch readiness', () => {
  it('reports only build and connection facts', async () => {
    let clock = 1000
    const { probe } = health([ready], () => clock)
    expect(await probe.readiness()).toEqual({
      version: DISPATCH_SERVICE_VERSION, protocol: DISPATCH_PROTOCOL, schema_ready: true, role_ready: true,
    })
  })

  it('is not ready on a partial schema, a foreign role or an elevated one', async () => {
    let clock = 0
    for (const [row, expected] of [
      [{ ...ready, tables: DISPATCH_SCHEMA_TABLES.length - 1 }, { schema_ready: false, role_ready: true }],
      [{ ...ready, role: 'scrum4me' }, { schema_ready: true, role_ready: false }],
      // An elevated connection is exactly what the consumer preflight refuses; readiness says so too.
      [{ ...ready, elevated: true }, { schema_ready: true, role_ready: false }],
      [{ ...ready, elevated: null }, { schema_ready: true, role_ready: false }],
    ] as const) {
      clock += DISPATCH_HEALTH_TTL_MS * 10
      const { probe } = health([row as Record<string, unknown>], () => clock)
      expect(await probe.readiness()).toMatchObject(expected)
    }
  })

  it('answers a database failure as not ready and never carries its text', async () => {
    const query = vi.fn(async () => { throw new Error('password authentication failed for user "scrum4me_dispatch"') })
    const probe = createDispatchHealth({ store: { query } as never })
    const value = await probe.readiness()
    expect(value).toMatchObject({ schema_ready: false, role_ready: false })
    expect(JSON.stringify(value)).not.toMatch(/password|authentication|scrum4me_dispatch/)
  })

  it('spends at most one query per probe window, whoever calls it', async () => {
    let clock = 5_000
    const { query, probe } = health([ready], () => clock)
    await probe.readiness(); await probe.readiness(); await probe.readiness()
    expect(query).toHaveBeenCalledTimes(1)
    clock += DISPATCH_HEALTH_TTL_MS
    await probe.readiness()
    expect(query).toHaveBeenCalledTimes(2)
    // One statement, parameterised, and nothing but a SELECT.
    expect(query.mock.calls[0][0]).toMatch(/^SELECT /)
    expect(String(query.mock.calls[0][0])).not.toMatch(/INSERT|UPDATE|DELETE|BEGIN/i)
  })
})
