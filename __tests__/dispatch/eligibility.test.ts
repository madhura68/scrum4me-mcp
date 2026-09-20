import { describe, it, expect } from 'vitest'
import { buildClaimableJobWhereFragment, evaluateClaimPredicates } from '../../src/dispatch/eligibility.js'
import { isManagedWorkerInstanceId, managedWorkerPollScope } from '../../src/presence/worker-mode.js'
import { parseManagedSlotConfig } from '../../src/dispatch/registration.js'

describe('shared claim eligibility', () => {
  it('binds managed configuration to the reserved stable worker namespace', () => {
    const config = { version: 1, runtime: 'CODEX', product_ids: ['p'], capabilities: [], tier: null, worker_instance_id: 'managed:stable-host' }
    expect(parseManagedSlotConfig(config)).toEqual(config)
    for (const id of ['ordinary-worker', 'managed:', '', null]) {
      expect(isManagedWorkerInstanceId(id)).toBe(false)
      if (id !== null) expect(() => parseManagedSlotConfig({ ...config, worker_instance_id: id })).toThrow('DISPATCH_INVALID_INPUT')
    }
    expect(managedWorkerPollScope.test('managed:')).toBe(true) // malformed reserved IDs cannot ordinary-poll either
    expect(managedWorkerPollScope.test('ordinary:managed:host')).toBe(false)
  })
  const job = { userId: 'u', productId: 'p', runtime: 'CODEX' as const, status: 'QUEUED', kind: 'QUEUE_TASK', source: 'COPILOT', requiredCapability: null, dispatchRequestId: 'r', profileRevisionId: 'profile', sprintRunId: null, sprintStatus: null, earlierSibling: false, taskId: null, ideaId: null }
  const executor = { userId: 'u', productIds: ['p'], runtime: 'CODEX' as const, capabilities: [], profileRevisionIds: ['profile'], managed: true, incarnationId: 'inc', quotaPct: null, minQuotaPct: 10 }
  it('permits only bound managed COPILOT queue work', () => {
    expect(evaluateClaimPredicates(job, executor)).toEqual([])
    for (const patch of [{ userId: 'other' }, { productId: 'other' }, { runtime: 'CLAUDE' }, { source: 'SYSTEM' }, { kind: 'DEPLOY' }, { profileRevisionId: 'wrong' }, { requiredCapability: 'write' }]) {
      expect(evaluateClaimPredicates({ ...job, ...patch }, executor).length).toBeGreaterThan(0)
    }
  })
  it('retains quota and dedicated worker isolation', () => {
    expect(evaluateClaimPredicates(job, { ...executor, quotaPct: 5 })).toContain('quota')
    expect(evaluateClaimPredicates(job, { ...executor, capabilities: ['deploy'] })).toContain('capability')
  })
  it('excludes managed jobs from every ordinary SQL path', () => {
    for (const capabilities of [[], ['deploy'], ['docs_audit'], ['review']]) {
      const sql = buildClaimableJobWhereFragment({ userId: 'u', hasProductScope: false, runtime: 'CODEX', capabilities })
      expect(sql.sql).toContain('cj.dispatch_request_id IS NULL')
    }
  })
})

import { eligibleExecutors, type RegisteredSlot, type RegisteredProfile } from '../../src/dispatch/eligibility.js'
import type { DispatchInput } from '@shared/queue-dispatch.js'
describe('fair registered pool ranking', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  const input: DispatchInput = { version: 1, product_id: 'p', action: 'free_task', objective: 'Read', verification: 'Evidence', response_format: 'MD', requirements: { access: 'read', environment_keys: [] }, publish: 'artifact', reply_to: 'mac:jp' }
  const request = { id: 'r', user_id: 'u', input }
  const profile: RegisteredProfile = { id: 'p1', owner_user_id: 'u', revoked_at: null, sha256: 'a'.repeat(64), config: { version: 1, runtime: 'CODEX', actions: ['free_task'], product_ids: ['p'], repository_product_ids: [], environment_keys: [], access: 'read', publish_modes: ['artifact'], image_digest: `sha256:${'a'.repeat(64)}`, source_mount_keys: [], provider_egress_hosts: [], cpu_millis: 1000, memory_mb: 1024, pids_limit: 100, max_duration_seconds: 300, protocol: 'dispatch-v1' } }
  const slot = (id: string, patch: Partial<RegisteredSlot> = {}): RegisteredSlot => ({ id, kind: 'job', owner_user_id: 'u', token_id: 't', enabled: true, config: { version: 1, runtime: 'CODEX', product_ids: ['p'], capabilities: [], tier: 'LOW_P', worker_instance_id: id }, profile_revision_ids: ['p1'], incarnation_profile_ids: ['p1'], incarnation_id: id, last_seen_at: now, signed_off_at: null, busy: false, worker_seen_at: now, live_job: false, open_reservation: false, ordinary_request_claim: false, quota_pct: null, min_quota_pct: 10, last_reserved_at: null, current_product_ids: ['p'], current_capabilities: [], current_runtime: 'CODEX', ...patch })
  it('ignores higher tier outside exact profile/product scope and prefers an eligible higher tier', () => {
    const low = slot('low'), high = slot('high', { config: { ...slot('high').config, tier: 'HIGH_P' } })
    expect(eligibleExecutors(request, [profile], [low, high], now)[0].slotIds[0]).toBe('high')
    for (const patch of [{ incarnation_profile_ids: ['other'] }, { current_product_ids: ['other'] }, { quota_pct: 1 }, { busy: true }, { current_capabilities: ['deploy'] }]) {
      expect(eligibleExecutors(request, [profile], [low, { ...high, ...patch }], now)[0].slotIds).toEqual(['low'])
    }
  })
  it('orders by load, least recent reservation and stable profile id; counts duplicate slots once', () => {
    const p2 = { ...profile, id: 'p2' }, a = slot('a'), b = slot('b', { profile_revision_ids: ['p2'], incarnation_profile_ids: ['p2'] }), occupied = slot('busy', { busy: true })
    const pools = eligibleExecutors(request, [profile, p2], [a, a, b, occupied], now)
    expect(pools.map(p => p.profileRevisionId)).toEqual(['p2', 'p1']); expect(pools[1].loadRatio).toBe(0.5)
    expect(eligibleExecutors(request, [p2, profile], [a, b], now).map(p => p.profileRevisionId)).toEqual(['p1', 'p2'])
    expect(eligibleExecutors(request, [profile, p2], [{ ...a, last_reserved_at: now }, b], now)[0].profileRevisionId).toBe('p2')
  })
  it('keeps host requirements hard and uses exact freshness boundaries', () => {
    expect(eligibleExecutors({ ...request, input: { ...input, requirements: { ...input.requirements, environment_keys: ['logs'] } } }, [profile], [slot('job')], now)).toEqual([])
    expect(eligibleExecutors(request, [profile], [slot('job', { last_seen_at: new Date(now.getTime() - 30_000) })], now)).toEqual([])
    expect(eligibleExecutors(request, [profile], [slot('host', { kind: 'host', last_seen_at: new Date(now.getTime() - 45_000) })], now)).toEqual([])
  })
})

import { createDispatchTick, DISPATCH_TICK_MAINTENANCE_LIMIT, DISPATCH_TICK_RETENTION_LIMIT } from '../../src/dispatch/tick.js'
import { vi } from 'vitest'
it('tick touches at most 25 request ids and never wires timers on import', async () => {
  const reserve = vi.fn(async () => null), retire = vi.fn(async () => true), waiting = vi.fn(async (limit: number) => Array.from({ length: limit }, (_, i) => String(i)))
  const store = { query: vi.fn(async () => ({ rows: Array.from({ length: 10 }, (_, i) => ({ request_id: String(i) })) })) }
  const tick = createDispatchTick({ store: store as never, selection: { reserveRequest: reserve, retireExpiredCandidate: retire, waitingRequestIds: waiting } as never })
  expect(await tick()).toEqual({ prepared: 0, reserved: 0, retired: 10, uncertain: 0, publications: 0, publicationsFailed: 0, delivered: 0, deliveryFailed: 0, replyReadsRecovered: 0, threadsArchived: 0, threadsRefused: 0, errors: 0 })
  expect(waiting).toHaveBeenCalledWith(15); expect(reserve).toHaveBeenCalledTimes(15); expect(retire).toHaveBeenCalledTimes(10)
})

it('prepares sources before selection, bounds the outbox and survives one poisoned unit per stage', async () => {
  const waiting = vi.fn(async () => ['a', 'b', 'c'])
  const prepared: string[] = []
  const reserved: string[] = []
  const prepareRequestSources = vi.fn(async (id: string) => { if (id === 'b') throw new Error('source unit failed'); prepared.push(id) })
  const reserveRequest = vi.fn(async (id: string) => { if (id === 'c') throw new Error('reserve unit failed'); reserved.push(id); return id })
  const stages: string[] = []
  const tick = createDispatchTick({
    store: { query: vi.fn(async () => ({ rows: [] })) } as never,
    selection: { waitingRequestIds: waiting, reserveRequest, retireExpiredCandidate: vi.fn() } as never,
    attempts: { markExpiredAttempts: vi.fn(async () => { throw new Error('lease unit failed') }) } as never,
    sources: { prepareRequestSources } as never,
    publications: { reconcileIncompletePublications: vi.fn(async () => ({ processed: 2, failed: 1 })) },
    delivery: { deliverDispatchOutbox: vi.fn(async (limit: number) => ({ delivered: limit, failed: 0 })) } as never,
    onError: stage => { stages.push(stage) },
  })
  expect(await tick()).toEqual({ prepared: 2, reserved: 2, retired: 0, uncertain: 0, publications: 2, publicationsFailed: 1, delivered: 100, deliveryFailed: 0, replyReadsRecovered: 0, threadsArchived: 0, threadsRefused: 0, errors: 3 })
  // Preparation runs first and for every waiting request, so selection never sees an unprepared one.
  expect(prepareRequestSources.mock.calls.map(call => call[0])).toEqual(['a', 'b', 'c'])
  expect(prepared).toEqual(['a', 'c'])
  expect(reserved).toEqual(['a', 'b'])
  expect(stages).toEqual(['sources', 'reserve', 'lease'])
})

it('runs queue maintenance last, bounded, once per interval and never on the selection path', async () => {
  let clock = 1_000
  const recoverReplyReads = vi.fn(async (limit: number) => Array.from({ length: Math.min(limit, 2) }, (_, i) => `reply-${i}`))
  const retainThreads = vi.fn(async (_limit: number) => ({ archived: 3, refused: 1 }))
  const order: string[] = []
  const tick = createDispatchTick({
    store: { query: vi.fn(async () => ({ rows: [] })) } as never,
    selection: { waitingRequestIds: vi.fn(async () => []), reserveRequest: vi.fn(), retireExpiredCandidate: vi.fn() } as never,
    delivery: { deliverDispatchOutbox: vi.fn(async () => { order.push('delivery'); return { delivered: 0, failed: 0 } }) } as never,
    maintenance: {
      intervalMs: 900_000, now: () => clock,
      recoverReplyReads: async limit => { order.push('reply_reads'); return recoverReplyReads(limit) },
      retainThreads: async limit => { order.push('retention'); return retainThreads(limit) },
    },
  })
  expect(await tick()).toMatchObject({ replyReadsRecovered: 2, threadsArchived: 3, threadsRefused: 1 })
  // Delivery must never wait behind retention, and retention is bounded by its own batch size.
  expect(order).toEqual(['delivery', 'reply_reads', 'retention'])
  expect(recoverReplyReads).toHaveBeenCalledWith(DISPATCH_TICK_MAINTENANCE_LIMIT)
  expect(retainThreads).toHaveBeenCalledWith(DISPATCH_TICK_RETENTION_LIMIT)
  // The 5s tick is not a maintenance schedule: the next one does nothing until the interval passes.
  clock += 899_999
  expect(await tick()).toMatchObject({ replyReadsRecovered: 0, threadsArchived: 0, threadsRefused: 0 })
  expect(recoverReplyReads).toHaveBeenCalledTimes(1)
  clock += 1
  await tick()
  expect(recoverReplyReads).toHaveBeenCalledTimes(2)
})

it('keeps a failing maintenance stage inside its own unit and retention optional', async () => {
  const stages: string[] = []
  const tick = createDispatchTick({
    store: { query: vi.fn(async () => ({ rows: [] })) } as never,
    selection: { waitingRequestIds: vi.fn(async () => []), reserveRequest: vi.fn(), retireExpiredCandidate: vi.fn() } as never,
    maintenance: { intervalMs: 1, recoverReplyReads: async () => { throw new Error('queue unit failed') } },
    onError: stage => { stages.push(stage) },
  })
  expect(await tick()).toMatchObject({ replyReadsRecovered: 0, threadsArchived: 0, threadsRefused: 0, errors: 1 })
  expect(stages).toEqual(['maintenance:reply_reads'])
})
