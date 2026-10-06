import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import type { DispatchInput } from '@shared/queue-dispatch.js'
import type { RuntimeJobConfig } from '@shared/job-config.js'

vi.mock('../src/prisma.js', () => ({ prisma: {} }))

// getJobConfigSnapshot resolvet via de shim src/lib/job-config.ts. De spy laat de echte
// resolver doorlopen, behalve waar een test hem één keer een HARNESS-config laat geven: het
// geval dat de typevernauwing onbereikbaar noemt en dat dus alleen zo te forceren is.
vi.mock('../src/lib/job-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/job-config.js')>()
  return { ...actual, resolveRuntimeJobConfig: vi.fn(actual.resolveRuntimeJobConfig) }
})

import { resolveRuntimeJobConfig } from '../src/lib/job-config.js'
import { getJobConfigSnapshot } from '../src/lib/dispatch/snapshot.js'
import { enqueueManagedJob, type ManagedRequest } from '../src/dispatch/job-adapter.js'

const mockResolve = resolveRuntimeJobConfig as unknown as ReturnType<typeof vi.fn>

type SnapshotDb = NonNullable<Parameters<typeof getJobConfigSnapshot>[1]>
type ManagedConfig = Exclude<RuntimeJobConfig, { runtime: 'HARNESS' }>

const HARNESS_CONFIG: RuntimeJobConfig = { runtime: 'HARNESS', model: 'gsq-lokaal', max_cost_usd: '0.05' }

// Beide plekken lazen een veld dat het HARNESS-lid van de union niet heeft
// (`thinking_budget`). Een typecast zou een HARNESS-config stil laten doorlopen met
// `undefined` als token-budget; de vernauwing weigert hem met een code.
describe('de enqueue-snapshot blijft gesloten voor HARNESS', () => {
  const lookups = {
    product: { findUnique: vi.fn() },
    task: { findUnique: vi.fn() },
    jobKindConfig: { findUnique: vi.fn() },
  }
  const db = lookups as unknown as SnapshotDb

  beforeEach(() => {
    vi.clearAllMocks()
    lookups.product.findUnique.mockResolvedValue(null)
    lookups.task.findUnique.mockResolvedValue(null)
    lookups.jobKindConfig.findUnique.mockResolvedValue(null)
  })

  it('getJobConfigSnapshot gooit UNKNOWN_AGENT_RUNTIME als de resolver toch HARNESS geeft', async () => {
    mockResolve.mockReturnValueOnce(HARNESS_CONFIG)

    await expect(
      getJobConfigSnapshot({ kind: 'IDEA_CHAT', productId: 'p1' }, db),
    ).rejects.toThrow('UNKNOWN_AGENT_RUNTIME')
  })

  it('getJobConfigSnapshot geeft voor een gewone job nog steeds de Claude-velden', async () => {
    const snapshot = await getJobConfigSnapshot({ kind: 'IDEA_MAKE_SPEC', productId: 'p1' }, db)

    expect(snapshot).toEqual({
      requested_model: expect.any(String),
      requested_thinking_budget: expect.any(Number),
      requested_permission_mode: expect.any(String),
    })
  })
})

describe('beheerde dispatch blijft gesloten voor HARNESS', () => {
  const request: ManagedRequest = {
    id: 'req-1',
    user_id: 'user-1',
    product_id: 'prod-1',
    input: {
      version: 1,
      product_id: 'prod-1',
      action: 'free_task',
      objective: 'doe iets',
      verification: 'controleer het',
      response_format: 'kort',
      requirements: { access: 'read', environment_keys: [] },
      publish: 'artifact',
      reply_to: 'mac:claude',
    } satisfies DispatchInput,
    snapshot: {},
  }

  function fakeDb() {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    return { db: { query } as unknown as PoolClient, query }
  }

  it('enqueueManagedJob weigert een HARNESS-snapshot zonder iets te lezen of te schrijven', async () => {
    const { db, query } = fakeDb()
    const candidate = { id: 'cand-1', profileRevisionId: 'prof-1', runtime: 'CODEX' as const }

    await expect(enqueueManagedJob(db, request, candidate, HARNESS_CONFIG)).rejects.toThrow(
      'UNKNOWN_AGENT_RUNTIME',
    )
    expect(query).not.toHaveBeenCalled()
  })

  // Controle dat de weigering gericht is: Claude en Codex schrijven nog steeds hun eigen
  // model, token-budget en permissiemodus (Codex kent geen permissiemodus: 'default').
  const SNAPSHOTS: Array<['CLAUDE' | 'CODEX', ManagedConfig, string]> = [
    [
      'CLAUDE',
      {
        runtime: 'CLAUDE',
        model: 'claude-opus-5',
        thinking_budget: 24000,
        permission_mode: 'acceptEdits',
        max_turns: null,
        allowed_tools: null,
        skills: [],
      },
      'acceptEdits',
    ],
    [
      'CODEX',
      {
        runtime: 'CODEX',
        model: 'gpt-5.6-terra',
        thinking_budget: 0,
        sandbox_mode: null,
        max_turns: null,
        skills: [],
      },
      'default',
    ],
  ]

  it.each(SNAPSHOTS)('enqueueManagedJob schrijft de %s-config ongewijzigd weg', async (runtime, config, permission) => {
    const { db, query } = fakeDb()
    const candidate = { id: 'cand-1', profileRevisionId: 'prof-1', runtime }

    const jobId = await enqueueManagedJob(db, request, candidate, config)

    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO claude_jobs'))
    expect(insert).toBeDefined()
    const params = insert![1] as unknown[]
    expect(params[0]).toBe(jobId)
    expect(params[5]).toBe(runtime)
    expect(params.slice(7, 10)).toEqual([config.model, config.thinking_budget, permission])
  })
})
