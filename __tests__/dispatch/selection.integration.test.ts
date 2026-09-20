import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { makeDispatchHarness, type DispatchHarness, type DispatchHarnessSeed } from './harness.js'
import { createDispatchAuth } from '../../src/dispatch/auth.js'
import { createDispatchRequests } from '../../src/dispatch/requests.js'
import { createReadyFixtureSelection as createDispatchSelection } from './source-fixtures.js'
import { createDispatchRegistration } from '../../src/dispatch/registration.js'
let h: DispatchHarness, f: DispatchHarnessSeed
let selection: ReturnType<typeof createDispatchSelection>
let requests: ReturnType<typeof createDispatchRequests>
let registration: ReturnType<typeof createDispatchRegistration>
beforeEach(async () => {
  h = await makeDispatchHarness(); f = await h.seed()
  const auth = createDispatchAuth({ store: h.dispatch })
  requests = createDispatchRequests({ store: h.dispatch, auth, enabled: true, productAllowlist: [f.input.product_id] })
  selection = createDispatchSelection({ store: h.dispatch, auth, enabled: true, productAllowlist: [f.input.product_id] })
  registration = createDispatchRegistration({ store: h.dispatch, auth, credentialKeys: { 1: Buffer.alloc(32, 7) }, keyVersion: 1 })
})
afterEach(async () => { await h?.close() })
describe('atomic capacity selection', () => {
  it('reserves once and prefers an eligible job pool', async () => {
    const r = await requests.submitDispatch(f.actor, f.input, 'prefer-job')
    await Promise.all([selection.reserveNextRequest(), selection.reserveNextRequest()])
    const rows = (await h.dispatch.query('SELECT route FROM queue_dispatch_candidates WHERE request_id=$1', [r.id])).rows
    expect(rows).toEqual([{ route: 'job' }])
    expect((await h.dispatch.query('SELECT count(*)::int AS n FROM claude_jobs WHERE dispatch_request_id=$1', [r.id])).rows[0].n).toBe(1)
  })
  it('uses host when job is occupied, and keeps stale host waiting', async () => {
    await h.dispatch.query('UPDATE queue_dispatch_incarnations SET busy=true WHERE id=$1', [f.jobSlot.incarnationId])
    const r = await requests.submitDispatch(f.actor, f.input, 'host')
    expect(await selection.reserveNextRequest()).toBe(r.id)
    expect((await requests.getDispatch(f.actor, r.id)).route).toBe('host')
    await h.dispatch.query("UPDATE queue_dispatch_incarnations SET last_seen_at=now()-interval '46 seconds' WHERE id=$1", [f.hostSlot.incarnationId])
    const other = await requests.submitDispatch(f.actor, f.input, 'waiting')
    expect(await selection.reserveNextRequest()).toBeNull()
    expect((await requests.getDispatch(f.actor, other.id)).state).toBe('WAITING')
  })
  it('rechecks revoked token and profile', async () => {
    await requests.submitDispatch(f.actor, f.input, 'revoked')
    await h.admin.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1', [f.actor.tokenId])
    expect(await selection.reserveNextRequest()).toBeNull()
    expect((await h.dispatch.query('SELECT count(*)::int AS n FROM queue_dispatch_candidates')).rows[0].n).toBe(0)
  })
})
describe('authenticated incarnation registration', () => {
  it('refuses an old job config that binds an ordinary worker identity', async () => {
    await h.dispatch.query("UPDATE queue_dispatch_slots SET config=jsonb_set(config,'{worker_instance_id}',to_jsonb($2::text)) WHERE id=$1", [f.jobSlot.id, f.jobSlot.id])
    await expect(registration.registerDispatchExecutor(f.actor, { registration_key: 'ordinary-config', slot_id: f.jobSlot.id, boot_id: 'new', runtime: 'CODEX', image_digest: `sha256:${'a'.repeat(64)}`, profile_sha256: 'a'.repeat(64) })).rejects.toThrow('DISPATCH_INVALID_INPUT')
  })
  it('reconstructs the same credential and stores only its hash', async () => {
    const input = { registration_key: 'same-boot', slot_id: f.jobSlot.id, boot_id: 'boot-new', runtime: 'CODEX' as const, image_digest: `sha256:${'a'.repeat(64)}`, profile_sha256: 'a'.repeat(64) }
    const [a, b] = await Promise.all([registration.registerDispatchExecutor(f.actor, input), registration.registerDispatchExecutor(f.actor, input)])
    expect(a).toEqual(b)
    const row = (await h.dispatch.query('SELECT credential_hash,runtime_scope FROM queue_dispatch_incarnations WHERE id=$1', [a.incarnation_id])).rows[0]
    expect(row.credential_hash).toBe(createHash('sha256').update(a.session_credential).digest('hex'))
    expect(JSON.stringify(row)).not.toContain(a.session_credential)
  })
  it('new boot keeps the same slot and preserves an old reservation', async () => {
    const r = await requests.submitDispatch(f.actor, f.input, 'held'); await selection.reserveNextRequest()
    const a = await registration.registerDispatchExecutor(f.actor, { registration_key: 'new-boot', slot_id: f.jobSlot.id, boot_id: 'new-boot', runtime: 'CODEX', image_digest: `sha256:${'a'.repeat(64)}`, profile_sha256: 'a'.repeat(64) })
    expect(a.incarnation_id).not.toBe(f.jobSlot.incarnationId)
    expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE slot_id=$1', [f.jobSlot.id])).rows).toEqual([{ released_at: null }])
    expect((await requests.getDispatch(f.actor, r.id)).state).toBe('RESERVED')
  })
})

describe('current eligibility negatives', () => {
  it.each(['scope', 'runtime', 'capability', 'profile', 'quota', 'stale-worker'])('does not select an ineligible job (%s)', async reason => {
    await h.dispatch.query('UPDATE queue_dispatch_incarnations SET busy=true WHERE id=$1', [f.hostSlot.incarnationId])
    if (reason === 'scope') await h.admin.query("UPDATE claude_workers SET product_id='other' WHERE instance_id=$1", [f.jobSlot.instanceId])
    if (reason === 'runtime') await h.admin.query("UPDATE claude_workers SET runtime='CLAUDE' WHERE instance_id=$1", [f.jobSlot.instanceId])
    if (reason === 'capability') await h.dispatch.query("UPDATE queue_dispatch_slots SET config=jsonb_set(config,'{capabilities}','[\"deploy\"]') WHERE id=$1", [f.jobSlot.id])
    if (reason === 'profile') await h.dispatch.query('UPDATE queue_dispatch_profiles SET revoked_at=now() WHERE id=$1', [f.profileId])
    if (reason === 'quota') { await h.admin.query('UPDATE users SET min_quota_pct=20 WHERE id=$1', [f.actor.userId]); await h.admin.query('UPDATE claude_workers SET last_quota_pct=5 WHERE instance_id=$1', [f.jobSlot.instanceId]) }
    if (reason === 'stale-worker') await h.admin.query("UPDATE claude_workers SET last_seen_at=now()-interval '31 seconds' WHERE instance_id=$1", [f.jobSlot.instanceId])
    await requests.submitDispatch(f.actor, f.input, 'negative')
    expect(await selection.reserveNextRequest()).toBeNull()
    expect((await h.dispatch.query('SELECT count(*)::int AS n FROM queue_dispatch_candidates')).rows[0].n).toBe(0)
  })
  it('ordinary request claim occupies host capacity, unread reply does not', async () => {
    await h.dispatch.query('UPDATE queue_dispatch_incarnations SET busy=true WHERE id=$1', [f.jobSlot.incarnationId])
    const id = crypto.randomUUID()
    await h.admin.query(`INSERT INTO agent_message(id,from_server,from_model,to_server,to_model,type,body,status,source) VALUES($1,'mac','jp','max2','codex','task','fixture','claimed','cli')`, [id])
    try {
      await requests.submitDispatch(f.actor, f.input, 'ordinary-host')
      expect(await selection.reserveNextRequest()).toBeNull()
      await h.admin.query("UPDATE agent_message SET type='result',in_reply_to=id WHERE id=$1", [id])
      expect(await selection.reserveNextRequest()).not.toBeNull()
    } finally { await h.admin.query('DELETE FROM agent_message WHERE id=$1', [id]) }
  })
  it('rejects registration capabilities advertised outside the typed contract', async () => {
    await expect(registration.registerDispatchExecutor(f.actor, { registration_key: 'widen', slot_id: f.jobSlot.id, boot_id: 'b', runtime: 'CODEX', image_digest: `sha256:${'a'.repeat(64)}`, profile_sha256: 'a'.repeat(64), capabilities: ['deploy'] } as never)).rejects.toThrow('DISPATCH_INVALID_INPUT')
  })
})

describe('managed host identity and exact worker binding', () => {
  it('concurrent product registrations cannot create two host slots and disabled identity survives token changes', async () => {
    const secondProduct = crypto.randomUUID(), secondProfile = crypto.randomUUID()
    await h.admin.query("INSERT INTO products(id,name,user_id,definition_of_done,updated_at) VALUES($1,'extra-fixture',$2,'test',now())", [secondProduct, f.actor.userId]); h.trackProduct(secondProduct)
    await h.admin.query('UPDATE api_tokens SET scoped_products=array_append(scoped_products,$2) WHERE id=$1', [f.actor.tokenId, secondProduct])
    const p = (await h.dispatch.query('SELECT config FROM queue_dispatch_profiles WHERE id=$1', [f.profileId])).rows[0].config
    await h.dispatch.query('INSERT INTO queue_dispatch_profiles(id,key,revision,product_id,owner_user_id,config,sha256) VALUES($1::uuid,$1::text,1,$2,$3,$4::jsonb,$5)', [secondProfile, secondProduct, f.actor.userId, JSON.stringify({ ...p, product_ids: [secondProduct] }), 'd'.repeat(64)])
    const base = { token_id: f.actor.tokenId!, kind: 'host' as const, capacity_key: 'host:mac:codex', address: ' MAC:CODEX ' }
    const [a, b] = await Promise.all([
      registration.createSlot(f.actor, { ...base, action_id: 'first-product', product_id: f.input.product_id, profile_revision_ids: [f.profileId] }),
      registration.createSlot(f.actor, { ...base, action_id: 'second-product', product_id: secondProduct, profile_revision_ids: [secondProfile] }),
    ]); h.trackSlot(a.id)
    expect(a.id).toBe(b.id)
    expect((await h.dispatch.query("SELECT count(*)::int AS n FROM queue_dispatch_slots WHERE address='mac:codex'")).rows[0].n).toBe(1)
    await h.dispatch.query('UPDATE queue_dispatch_slots SET enabled=false WHERE id=$1', [a.id])
    const again = await registration.createSlot(f.actor, { ...base, action_id: 'third', product_id: f.input.product_id, profile_revision_ids: [f.profileId] })
    expect(again).toMatchObject({ id: a.id, enabled: false })
    await expect(registration.createSlot(f.actor, { ...base, capacity_key: 'host:other', action_id: 'wrong-key', product_id: f.input.product_id, profile_revision_ids: [f.profileId] })).rejects.toThrow('DISPATCH_INVALID_INPUT')
  })
  it('binds the exact worker among multiple rows and refuses absent bootstrap', async () => {
    const other = crypto.randomUUID()
    await h.admin.query("INSERT INTO claude_workers(id,user_id,token_id,instance_id,runtime,capabilities,capability,last_seen_at) VALUES($1,$2,$3,'managed:' || $1,'CLAUDE',ARRAY['deploy'],'HIGH_P',now())", [other, f.actor.userId, f.actor.tokenId])
    const base = { action_id: 'exact', token_id: f.actor.tokenId!, product_id: f.input.product_id, kind: 'job' as const, capacity_key: `job:${f.jobSlot.instanceId}`, address: null, profile_revision_ids: [f.profileId] }
    await expect(registration.createSlot(f.actor, { ...base, action_id: 'ordinary-key', capacity_key: `job:${f.jobSlot.id}` })).rejects.toThrow('DISPATCH_INVALID_INPUT')
    const same = await registration.createSlot(f.actor, base)
    expect(same.id).toBe(f.jobSlot.id)
    expect((await h.dispatch.query('SELECT config FROM queue_dispatch_slots WHERE id=$1', [same.id])).rows[0].config).toMatchObject({ runtime: 'CODEX', worker_instance_id: f.jobSlot.instanceId, capabilities: [], tier: null })
    await expect(registration.createSlot(f.actor, { ...base, action_id: 'absent', capacity_key: 'job:managed:missing' })).rejects.toThrow('DISPATCH_FORBIDDEN')
    await expect(registration.createSlot(f.actor, { ...base, action_id: 'wrong-runtime', capacity_key: `job:managed:${other}` })).rejects.toThrow('DISPATCH_FORBIDDEN')
  })
  it('different profiles sharing a slot cannot reserve it twice', async () => {
    const extra = crypto.randomUUID()
    await h.dispatch.query('INSERT INTO queue_dispatch_profiles(id,key,revision,product_id,owner_user_id,config,sha256) SELECT $1::uuid,$1::text,1,product_id,owner_user_id,config,sha256 FROM queue_dispatch_profiles WHERE id=$2', [extra, f.profileId])
    await h.dispatch.query('INSERT INTO queue_dispatch_slot_profiles(slot_id,profile_revision_id) VALUES($1,$2)', [f.jobSlot.id, extra])
    await h.dispatch.query("UPDATE queue_dispatch_incarnations SET runtime_scope=jsonb_set(runtime_scope,'{profile_revision_ids}',runtime_scope->'profile_revision_ids'||to_jsonb($2::text)) WHERE id=$1", [f.jobSlot.incarnationId, extra])
    await h.dispatch.query('UPDATE queue_dispatch_incarnations SET busy=true WHERE id=$1', [f.hostSlot.incarnationId])
    await requests.submitDispatch(f.actor, f.input, 'shared-one'); await requests.submitDispatch(f.actor, f.input, 'shared-two')
    await Promise.all([selection.reserveNextRequest(), selection.reserveNextRequest()])
    expect((await h.dispatch.query('SELECT count(*)::int AS n FROM queue_dispatch_reservations WHERE slot_id=$1 AND released_at IS NULL', [f.jobSlot.id])).rows[0].n).toBe(1)
    expect((await h.dispatch.query('SELECT count(*)::int AS n FROM claude_jobs WHERE dispatch_request_id IS NOT NULL')).rows[0].n).toBe(1)
  })
})

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { dispatchTaskImplementation, isManagedTaskRefusal } from '../../src/lib/dispatch/task-implementation.js'
async function explicitTask() {
  const pbi = crypto.randomUUID(), story = crypto.randomUUID(), task = crypto.randomUUID(), profileId = crypto.randomUUID()
  await h.admin.query("UPDATE products SET repo_url='https://forge.test/repo.git' WHERE id=$1", [f.input.product_id])
  await h.admin.query("INSERT INTO pbis(id,product_id,code,title,priority,sort_order,updated_at) VALUES($1,$2,'PBI-1','PBI',1,1,now())", [pbi, f.input.product_id])
  await h.admin.query("INSERT INTO stories(id,pbi_id,product_id,code,title,acceptance_criteria,priority,sort_order,updated_at) VALUES($1,$2,$3,'ST-1','Story','accepted',1,1,now())", [story, pbi, f.input.product_id])
  await h.admin.query("INSERT INTO tasks(id,story_id,product_id,code,title,implementation_plan,priority,sort_order,updated_at) VALUES($1,$2,$3,'T-1','Task','accepted plan',1,1,now())", [task, story, f.input.product_id])
  const profile = (await h.dispatch.query('SELECT config FROM queue_dispatch_profiles WHERE id=$1', [f.profileId])).rows[0].config
  await h.dispatch.query('INSERT INTO queue_dispatch_profiles(id,key,revision,product_id,owner_user_id,config,sha256) VALUES($1::uuid,$1::text,1,$2,$3,$4::jsonb,$5)', [profileId, f.input.product_id, f.actor.userId, JSON.stringify({ ...profile, actions: ['task_implementation'], access: 'repo_write', repository_product_ids: [f.input.product_id], publish_modes: ['branch'] }), 'e'.repeat(64)])
  await h.dispatch.query('INSERT INTO queue_dispatch_slot_profiles(slot_id,profile_revision_id) VALUES($1,$2)', [f.jobSlot.id, profileId])
  await h.dispatch.query("UPDATE queue_dispatch_slots SET config=jsonb_set(config,'{capabilities}','[\"code_edit\"]') WHERE id=$1", [f.jobSlot.id])
  await h.dispatch.query("UPDATE queue_dispatch_incarnations SET runtime_scope=jsonb_set(jsonb_set(runtime_scope,'{capabilities}','[\"code_edit\"]'),'{profile_revision_ids}',to_jsonb(ARRAY[$2::text])) WHERE id=$1", [f.jobSlot.incarnationId, profileId])
  await h.admin.query("UPDATE claude_workers SET capabilities=ARRAY['code_edit'] WHERE instance_id=$1", [f.jobSlot.instanceId])
  return { ...f.input, action: 'task_implementation' as const, task_id: task, publish: 'branch' as const, requirements: { access: 'repo_write' as const, environment_keys: [], repository: { product_id: f.input.product_id, base_sha: 'a'.repeat(40) } } }
}
describe('shared Task locking', () => {
  it('races actual ordinary and managed enqueue handlers over separate PostgreSQL connections', async () => {
    const input = await explicitTask(), r = await requests.submitDispatch(f.actor, input, 'task-race')
    const db = new PrismaClient({ adapter: new PrismaPg(h.web) })
    try {
      const barrier = h.barrier(2)
      const outcomes = await Promise.allSettled([
        barrier().then(() => selection.reserveNextRequest()),
        barrier().then(() => dispatchTaskImplementation({ taskId: input.task_id, productId: input.product_id, userId: f.actor.userId }, { db, notify: async () => { } })),
      ])
      const jobs = (await h.admin.query("SELECT dispatch_request_id FROM claude_jobs WHERE task_id=$1 AND status IN ('QUEUED','CLAIMED','RUNNING')", [input.task_id])).rows
      expect(jobs).toHaveLength(1)
      if (jobs[0].dispatch_request_id === r.id) {
        expect(outcomes[0]).toMatchObject({status:'fulfilled',value:r.id})
        expect(outcomes[1].status).toBe('rejected')
        // Whichever refusal the interleaving produces, the requester reads the same message.
        if(outcomes[1].status==='rejected'){
          expect(String(outcomes[1].reason)).toMatch(/actieve job/)
          expect(String(outcomes[1].reason)).not.toMatch(/DISPATCH_MANAGED_ROW/)
        }
      } else {
        expect(outcomes[1].status).toBe('fulfilled')
        expect(outcomes[0]).toMatchObject({status:'fulfilled',value:null})
      }
    } finally { await db.$disconnect() }
  })
  // ST-1590.38 (c): the ordinary enqueue path must never hand the user the bare guard code, neither
  // from the Task row it reads nor from the Task guard raising inside PostgreSQL.
  it('refuses an ordinary enqueue for a managed Task with the active-job message', async () => {
    const input = await explicitTask(), r = await requests.submitDispatch(f.actor, input, 'task-busy')
    expect(await selection.reserveNextRequest()).toBe(r.id)
    const db = new PrismaClient({ adapter: new PrismaPg(h.web) })
    try {
      const reason = await dispatchTaskImplementation({ taskId: input.task_id, productId: input.product_id, userId: f.actor.userId }, { db, notify: async () => { } }).then(() => null, (e: unknown) => String(e))
      expect(reason).toMatch(/actieve job/)
      expect(reason).not.toMatch(/DISPATCH_MANAGED_ROW/)
      // The same message covers the refusal PostgreSQL itself raises when the managed side commits
      // mid-transaction. Measured against the real Prisma 7 driver-adapter error, not a mock.
      const raw = await db.claudeJob.create({ data: { user_id: f.actor.userId, product_id: input.product_id, task_id: input.task_id, kind: 'TASK_IMPLEMENTATION', status: 'QUEUED', source: 'COPILOT' }, select: { id: true } }).then(() => null, (e: unknown) => e)
      expect(raw).not.toBeNull()
      expect((raw as { code?: unknown }).code).toBeUndefined()
      expect(isManagedTaskRefusal(raw)).toBe(true)
      expect(isManagedTaskRefusal(new Error('DISPATCH_MANAGED_ROW'))).toBe(false)
      expect(isManagedTaskRefusal({ code: '42501', message: 'permission denied for table tasks' })).toBe(false)
    } finally { await db.$disconnect() }
  })
  it('keeps the accepted Task plan when the live plan changes', async () => {
    const input = await explicitTask(), r = await requests.submitDispatch(f.actor, input, 'task-pin')
    await h.admin.query("UPDATE tasks SET implementation_plan='new plan' WHERE id=$1", [input.task_id])
    expect(await selection.reserveNextRequest()).toBe(r.id)
    expect((await h.dispatch.query('SELECT plan_snapshot FROM claude_jobs WHERE dispatch_request_id=$1', [r.id])).rows[0].plan_snapshot).toBe('accepted plan')
  })
})

import { buildClaimPredicateFragment, evaluateClaimPredicates, requestJob } from '../../src/dispatch/eligibility.js'
it('SQL and pure named conditions agree on real managed rows across identity/scope/runtime/capability/quota cases', async () => {
  const r = await requests.submitDispatch(f.actor, f.input, 'sql-pure'); await selection.reserveNextRequest()
  const job = requestJob(f.input, f.actor.userId, 'CODEX', f.profileId, r.id)
  const executor = { userId: f.actor.userId, productIds: [f.input.product_id], runtime: 'CODEX', capabilities: [] as string[], profileRevisionIds: [f.profileId], incarnationId: f.jobSlot.incarnationId, managed: true, quotaPct: null as number | null, minQuotaPct: 10 }
  for (const patch of [{}, { userId: 'wrong' }, { productIds: ['wrong'] }, { runtime: 'CLAUDE' }, { profileRevisionIds: ['wrong'] }, { quotaPct: 1 }, { capabilities: ['deploy'] }, { capabilities: ['docs_audit'] }]) {
    const e = { ...executor, ...patch }, sql = buildClaimPredicateFragment(e)
    const found = await h.dispatch.query(`SELECT cj.id FROM claude_jobs cj JOIN queue_dispatch_candidates dc ON dc.id=cj.dispatch_candidate_id WHERE ${sql.text}`, sql.values)
    expect((found.rowCount ?? 0) > 0).toBe(evaluateClaimPredicates(job, e).length === 0)
  }
})
it.each(['repository', 'read-only', 'task-state'])('reauthorizes explicit Task %s inside create transaction', async change => {
  const input = await explicitTask(); await requests.submitDispatch(f.actor, input, 'reauth-task')
  if (change === 'repository') await h.admin.query("UPDATE tasks SET repo_url='https://forge.test/wrong.git' WHERE id=$1", [input.task_id])
  if (change === 'task-state') await h.admin.query("UPDATE tasks SET status='DONE' WHERE id=$1", [input.task_id])
  if (change === 'read-only') {
    await h.admin.query('UPDATE products SET user_id=$1 WHERE id=$2', [f.otherUser, f.input.product_id])
    await h.admin.query("INSERT INTO product_members(id,product_id,user_id,access,role,updated_at) VALUES($1,$2,$3,'READ_ONLY','DEVELOPER',now())", [crypto.randomUUID(), f.input.product_id, f.actor.userId])
  }
  expect(await selection.reserveNextRequest()).toBeNull()
  expect((await h.dispatch.query('SELECT count(*)::int AS n FROM claude_jobs WHERE task_id=$1', [input.task_id])).rows[0].n).toBe(0)
})

it('token rotation reuses host identity without detaching old reservation or incarnation evidence',async()=>{
 await h.dispatch.query('UPDATE queue_dispatch_incarnations SET busy=true WHERE id=$1',[f.jobSlot.incarnationId])
 await requests.submitDispatch(f.actor,f.input,'host-token-rotation');await selection.reserveNextRequest()
 const token=crypto.randomUUID();h.trackToken(token)
 await h.admin.query("INSERT INTO api_tokens(id,user_id,token_hash,kind,scoped_products) VALUES($1,$2,$3,'IMPLEMENTATION',$4::text[])",[token,f.actor.userId,crypto.randomUUID(),[f.input.product_id]])
 const updated=await registration.createSlot(f.actor,{action_id:'rotate-token',token_id:token,product_id:f.input.product_id,kind:'host',address:'max2:codex',capacity_key:'host:max2:codex',profile_revision_ids:[f.profileId]})
 expect(updated.id).toBe(f.hostSlot.id)
 expect((await h.dispatch.query('SELECT released_at FROM queue_dispatch_reservations WHERE slot_id=$1',[updated.id])).rows).toEqual([{released_at:null}])
 expect((await h.dispatch.query('SELECT runtime_scope FROM queue_dispatch_incarnations WHERE id=$1',[f.hostSlot.incarnationId])).rows[0].runtime_scope.supervisor_token_id).toBe(f.actor.tokenId)
})
it('registration replay rechecks revocation, and old session heartbeat cannot sign itself back in',async()=>{
 const input={registration_key:'original',slot_id:f.jobSlot.id,boot_id:'first',runtime:'CODEX' as const,image_digest:`sha256:${'a'.repeat(64)}`,profile_sha256:'a'.repeat(64)}
 const old=await registration.registerDispatchExecutor(f.actor,input)
 await registration.registerDispatchExecutor(f.actor,{...input,registration_key:'replacement',boot_id:'second'})
 await expect(registration.heartbeatExecutor(f.actor,{...old,busy:false})).rejects.toThrow('DISPATCH_FORBIDDEN')
 await h.admin.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1',[f.actor.tokenId])
 await expect(registration.registerDispatchExecutor(f.actor,input)).rejects.toThrow('DISPATCH_UNAUTHENTICATED')
})
it('a real ordinary running job consumes its stable worker slot',async()=>{
 const job=crypto.randomUUID()
 await h.admin.query("INSERT INTO claude_jobs(id,user_id,product_id,kind,status,worker_instance_id,updated_at) VALUES($1,$2,$3,'DEPLOY','RUNNING',$4,now())",[job,f.actor.userId,f.input.product_id,f.jobSlot.instanceId])
 const r=await requests.submitDispatch(f.actor,f.input,'live-job')
 await selection.reserveNextRequest()
 expect((await requests.getDispatch(f.actor,r.id)).route).toBe('host')
})
it('does not let an unsafe configuration of the other runtime block an eligible CODEX pool',async()=>{
 await h.admin.query("UPDATE products SET preferred_permission_mode='bypassPermissions' WHERE id=$1",[f.input.product_id])
 const r=await requests.submitDispatch(f.actor,f.input,'other-runtime-config')
 expect(await selection.reserveNextRequest()).toBe(r.id)
})
