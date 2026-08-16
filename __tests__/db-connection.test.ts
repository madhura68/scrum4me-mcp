import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  applicationName,
  poolMaxFromUrl,
  dbClientConfig,
  dbPoolConfig,
  DEFAULT_POOL_MAX,
} from '../src/db-connection.js'

// The point of application_name is that a saturated server can be attributed
// without NAT forensics, so these tests care about identity being present and
// well-formed even when the environment is incomplete.

const ENV_KEYS = ['S4M_SERVER', 'S4M_MODEL', 'SCRUM4ME_WORKER_INSTANCE_ID', 'SCRUM4ME_INSTANCE_ID', 'DATABASE_URL'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('applicationName', () => {
  it('combines host and model', () => {
    process.env.S4M_SERVER = 'mac'
    process.env.S4M_MODEL = 'claude'
    expect(applicationName()).toBe('s4m-mcp:mac:claude')
  })

  it('appends the worker instance when present', () => {
    process.env.S4M_SERVER = 'scrum4me-server'
    process.env.S4M_MODEL = 'codex'
    process.env.SCRUM4ME_WORKER_INSTANCE_ID = 'idea-51'
    expect(applicationName()).toBe('s4m-mcp:scrum4me-server:codex:idea-51')
  })

  it('falls back to the unique presence instance id when there is no queue identity', () => {
    // The fleet workers carry no queue identity on purpose; the label must
    // still identify the process, and per process — not per service.
    expect(applicationName()).toMatch(/^s4m-mcp:mcp-.+-\d+$/)
  })

  it('treats whitespace-only identity as missing and still falls back', () => {
    process.env.S4M_SERVER = '   '
    process.env.S4M_MODEL = '\t'
    expect(applicationName()).toMatch(/^s4m-mcp:mcp-.+-\d+$/)
  })

  it('gives two processes on one host distinct labels', () => {
    // Guards the reason SCRUM4ME_WORKER_INSTANCE_ID must not be pinned per
    // service: scaled replicas have to stay distinguishable.
    process.env.SCRUM4ME_INSTANCE_ID = 'replica-a'
    const a = applicationName()
    process.env.SCRUM4ME_INSTANCE_ID = 'replica-b'
    expect(applicationName()).not.toBe(a)
  })

  it('stays within the 63-byte limit Postgres truncates at', () => {
    process.env.S4M_SERVER = 'a'.repeat(40)
    process.env.S4M_MODEL = 'b'.repeat(40)
    process.env.SCRUM4ME_WORKER_INSTANCE_ID = 'c'.repeat(40)
    expect(applicationName().length).toBe(63)
  })
})

describe('poolMaxFromUrl', () => {
  const BASE = 'postgresql://u:p@127.0.0.1:5432/scrum4me'

  it('honours connection_limit from the URL', () => {
    expect(poolMaxFromUrl(`${BASE}?connection_limit=4`)).toBe(4)
  })

  it('falls back to the default when absent or unusable', () => {
    expect(poolMaxFromUrl(BASE)).toBe(DEFAULT_POOL_MAX)
    expect(poolMaxFromUrl(`${BASE}?connection_limit=0`)).toBe(DEFAULT_POOL_MAX)
    expect(poolMaxFromUrl(`${BASE}?connection_limit=2.5`)).toBe(DEFAULT_POOL_MAX)
    expect(poolMaxFromUrl(`${BASE}?connection_limit=abc`)).toBe(DEFAULT_POOL_MAX)
  })

  it('falls back for a keyword-style connection string', () => {
    expect(poolMaxFromUrl('host=127.0.0.1 dbname=scrum4me')).toBe(DEFAULT_POOL_MAX)
  })
})

describe('connection configs', () => {
  it('labels every dedicated client', () => {
    process.env.S4M_SERVER = 'max2'
    process.env.S4M_MODEL = 'claude'
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/scrum4me'
    const cfg = dbClientConfig()
    expect(cfg.application_name).toBe('s4m-mcp:max2:claude')
    expect(cfg.connectionString).toBe('postgresql://u:p@127.0.0.1:5432/scrum4me')
  })

  it('labels and bounds the pool, passing the URL through untouched', () => {
    process.env.S4M_SERVER = 'mac'
    process.env.S4M_MODEL = 'claude'
    const url = 'postgresql://u:p@127.0.0.1:5432/scrum4me?connection_limit=6'
    const cfg = dbPoolConfig(url)
    expect(cfg.application_name).toBe('s4m-mcp:mac:claude')
    expect(cfg.max).toBe(6)
    // Not rewritten: re-encoding the URL risks mangling the password.
    expect(cfg.connectionString).toBe(url)
  })
})
