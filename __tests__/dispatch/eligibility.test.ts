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

import { createDispatchTick } from '../../src/dispatch/tick.js'
import { vi } from 'vitest'
it('tick touches at most 25 request ids and never wires timers on import', async () => {
  const reserve = vi.fn(async () => null), retire = vi.fn(async () => true), waiting = vi.fn(async (limit: number) => Array.from({ length: limit }, (_, i) => String(i)))
  const store = { query: vi.fn(async () => ({ rows: Array.from({ length: 10 }, (_, i) => ({ request_id: String(i) })) })) }
  const tick = createDispatchTick({ store: store as never, selection: { reserveRequest: reserve, retireExpiredCandidate: retire, waitingRequestIds: waiting } as never })
  expect(await tick()).toEqual({ prepared: 0, reserved: 0, retired: 10, uncertain: 0, publications: 0, publicationsFailed: 0, delivered: 0, deliveryFailed: 0, errors: 0 })
  expect(waiting).toHaveBeenCalledWith(15); expect(reserve).toHaveBeenCalledTimes(15); expect(retire).toHaveBeenCalledTimes(10)
})
