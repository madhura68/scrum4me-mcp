import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDispatchHarness, type DispatchHarness, type DispatchHarnessSeed } from './harness.js'
import { createDispatchAuth } from '../../src/dispatch/auth.js'
import { createDispatchRequests } from '../../src/dispatch/requests.js'
import { createReadyFixtureSelection as createDispatchSelection } from './source-fixtures.js'
let h: DispatchHarness, f: DispatchHarnessSeed, selection: ReturnType<typeof createDispatchSelection>, requestId: string
beforeEach(async () => {
  h = await makeDispatchHarness(); f = await h.seed(); const auth = createDispatchAuth({ store: h.dispatch })
  selection = createDispatchSelection({ store: h.dispatch, auth, enabled: true, productAllowlist: [f.input.product_id] })
  requestId = (await createDispatchRequests({ store: h.dispatch, auth, enabled: true, productAllowlist: [f.input.product_id] }).submitDispatch(f.actor, f.input, 'timeout')).id
  await selection.reserveNextRequest()
  const admin = await h.admin.connect()
  try { await admin.query('BEGIN'); await admin.query("SET LOCAL session_replication_role='replica'"); await admin.query("UPDATE queue_dispatch_candidates SET deadline=now()-interval '1 second' WHERE request_id=$1", [requestId]); await admin.query('COMMIT') } finally { admin.release() }
})
afterEach(async () => { await h?.close() })
async function state() {
  return (await h.dispatch.query(`SELECT r.state AS request_state,c.state AS candidate_state,j.status AS job_state,r.first_claimed_at,
  rs.released_at FROM queue_dispatch_requests r JOIN queue_dispatch_candidates c ON c.request_id=r.id AND c.generation=r.generation
  JOIN claude_jobs j ON j.id=c.job_id JOIN queue_dispatch_reservations rs ON rs.candidate_id=c.id WHERE r.id=$1`, [requestId])).rows[0]
}
/** This is an actual competing SQL transaction, not the IP-06 claim handler.
 * IP-06 must repeat the race with claimDispatchAttempt and its attempt proof. */
async function competingClaim(barrier: () => Promise<void>) {
  const db = await h.dispatch.connect()
  try {
    await db.query('BEGIN'); await barrier()
    const r = (await db.query('SELECT state FROM queue_dispatch_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0]
    if (r.state !== 'RESERVED') { await db.query('COMMIT'); return false }
    const c = (await db.query('SELECT id,job_id,reserved_slot_id FROM queue_dispatch_candidates WHERE request_id=$1 FOR UPDATE', [requestId])).rows[0]
    await db.query('SELECT id FROM queue_dispatch_slots WHERE id=$1 FOR UPDATE', [c.reserved_slot_id])
    await db.query("UPDATE claude_jobs SET status='CLAIMED',claimed_at=now() WHERE id=$1", [c.job_id])
    await db.query("UPDATE queue_dispatch_candidates SET state='CLAIMED',first_claimed_at=now() WHERE id=$1", [c.id])
    await db.query("UPDATE queue_dispatch_requests SET state='CLAIMED',first_claimed_at=now() WHERE id=$1", [requestId])
    await db.query('COMMIT'); return true
  } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
}
describe('unclaimed candidate retirement', () => {
  it('cancels queued job and retires before release, persisting and honoring pool cooldown', async () => {
    expect(await selection.retireExpiredCandidate(requestId)).toBe(true)
    expect(await state()).toMatchObject({ request_state: 'WAITING', candidate_state: 'RETIRED', job_state: 'CANCELLED', first_claimed_at: null })
    expect((await state()).released_at).not.toBeNull()
    expect((await h.dispatch.query("SELECT payload FROM queue_dispatch_events WHERE request_id=$1 AND type='pool_cooldown'", [requestId])).rows[0].payload).toMatchObject({ profile_revision_id: f.profileId })
    expect(await selection.retireExpiredCandidate(requestId)).toBe(false)
    await h.dispatch.query('UPDATE queue_dispatch_incarnations SET busy=true WHERE id=$1', [f.hostSlot.incarnationId])
    expect(await selection.reserveNextRequest()).toBeNull()
    await h.dispatch.query('UPDATE queue_dispatch_incarnations SET busy=false WHERE id=$1', [f.hostSlot.incarnationId])
    expect(await selection.reserveNextRequest()).toBe(requestId)
    expect((await h.dispatch.query("SELECT route FROM queue_dispatch_candidates WHERE request_id=$1 AND state='RESERVED'", [requestId])).rows[0].route).toBe('host')
  })
  it('preserves a previous claim even when a job is artificially put back in QUEUED', async () => {
    await competingClaim(async () => { })
    await h.dispatch.query("UPDATE claude_jobs SET status='QUEUED' WHERE dispatch_request_id=$1", [requestId])
    await h.dispatch.query("UPDATE queue_dispatch_candidates SET state='RESERVED' WHERE request_id=$1", [requestId])
    await h.dispatch.query("UPDATE queue_dispatch_requests SET state='RESERVED' WHERE id=$1", [requestId])
    expect(await selection.retireExpiredCandidate(requestId)).toBe(false)
    expect((await state()).released_at).toBeNull()
  })
  it('serializes timeout versus competing claim on distinct real PostgreSQL connections with a barrier', async () => {
    const barrier = h.barrier(2)
    const [retired, claimed] = await Promise.all([barrier().then(() => selection.retireExpiredCandidate(requestId)), competingClaim(barrier)])
    expect(Number(retired) + Number(claimed)).toBe(1)
    const row = await state()
    if (claimed) expect(row).toMatchObject({ request_state: 'CLAIMED', candidate_state: 'CLAIMED', job_state: 'CLAIMED', released_at: null })
    else expect(row).toMatchObject({ request_state: 'WAITING', candidate_state: 'RETIRED', job_state: 'CANCELLED', first_claimed_at: null })
  })
})
