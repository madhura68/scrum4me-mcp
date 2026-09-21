import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDispatchHarness, type DispatchHarness, type DispatchHarnessSeed } from './harness.js'
import { createDispatchAuth } from '../../src/dispatch/auth.js'
import { createDispatchRequests } from '../../src/dispatch/requests.js'

let h: DispatchHarness
let f: DispatchHarnessSeed
let auth: ReturnType<typeof createDispatchAuth>
let requests: ReturnType<typeof createDispatchRequests>
const token = 'dispatch-test-token'
const incoming = () => ({ authorization: `Bearer ${token}`, method: 'POST', path: '/dispatch/v1/requests', rawBody: Buffer.alloc(0), idempotencyKey: '' })
beforeEach(async () => {
  h = await makeDispatchHarness(); f = await h.seed()
  await h.admin.query('UPDATE api_tokens SET token_hash=$1 WHERE id=$2', [createHash('sha256').update(token).digest('hex'), f.actor.tokenId])
  auth = createDispatchAuth({ store: h.dispatch })
  requests = createDispatchRequests({ store: h.dispatch, auth, enabled: true, productAllowlist: [f.input.product_id] })
})
afterEach(async () => { await h?.close() })

async function member(access: 'READ_ONLY' | 'READ_WRITE') {
  await h.admin.query('UPDATE products SET user_id=$1 WHERE id=$2', [f.otherUser, f.input.product_id])
  await h.admin.query("INSERT INTO product_members(id,product_id,user_id,access,role,updated_at) VALUES($1,$2,$3,$4,'DEVELOPER',now())", [randomUUID(), f.input.product_id, f.actor.userId, access])
}
const writer = () => ({ ...f.input, requirements: { access: 'repo_write' as const, environment_keys: [], repository: { product_id: f.input.product_id, base_sha: 'a'.repeat(40) } } })

describe('current database authorization and atomic intake', () => {
  it('resolves the token hash without retaining raw token material', async () => {
    const actor = await auth.resolveDispatchActor(incoming())
    expect(actor).toEqual(f.actor)
    expect(JSON.stringify(actor)).not.toContain(token)
  })
  it.each(['revoked', 'expired', 'empty-copilot', 'unknown'])('rejects %s bearer identity', async kind => {
    if (kind === 'revoked') await h.admin.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1', [f.actor.tokenId])
    if (kind === 'expired') await h.admin.query("UPDATE api_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [f.actor.tokenId])
    if (kind === 'empty-copilot') await h.admin.query("UPDATE api_tokens SET kind='COPILOT',scoped_products='{}' WHERE id=$1", [f.actor.tokenId])
    await expect(auth.resolveDispatchActor({ ...incoming(), ...(kind === 'unknown' ? { authorization: 'Bearer bad' } : {}) })).rejects.toThrow('DISPATCH_UNAUTHENTICATED')
  })
  it('rechecks token revocation and demo after actor resolution', async () => {
    const actor = await auth.resolveDispatchActor(incoming())
    await h.admin.query('UPDATE api_tokens SET revoked_at=now() WHERE id=$1', [f.actor.tokenId])
    await expect(requests.submitDispatch(actor, f.input, 'revoked')).rejects.toThrow('DISPATCH_UNAUTHENTICATED')
    await h.admin.query('UPDATE api_tokens SET revoked_at=NULL WHERE id=$1', [f.actor.tokenId])
    await h.admin.query('UPDATE users SET is_demo=true WHERE id=$1', [actor.userId])
    await expect(requests.submitDispatch(actor, f.input, 'demo')).rejects.toThrow('DISPATCH_FORBIDDEN')
  })
  it('READ_ONLY can observe but cannot write, and a downgrade is effective immediately', async () => {
    await member('READ_ONLY')
    await expect(requests.submitDispatch(f.actor, f.input, 'read')).resolves.toMatchObject({ state: 'WAITING' })
    await expect(requests.submitDispatch(f.actor, writer(), 'write')).rejects.toThrow('DISPATCH_FORBIDDEN')
    await h.admin.query("UPDATE product_members SET access='READ_WRITE' WHERE user_id=$1", [f.actor.userId])
    await h.admin.query("UPDATE products SET repo_url='https://forge.test/repo.git' WHERE id=$1", [f.input.product_id])
    await expect(requests.submitDispatch(f.actor, writer(), 'write')).resolves.toMatchObject({ state: 'WAITING' })
    await h.admin.query("UPDATE product_members SET access='READ_ONLY' WHERE user_id=$1", [f.actor.userId])
    await expect(requests.submitDispatch(f.actor, writer(), 'write2')).rejects.toThrow('DISPATCH_FORBIDDEN')
  })
  it('denies absent membership, narrowed product/repo scope, planning writer and wrong reply address', async () => {
    await h.admin.query("UPDATE products SET repo_url='https://forge.test/repo.git' WHERE id=$1", [f.input.product_id])
    await h.admin.query("UPDATE api_tokens SET scoped_repos=ARRAY['https://forge.test/other.git'] WHERE id=$1", [f.actor.tokenId])
    await expect(requests.submitDispatch(f.actor, writer(), 'repo')).rejects.toThrow('DISPATCH_FORBIDDEN')
    await h.admin.query("UPDATE api_tokens SET scoped_repos='{}',kind='PLANNING' WHERE id=$1", [f.actor.tokenId])
    await expect(requests.submitDispatch(f.actor, writer(), 'planning')).rejects.toThrow('DISPATCH_FORBIDDEN')
    await h.admin.query("UPDATE api_tokens SET kind='IMPLEMENTATION',scoped_products=ARRAY['other'] WHERE id=$1", [f.actor.tokenId])
    await expect(requests.submitDispatch(f.actor, f.input, 'product')).rejects.toThrow('DISPATCH_FORBIDDEN')
    await h.admin.query("UPDATE api_tokens SET scoped_products='{}' WHERE id=$1", [f.actor.tokenId])
    await expect(requests.submitDispatch(f.actor, { ...f.input, reply_to: 'mac:claude' }, 'reply')).rejects.toThrow('DISPATCH_FORBIDDEN')
    await h.admin.query('UPDATE products SET user_id=$1 WHERE id=$2', [f.otherUser, f.input.product_id])
    await expect(requests.submitDispatch(f.actor, f.input, 'membership')).rejects.toThrow('DISPATCH_FORBIDDEN')
  })
  it('deduplicates 20 concurrent submissions into one request, audit and outbox without a job', async () => {
    const barrier = h.barrier(20)
    const views = await Promise.all(Array.from({ length: 20 }, async () => {
      await barrier(); return requests.submitDispatch(f.actor, f.input, 'same-request')
    }))
    expect(new Set(views.map(v => v.id)).size).toBe(1)
    for (const table of ['queue_dispatch_requests', 'queue_dispatch_events', 'queue_dispatch_outbox']) {
      expect((await h.dispatch.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(1)
    }
    expect((await h.dispatch.query('SELECT count(*)::int AS n FROM claude_jobs WHERE dispatch_request_id IS NOT NULL')).rows[0].n).toBe(0)
    await expect(requests.submitDispatch(f.actor, { ...f.input, objective: 'changed' }, 'same-request')).rejects.toThrow('DISPATCH_IDEMPOTENCY_CONFLICT')
    expect(views[0]).toMatchObject({ version: '1', route: null, state: 'WAITING' })
  })
  it('rolls back request and audit if outbox insertion fails and a retry succeeds', async () => {
    await h.admin.query("CREATE FUNCTION public.ip04_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced-before-commit'; END $$")
    await h.admin.query('CREATE TRIGGER ip04_fail_outbox BEFORE INSERT ON queue_dispatch_outbox FOR EACH ROW EXECUTE FUNCTION public.ip04_fail_outbox()')
    try {
      await expect(requests.submitDispatch(f.actor, f.input, 'retry')).rejects.toThrow('forced-before-commit')
      expect((await h.dispatch.query('SELECT count(*)::int AS n FROM queue_dispatch_requests')).rows[0].n).toBe(0)
      expect((await h.dispatch.query('SELECT count(*)::int AS n FROM queue_dispatch_events')).rows[0].n).toBe(0)
    } finally {
      await h.admin.query('DROP TRIGGER ip04_fail_outbox ON queue_dispatch_outbox')
      await h.admin.query('DROP FUNCTION public.ip04_fail_outbox()')
    }
    await expect(requests.submitDispatch(f.actor, f.input, 'retry')).resolves.toMatchObject({ state: 'WAITING' })
  })
  it('feature and product gates block intake while current authorized reads remain available', async () => {
    const view = await requests.submitDispatch(f.actor, f.input, 'read')
    const off = createDispatchRequests({ store: h.dispatch, auth, enabled: false, productAllowlist: [] })
    await expect(off.submitDispatch(f.actor, f.input, 'off')).rejects.toThrow('DISPATCH_NOT_FOUND')
    await expect(off.getDispatch(f.actor, view.id)).resolves.toEqual(view)
    await h.admin.query('UPDATE products SET user_id=$1 WHERE id=$2', [f.otherUser, f.input.product_id])
    await expect(off.getDispatch(f.actor, view.id)).rejects.toThrow('DISPATCH_NOT_FOUND')
  })
  it('keeps work_item informational without looking up or snapshotting its task', async () => {
    const view = await requests.submitDispatch(f.actor, { ...f.input, work_item: { task_id: 'does-not-exist' } }, 'label')
    expect((await h.dispatch.query('SELECT snapshot FROM queue_dispatch_requests WHERE id=$1', [view.id])).rows[0].snapshot).toEqual({})
  })
})

import { createDispatchApp, type DispatchHttpLog } from '../../src/dispatch/routes.js'
import { signDispatchAssertion } from '../../src/dispatch/assertions.js'
import { withDispatchOperation } from '../../src/dispatch/requests.js'
import { createDispatchClient } from '../../src/dispatch/client.js'

async function seedTask() {
  const pbi = randomUUID(); const story = randomUUID(); const task = randomUUID()
  await h.admin.query("UPDATE products SET repo_url='https://forge.test/repo.git' WHERE id=$1", [f.input.product_id])
  await h.admin.query("INSERT INTO pbis(id,product_id,code,title,priority,sort_order,updated_at) VALUES($1,$2,'PBI-1','PBI',1,1,now())", [pbi, f.input.product_id])
  await h.admin.query("INSERT INTO stories(id,pbi_id,product_id,code,title,acceptance_criteria,priority,sort_order,updated_at) VALUES($1,$2,$3,'ST-1','Story','pinned acceptance',1,1,now())", [story, pbi, f.input.product_id])
  await h.admin.query("INSERT INTO tasks(id,story_id,product_id,code,title,implementation_plan,priority,sort_order,updated_at) VALUES($1,$2,$3,'T-1','Task','pinned plan',1,1,now())", [task, story, f.input.product_id])
  return { ...writer(), action: 'task_implementation' as const, task_id: task, publish: 'branch' as const }
}

it('pins explicit Task plan, acceptance and base, never substitutes the later Task plan', async () => {
  const task = await seedTask()
  const view = await requests.submitDispatch(f.actor, task, 'explicit')
  await h.admin.query("UPDATE tasks SET implementation_plan='changed after intake' WHERE id=$1", [task.task_id])
  const saved = (await h.dispatch.query('SELECT snapshot FROM queue_dispatch_requests WHERE id=$1', [view.id])).rows[0].snapshot
  expect(saved).toMatchObject({ task_id: task.task_id, product_id: f.input.product_id, implementation_plan: 'pinned plan', acceptance_criteria: 'pinned acceptance', repository: { repo_url: 'https://forge.test/repo.git', base_sha: 'a'.repeat(40) } })
  await expect(requests.submitDispatch(f.actor, task, 'explicit')).resolves.toEqual(view)
  await h.admin.query("UPDATE tasks SET repo_url='https://forge.test/unregistered.git' WHERE id=$1", [task.task_id])
  await expect(requests.submitDispatch(f.actor, task, 'override')).rejects.toThrow('DISPATCH_FORBIDDEN')
})
it('rejects Task execution with wrong product, active job, active sprint execution or non-TO_DO status', async () => {
  const task = await seedTask()
  await h.admin.query("UPDATE tasks SET status='DONE' WHERE id=$1", [task.task_id])
  await expect(requests.submitDispatch(f.actor, task, 'done')).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  await h.admin.query("UPDATE tasks SET status='TO_DO' WHERE id=$1", [task.task_id])
  const job = randomUUID()
  await h.admin.query("INSERT INTO claude_jobs(id,user_id,product_id,task_id,updated_at) VALUES($1,$2,$3,$4,now())", [job, f.actor.userId, f.input.product_id, task.task_id])
  await expect(requests.submitDispatch(f.actor, task, 'active')).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  await h.admin.query("UPDATE claude_jobs SET status='DONE' WHERE id=$1", [job])
  await h.admin.query("INSERT INTO sprint_task_executions(id,sprint_job_id,task_id,\"order\",plan_snapshot,verify_required_snapshot,updated_at) VALUES($1,$2,$3,1,'plan','ALIGNED_OR_PARTIAL',now())", [randomUUID(), job, task.task_id])
  await expect(requests.submitDispatch(f.actor, task, 'sprint')).rejects.toThrow('DISPATCH_STATE_CONFLICT')
  await expect(requests.submitDispatch(f.actor, { ...task, task_id: randomUUID() }, 'missing')).rejects.toThrow('DISPATCH_FORBIDDEN')
})
it('applies exact repository scopes to Git refs but not to ProductDoc-only refs', async () => {
  await h.admin.query("UPDATE products SET repo_url='https://forge.test/repo.git' WHERE id=$1", [f.input.product_id])
  await h.admin.query("UPDATE api_tokens SET scoped_repos=ARRAY['https://forge.test/repo.git'] WHERE id=$1", [f.actor.tokenId])
  await expect(requests.submitDispatch(f.actor, writer(), 'exact')).resolves.toMatchObject({ state: 'WAITING' })
  const git = { ...f.input, action: 'review' as const, review_documents: { version: 1 as const, items: [{ key: 'spec', title: 'Spec', product_id: f.input.product_id, sha256: 'b'.repeat(64), source: 'git' as const, path: 'docs/spec.md', commit_sha: 'a'.repeat(40) }] } }
  await expect(requests.submitDispatch(f.actor, git, 'git')).resolves.toMatchObject({ state: 'WAITING' })
  await h.admin.query("UPDATE api_tokens SET scoped_repos=ARRAY['https://forge.test/repo.git/'] WHERE id=$1", [f.actor.tokenId])
  await expect(requests.submitDispatch(f.actor, git, 'not-normalized')).rejects.toThrow('DISPATCH_FORBIDDEN')
  await expect(requests.submitDispatch(f.actor, { ...git, review_documents: { version: 1, items: [{ ...git.review_documents.items[0], product_id: 'inaccessible' }] } }, 'cross-product')).rejects.toThrow('DISPATCH_FORBIDDEN')
  const document = { ...git, review_documents: { version: 1 as const, items: [{ key: 'spec', title: 'Spec', product_id: f.input.product_id, sha256: 'b'.repeat(64), source: 'product_doc' as const, doc_id: 'absent', revision_id: 'absent' }] } }
  await expect(auth.authorizeDispatch(f.actor, document, 'submit')).resolves.toBeUndefined()
  await expect(requests.submitDispatch(f.actor, document, 'missing-pin')).rejects.toThrow('DISPATCH_INVALID_INPUT')
})
it('conceals another requester from ordinary members and web issuer even when they can read the product', async () => {
  const view = await requests.submitDispatch(f.actor, f.input, 'private')
  await h.admin.query("INSERT INTO product_members(id,product_id,user_id,access,role,updated_at) VALUES($1,$2,$3,'READ_ONLY','DEVELOPER',now())", [randomUUID(), f.input.product_id, f.otherUser])
  const other = { ...f.actor, userId: f.otherUser, tokenId: null, tokenKind: null, source: 'web' as const, principalKey: `web:${f.otherUser}` }
  await expect(requests.getDispatch(other, view.id)).rejects.toThrow('DISPATCH_NOT_FOUND')
  await h.admin.query("INSERT INTO user_roles(id,user_id,role) VALUES($1,$2,'ADMIN')", [randomUUID(), f.otherUser])
  const admin = { ...other, source: 'workers' as const, principalKey: `workers:${f.otherUser}` }
  await expect(requests.getDispatch(admin, view.id)).resolves.toEqual(view)
  await h.admin.query('DELETE FROM product_members WHERE user_id=$1', [f.otherUser])
  await expect(requests.getDispatch(admin, view.id)).rejects.toThrow('DISPATCH_NOT_FOUND')
})
it('persists one redacted operation receipt and rejects a changed payload for the same operation key', async () => {
  const operation = { actor: f.actor, operation: 'register' as const, actionId: 'register', payloadHash: 'a'.repeat(64) }
  let runs = 0
  const result = await withDispatchOperation(h.dispatch, operation, async () => { runs++; return { incarnation_id: 'id', session_credential: 'secret', nested: { token: 'secret', ok: true }, profile_revision_ids: ['revision'], token_id: 'public-id' } })
  expect(result).toEqual({ incarnation_id: 'id', nested: { ok: true }, profile_revision_ids: ['revision'], token_id: 'public-id' })
  await expect(withDispatchOperation(h.dispatch, operation, async () => { runs++; return { wrong: true } })).resolves.toEqual(result)
  expect(runs).toBe(1)
  await expect(withDispatchOperation(h.dispatch, { ...operation, payloadHash: 'b'.repeat(64) }, async () => ({}))).rejects.toThrow('DISPATCH_IDEMPOTENCY_CONFLICT')
  const row = (await h.dispatch.query('SELECT operation_key,payload FROM queue_dispatch_events WHERE operation_key=$1', [`${f.actor.principalKey}:register:register`])).rows[0]
  expect(row.operation_key).toBe(`${f.actor.principalKey}:register:register`)
  expect(JSON.stringify(row.payload)).not.toContain('secret')

})
it('runs client→HTTP→real authorization→DB and authenticates exact workers bytes with redacted logging', async () => {
  const events: DispatchHttpLog[] = []
  const workersKey = Buffer.alloc(32, 9); const webKey = Buffer.alloc(32, 10)
  const app = createDispatchApp({ store: h.dispatch, enabled: true, productAllowlist: [f.input.product_id], assertionKeys: { workers: workersKey, web: webKey }, log: e => { events.push(e) } })
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/dispatch/v1`
    const client = createDispatchClient({ baseUrl: root, token })
    const view = await client.submitDispatch(f.input, 'http')
    expect(await client.getDispatch(view.id)).toEqual(view)
    await expect(client.submitDispatch({ ...f.input, objective: 'different' }, 'http')).rejects.toMatchObject({ status: 409 })
    await expect(client.submitDispatch({ ...f.input, reply_to: 'mac:claude' }, 'bad-address')).rejects.toMatchObject({ status: 403 })
    const malformed = await fetch(`${root}/requests`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' })
    expect(malformed.status).toBe(422)
    const rawBody = Buffer.from(JSON.stringify(f.input)); const path = '/dispatch/v1/requests'
    const assertion = () => signDispatchAssertion({ issuer: 'scrum4me-workers', userId: f.actor.userId, jti: randomUUID(), method: 'POST', path, rawBody, key: workersKey, idempotencyKey: 'workers' })
    const submit = (body: Buffer, signed = assertion()) => fetch(`${root}/requests`, { method: 'POST', headers: { 'X-Dispatch-Assertion': signed, 'Idempotency-Key': 'workers' }, body })
    expect((await submit(rawBody)).status).toBe(403)
    await h.admin.query("INSERT INTO user_roles(id,user_id,role) VALUES($1,$2,'ADMIN')", [randomUUID(), f.actor.userId])
    const first = await submit(rawBody); expect(first.status).toBe(200)
    const one = await first.json()
    expect(await (await submit(rawBody)).json()).toEqual(one)
    expect((await submit(Buffer.from(` ${rawBody.toString()}`))).status).toBe(401)
    // Replay defence: the same assertion presented with a fresh Idempotency-Key would previously
    // have minted a second request; the signed key must now match the header or intake refuses.
    expect((await fetch(`${root}/requests`, { method: 'POST', headers: { 'X-Dispatch-Assertion': assertion(), 'Idempotency-Key': 'replayed' }, body: rawBody })).status).toBe(401)
    const web = signDispatchAssertion({ issuer: 'scrum4me-web', userId: f.actor.userId, jti: 'web', method: 'POST', path, rawBody, key: webKey, idempotencyKey: 'workers' })
    expect((await submit(rawBody, web)).status).toBe(403)
    const readPath = `/dispatch/v1/requests/${view.id}`
    const readAssertion = signDispatchAssertion({ issuer: 'scrum4me-web', userId: f.actor.userId, jti: 'read-web', method: 'GET', path: readPath, rawBody: Buffer.alloc(0), key: webKey, idempotencyKey: '' })
    expect((await fetch(`${root}/requests/${view.id}`, { headers: { 'X-Dispatch-Assertion': readAssertion } })).status).toBe(200)
    await h.admin.query('DELETE FROM user_roles WHERE user_id=$1', [f.actor.userId])
    expect((await submit(rawBody)).status).toBe(403)
    const stored = (await h.dispatch.query('SELECT auth_source FROM queue_dispatch_requests WHERE id=$1', [view.id])).rows[0].auth_source
    expect(stored).toEqual({ source: 'bearer', user_id: f.actor.userId, token_id: f.actor.tokenId, issuer: null })
    expect(events.some(e => e.status === 409)).toBe(true)
    expect(events.every(e => Object.keys(e).sort().join(',') === 'duration_ms,operation,request_id,status')).toBe(true)
    expect(JSON.stringify(events)).not.toContain(token)
    expect(JSON.stringify(events)).not.toContain(f.input.objective)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
it('cleans the dependent Task and membership fixtures without leaving orphan rows', async () => {
  const task = await seedTask()
  await member('READ_ONLY')
  await h.admin.query("INSERT INTO user_roles(id,user_id,role) VALUES($1,$2,'ADMIN')", [randomUUID(), f.actor.userId])
  const unrelated = randomUUID()
  await h.admin.query("INSERT INTO products(id,user_id,name,definition_of_done,updated_at) VALUES($1,$2,'unrelated','test',now())", [unrelated, f.actor.userId])
  try {
    await h.reset()
    expect((await h.admin.query('SELECT 1 FROM products WHERE id=$1', [unrelated])).rowCount).toBe(1)
  } finally { await h.admin.query('DELETE FROM products WHERE id=$1', [unrelated]) }
  expect((await h.admin.query('SELECT 1 FROM tasks WHERE id=$1', [task.task_id])).rowCount).toBe(0)
  expect((await h.admin.query('SELECT 1 FROM stories WHERE product_id=$1', [f.input.product_id])).rowCount).toBe(0)
  expect((await h.admin.query('SELECT 1 FROM pbis WHERE product_id=$1', [f.input.product_id])).rowCount).toBe(0)
  expect((await h.admin.query('SELECT 1 FROM product_members WHERE product_id=$1', [f.input.product_id])).rowCount).toBe(0)
  expect((await h.admin.query('SELECT 1 FROM user_roles WHERE user_id=$1', [f.actor.userId])).rowCount).toBe(0)
})
it('retries a PostgreSQL serialization abort without retaining a partial request', async () => {
  await h.admin.query('CREATE SEQUENCE public.ip04_serialization_probe')
  await h.admin.query("CREATE FUNCTION public.ip04_serialization_abort() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN IF nextval('public.ip04_serialization_probe')=1 THEN RAISE EXCEPTION 'retryable abort' USING ERRCODE='40001'; END IF; RETURN NEW; END $$")
  await h.admin.query('CREATE TRIGGER ip04_serialization_abort BEFORE INSERT ON queue_dispatch_outbox FOR EACH ROW EXECUTE FUNCTION public.ip04_serialization_abort()')
  try {
    await expect(requests.submitDispatch(f.actor, f.input, 'serialization')).resolves.toMatchObject({ state: 'WAITING' })
    expect((await h.admin.query('SELECT last_value FROM public.ip04_serialization_probe')).rows[0].last_value).toBe('2')
    for (const table of ['queue_dispatch_requests', 'queue_dispatch_events', 'queue_dispatch_outbox']) {
      expect((await h.dispatch.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(1)
    }
    await h.admin.query("SELECT setval('public.ip04_serialization_probe',1,false)")
    await h.admin.query("CREATE OR REPLACE FUNCTION public.ip04_serialization_abort() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN PERFORM nextval('public.ip04_serialization_probe'); RAISE EXCEPTION 'persistent deadlock' USING ERRCODE='40P01'; END $$")
    await expect(requests.submitDispatch(f.actor, f.input, 'deadlock')).rejects.toMatchObject({ code: '40P01' })
    expect((await h.admin.query('SELECT last_value FROM public.ip04_serialization_probe')).rows[0].last_value).toBe('3')
    expect((await h.dispatch.query('SELECT count(*)::int AS n FROM queue_dispatch_requests')).rows[0].n).toBe(1)
  } finally {
    await h.admin.query('DROP TRIGGER ip04_serialization_abort ON queue_dispatch_outbox')
    await h.admin.query('DROP FUNCTION public.ip04_serialization_abort()')
    await h.admin.query('DROP SEQUENCE public.ip04_serialization_probe')
  }
})
it('rechecks token ownership and does not expose another requester to a plain product member', async () => {
  const view = await requests.submitDispatch(f.actor, f.input, 'owner')
  await h.admin.query('UPDATE api_tokens SET user_id=$1 WHERE id=$2', [f.otherUser, f.actor.tokenId])
  await expect(requests.getDispatch(f.actor, view.id)).rejects.toThrow('DISPATCH_UNAUTHENTICATED')
  await h.admin.query("INSERT INTO product_members(id,product_id,user_id,access,role,updated_at) VALUES($1,$2,$3,'READ_WRITE','DEVELOPER',now())", [randomUUID(), f.input.product_id, f.otherUser])
  const other = await auth.resolveDispatchActor(incoming())
  await expect(requests.getDispatch(other, view.id)).rejects.toThrow('DISPATCH_NOT_FOUND')
  await h.admin.query("UPDATE product_members SET role='PRODUCT_OWNER' WHERE user_id=$1", [f.otherUser])
  await expect(requests.getDispatch(other, view.id)).resolves.toEqual(view)
})
