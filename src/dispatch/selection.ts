import {rejectUnstartedInTransaction} from './sources.js'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { DispatchActor } from './ports.js'
import type { DispatchAuth } from './auth.js'
import { withDispatchRetryTransaction, type DispatchStore } from './db.js'
import { DispatchError } from './errors.js'
import { eligibleExecutors, tierPriority, type RegisteredSlot, type RegisteredProfile } from './eligibility.js'
import { parseManagedSlotConfig, actorForToken, type IncarnationScope } from './registration.js'
import { enqueueManagedJob, lockManagedTask, readManagedJobSnapshot, type ManagedRequest } from './job-adapter.js'

type Request = ManagedRequest & { state: string; generation: number; first_claimed_at: Date | null; sources_ready_at: Date | null; principal_key: string; auth_source: { source: DispatchActor['source']; token_id: string | null }; root_message_id: string; reply_message_id: string }
function requestActor(r: Request): DispatchActor {
  return { userId: r.user_id, tokenId: r.auth_source.token_id, source: r.auth_source.source, principalKey: r.principal_key, isDemo: false, scopedProducts: [], scopedRepos: [], tokenKind: null }
}
export async function loadRegisteredCapacity(db: PoolClient, request: ManagedRequest, auth: DispatchAuth) {
  const profiles = (await db.query<RegisteredProfile>('SELECT id,owner_user_id,config,revoked_at,sha256 FROM queue_dispatch_profiles WHERE config->\'product_ids\' ? $1', [request.product_id])).rows
  const rows = (await db.query(`SELECT s.*,i.id AS incarnation_id,i.last_seen_at,i.signed_off_at,i.busy,i.runtime_scope,
  w.last_seen_at AT TIME ZONE 'UTC' AS worker_seen_at,w.runtime AS worker_runtime,w.capabilities AS worker_capabilities,w.product_id AS worker_product_id,w.capability AS worker_tier,w.last_quota_pct AS quota_pct,
  u.min_quota_pct,ARRAY(SELECT profile_revision_id::text FROM queue_dispatch_slot_profiles WHERE slot_id=s.id) AS profile_revision_ids,
  EXISTS(SELECT 1 FROM queue_dispatch_reservations WHERE slot_id=s.id AND released_at IS NULL) AS open_reservation,
  EXISTS(SELECT 1 FROM claude_jobs WHERE worker_instance_id=s.config->>'worker_instance_id' AND status IN ('CLAIMED','RUNNING')) AS live_job,
  EXISTS(SELECT 1 FROM agent_message WHERE to_server=split_part(s.address,':',1) AND to_model=split_part(s.address,':',2)
   AND status='claimed' AND type IN ('task','info','review_request') AND dispatch_request_id IS NULL) AS ordinary_request_claim,
  (SELECT max(c.deadline-interval '120 seconds') FROM queue_dispatch_reservations r JOIN queue_dispatch_candidates c ON c.id=r.candidate_id WHERE r.slot_id=s.id) AS last_reserved_at
  FROM queue_dispatch_slots s
  JOIN users u ON u.id=s.owner_user_id
  LEFT JOIN queue_dispatch_incarnations i ON i.slot_id=s.id AND i.signed_off_at IS NULL
  LEFT JOIN claude_workers w ON w.user_id=s.owner_user_id AND w.token_id=s.token_id AND w.instance_id=s.config->>'worker_instance_id'
  WHERE s.owner_user_id=$1 ORDER BY s.id`, [request.user_id])).rows
  const slots: RegisteredSlot[] = []
  for (const row of rows) {
    try {
      const config = parseManagedSlotConfig(row.config), scope = row.runtime_scope as IncarnationScope | undefined
      if (!scope || scope.version !== 1 || scope.supervisor_token_id !== row.token_id || !Array.isArray(scope.profile_revision_ids)
        || !Array.isArray(scope.product_ids) || !Array.isArray(scope.capabilities)
        || scope.runtime !== config.runtime || scope.capabilities.some(c => !config.capabilities.includes(c))
        || config.capabilities.length !== scope.capabilities.length) continue
      await auth.authorizeDispatch(actorForToken(row.owner_user_id, row.token_id), request.input, 'claim', db)
      const tiers = [config.tier,scope.tier,row.worker_tier]
      const tier = row.kind==='job' && tiers.every(t=>t!==null&&t!==undefined)
        ? tiers.sort((a,b)=>tierPriority(a)-tierPriority(b))[0] : null
      slots.push({
        ...row, config: { ...config, tier, product_ids: config.product_ids.filter(id => scope.product_ids.includes(id)), capabilities: scope.capabilities },
        incarnation_profile_ids: scope.profile_revision_ids, min_quota_pct: row.min_quota_pct ?? 0, quota_pct: row.kind === 'job' ? row.quota_pct : null,
        current_product_ids: config.product_ids.filter(id => row.kind === 'host' || !row.worker_product_id || row.worker_product_id === id),
        current_capabilities: row.kind === 'job' ? (row.worker_capabilities ?? []) : config.capabilities,
        current_runtime: row.kind === 'job' ? row.worker_runtime : scope.runtime,
      })
    } catch (error) { if (!(error instanceof DispatchError)) throw error }
  }
  return { profiles, slots }
}
async function event(db: PoolClient, id: string, type: string, payload: Record<string, unknown>) {
  if (type === 'waiting_reason') {
    const previous = (await db.query<{ payload: { reason: string } }>("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='waiting_reason' ORDER BY created_at DESC,id DESC LIMIT 1", [id])).rows[0]
    if (previous?.payload.reason === payload.reason) return
  }
  await db.query('INSERT INTO queue_dispatch_events(id,request_id,type,actor,payload) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)', [randomUUID(), id, type, JSON.stringify({ service: 'dispatch' }), JSON.stringify(payload)])
}
async function outbox(db: PoolClient, r: Request, state: string) {
  const updated = (await db.query<{ version: string }>('UPDATE queue_dispatch_requests SET state=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING version::text', [r.id, state])).rows[0]
  await db.query('INSERT INTO queue_dispatch_outbox(id,request_id,version,payload) VALUES($1,$2,$3,$4::jsonb)', [randomUUID(), r.id, updated.version, JSON.stringify({ version: updated.version, request_id: r.id, root_message_id: r.root_message_id, reply_message_id: r.reply_message_id, state })])
}
export function createDispatchSelection(deps: { store: DispatchStore; auth: DispatchAuth; enabled: boolean; productAllowlist: readonly string[] }) {
  async function waitingRequestIds(limit = 25): Promise<string[]> {
    if (!deps.enabled) return []
    return (await deps.store.query<{ id: string }>(`SELECT id FROM queue_dispatch_requests WHERE state='WAITING' AND product_id=ANY($1::text[])
   ORDER BY updated_at,created_at,id LIMIT $2`, [deps.productAllowlist, Math.min(25, Math.max(0, limit))])).rows.map(r => r.id)
  }
  async function reserveRequest(id: string): Promise<string | null> {
    if (!deps.enabled) return null
    const before = (await deps.store.query<Request>('SELECT * FROM queue_dispatch_requests WHERE id=$1 AND state=\'WAITING\' AND product_id=ANY($2::text[])', [id, deps.productAllowlist])).rows[0]
    if (!before) return null
    const snapshot = await readManagedJobSnapshot(deps.store, before)
    return withDispatchRetryTransaction(deps.store, async db => {
      const r = (await db.query<Request>("SELECT * FROM queue_dispatch_requests WHERE id=$1 AND state='WAITING' FOR UPDATE SKIP LOCKED", [id])).rows[0]
      if (!r || !r.sources_ready_at) return null
      try { await deps.auth.authorizeDispatch(requestActor(r), r.input, 'claim', db); await lockManagedTask(db, r) } catch (error) {
        if (!(error instanceof DispatchError)) throw error
        if(['DISPATCH_FORBIDDEN','DISPATCH_UNAUTHENTICATED'].includes(error.code)){await rejectUnstartedInTransaction(db,r.id,'authorization_unavailable');return null}
        await event(db, r.id, 'waiting_reason', { reason: error.code === 'DISPATCH_STATE_CONFLICT' ? 'task_not_dispatchable' : 'authorization_unavailable' })
        await db.query('UPDATE queue_dispatch_requests SET updated_at=now() WHERE id=$1', [id]); return null
      }
      const now = (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
      const { profiles, slots } = await loadRegisteredCapacity(db, r, deps.auth)
      const cooldown = (await db.query<{ profile_id: string; route: string }>(`SELECT payload->>'profile_revision_id' AS profile_id,payload->>'route' AS route FROM queue_dispatch_events
    WHERE request_id=$1 AND type='pool_cooldown' AND (payload->>'eligible_after')::timestamptz>now()`, [id])).rows
      const pools = eligibleExecutors(r, profiles, slots, now).filter(p => snapshot[profiles.find(profile=>profile.id===p.profileRevisionId)!.config.runtime]!==null).filter(p => !cooldown.some(c => c.profile_id === p.profileRevisionId && c.route === p.route))
      for (const pool of pools) {
        // Sorted slot locking across equivalent pools; no job/attempt lock precedes it.
        const locked = (await db.query<{ id: string }>('SELECT id FROM queue_dispatch_slots WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE SKIP LOCKED', [pool.slotIds])).rows.map(s => s.id)
        if (!locked.length) continue
        // Re-read current rights, profile, incarnation and occupancy under slot locks.
        const current = await loadRegisteredCapacity(db, r, deps.auth)
        const freshNow=(await db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now
        const eligible = eligibleExecutors(r, current.profiles, current.slots, freshNow).find(p => p.profileRevisionId === pool.profileRevisionId && p.route === pool.route)
        const slotId = eligible?.slotIds.find(s => locked.includes(s)); if (!slotId) continue
        await deps.auth.authorizeDispatch(requestActor(r), r.input, 'claim', db)
        const p = current.profiles.find(p => p.id === pool.profileRevisionId)!, slot = current.slots.find(s => s.id === slotId)!
        const candidateId = randomUUID(), generation = r.generation + 1
        await db.query(`INSERT INTO queue_dispatch_candidates(id,request_id,generation,route,profile_revision_id,incarnation_id,state,reserved_slot_id,deadline)
     VALUES($1,$2,$3,$4,$5,$6,'RESERVED',$7,clock_timestamp()+interval '120 seconds')`, [candidateId, id, generation, pool.route, p.id, pool.route === 'host' ? slot.incarnation_id : null, slotId])
        await db.query('INSERT INTO queue_dispatch_reservations(id,candidate_id,slot_id) VALUES($1,$2,$3)', [randomUUID(), candidateId, slotId])
        const cfg = snapshot[p.config.runtime]!
        const jobId = pool.route === 'job' ? await enqueueManagedJob(db, r, { id: candidateId, profileRevisionId: p.id, runtime: p.config.runtime }, cfg) : null
        if (jobId) await db.query('UPDATE queue_dispatch_candidates SET job_id=$2 WHERE id=$1', [candidateId, jobId])
        await db.query('UPDATE queue_dispatch_requests SET generation=$2 WHERE id=$1', [id, generation])
        await event(db, id, 'reserved', { candidate_id: candidateId, profile_revision_id: p.id, slot_id: slotId, route: pool.route, job_id: jobId, job_config: cfg })
        await outbox(db, r, 'RESERVED')
        return id
      }
      await event(db, id, 'waiting_reason', { reason: cooldown.length ? 'pool_cooldown' : 'no_eligible_capacity' })
      await db.query('UPDATE queue_dispatch_requests SET updated_at=now() WHERE id=$1', [id]); return null
    })
  }
  async function reserveNextRequest(): Promise<string | null> { for (const id of await waitingRequestIds()) { const result = await reserveRequest(id); if (result) return result } return null }
  async function retireExpiredCandidate(requestId: string): Promise<boolean> {
    return withDispatchRetryTransaction(deps.store, async db => {
      const r = (await db.query<Request>('SELECT * FROM queue_dispatch_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0]
      if (!r || r.state !== 'RESERVED' || r.first_claimed_at) return false
      // Retirement does not need current Task eligibility, but takes its lock first.
      if (r.input.task_id) await db.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [r.input.task_id])
      const c = (await db.query<{ id: string; first_claimed_at: Date | null; reserved_slot_id: string; job_id: string | null; profile_revision_id: string; route: 'job' | 'host' }>(
        `SELECT * FROM queue_dispatch_candidates WHERE request_id=$1 AND generation=$2 AND state='RESERVED' AND deadline<=now() FOR UPDATE`, [requestId, r.generation])).rows[0]
      if (!c || c.first_claimed_at) return false
      await db.query('SELECT id FROM queue_dispatch_slots WHERE id=$1 FOR UPDATE', [c.reserved_slot_id])
      if (c.job_id) {
        const job = (await db.query<{ status: string; claimed_at: Date | null }>('SELECT status,claimed_at FROM claude_jobs WHERE id=$1 FOR UPDATE', [c.job_id])).rows[0]
        if (!job || job.status !== 'QUEUED' || job.claimed_at) return false
        await db.query("UPDATE claude_jobs SET status='CANCELLED',finished_at=now(),updated_at=now() WHERE id=$1 AND status='QUEUED'", [c.job_id])
      }
      await db.query("UPDATE queue_dispatch_candidates SET state='RETIRED' WHERE id=$1", [c.id])
      await db.query('UPDATE queue_dispatch_reservations SET released_at=now() WHERE candidate_id=$1 AND released_at IS NULL', [c.id])
      const eligibleAfter = new Date((await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now.getTime() + 300_000).toISOString()
      await event(db, requestId, 'pool_cooldown', { profile_revision_id: c.profile_revision_id, route: c.route, eligible_after: eligibleAfter, candidate_id: c.id })
      await outbox(db, r, 'WAITING'); return true
    })
  }
  return { waitingRequestIds, reserveRequest, reserveNextRequest, retireExpiredCandidate }
}
export type DispatchSelection = ReturnType<typeof createDispatchSelection>
