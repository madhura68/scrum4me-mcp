import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDispatchHarness, type DispatchHarness, type DispatchHarnessSeed } from './harness.js'
import { assertDispatchTestUrl } from '../../scripts/dispatch-test-db.mjs'
import { createDispatchApp } from '../../src/dispatch/routes.js'
import { createDispatchClient, DispatchClientError, type DispatchClient } from '../../src/dispatch/client.js'
import { createDispatchAuth } from '../../src/dispatch/auth.js'
import { createDispatchSelection } from '../../src/dispatch/selection.js'
import { createDispatchAttempts } from '../../src/dispatch/attempts.js'
import { createDispatchSources } from '../../src/dispatch/sources.js'
import { createDispatchDelivery } from '../../src/dispatch/delivery.js'
import { createDispatchPublication, type PublicationIntent, type PublicationReceipt } from '../../src/dispatch/publication.js'
import { createDispatchTick } from '../../src/dispatch/tick.js'
import { createDispatchArtifacts, artifactHash } from '../../src/dispatch/artifacts.js'
import { applyDispatchProjection } from '../../src/dispatch/projection.js'
import type { DispatchProjection as DispatchProjectionPayload } from '@shared/queue-dispatch-projection.js'
import { createAgentGateway } from '../../src/dispatch/agent-gateway.js'
import { createAgentOutputCapabilities } from '../../src/dispatch/agent-output-capability.js'
import { isolatedGit, createCodeArtifact } from '../../src/dispatch/workspace.js'
import { canonicalRuntimeStopObservation, type RuntimeStopObservationBody } from '@shared/queue-dispatch-runtime-observation.js'
import type { DispatchInput, DispatchProfileConfig, DispatchResult } from '@shared/queue-dispatch.js'
import type { DispatchStartPermit, ExecutionContext, RuntimePort, RuntimeScope } from '../../src/dispatch/ports.js'

const TOKEN = 'ip13-end-to-end-token'
const BOOT_ID = 'ip13-boot'
const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`
const PROFILE_SHA256 = 'a'.repeat(64)

let h: DispatchHarness
let projector: Pool
const cleanups: Array<() => Promise<void>> = []
beforeEach(async () => {
  h = await makeDispatchHarness()
  projector = new Pool({ connectionString: assertDispatchTestUrl(process.env.DISPATCH_TEST_PROJECTOR_URL).href, max: 4 })
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined)
  await projector.end()
  await h.close()
})

/** Counters the fixture actually measures, so an assertion about "one model start" is a
 * measurement of the runtime port rather than a claim about the database. */
type RunCounters = {
  modelStarts: number; runtimePrepares: number; publishCalls: number; reconcileCalls: number
  canonicalResults: number; rootMessages: number; replyMessages: number
  taskUpdates: number; mergeCalls: number; deployJobs: number
  slotOccupancy: number
}

function fakeRuntime() {
  const calls = { prepare: 0, start: 0, stop: 0, inspect: 0 }
  let scope: RuntimeScope | null = null
  const port: RuntimePort = {
    async prepare(_context: ExecutionContext) {
      calls.prepare++
      scope = { scopeId: randomUUID(), bootId: BOOT_ID, imageDigest: IMAGE_DIGEST, profileSha256: PROFILE_SHA256 }
      return scope
    },
    async start(_scope: RuntimeScope, _permit: DispatchStartPermit) { calls.start++ },
    async stop(current: RuntimeScope) {
      calls.stop++
      throw new Error(`fake runtime never observes on its own: ${current.scopeId}`)
    },
    async inspect() { calls.inspect++; return 'stopped' as const },
  }
  return { port, calls, get scope() { return scope } }
}

function fakePublisher() {
  const calls = { publish: 0, reconcile: 0 }
  let outcome: PublicationReceipt['status'] = 'confirmed'
  const receipt = (intent: PublicationIntent, status: PublicationReceipt['status']): PublicationReceipt =>
    ({ operationId: intent.operationId, status, branch: intent.branch, headSha: intent.headSha, prUrl: null })
  return {
    calls,
    set outcome(value: PublicationReceipt['status']) { outcome = value },
    port: {
      publish: async (intent: PublicationIntent) => { calls.publish++; return receipt(intent, outcome) },
      reconcile: async (intent: PublicationIntent) => { calls.reconcile++; return receipt(intent, 'confirmed') },
    },
  }
}

type Service = Awaited<ReturnType<typeof startService>>
async function startService(f: DispatchHarnessSeed, options: {
  publisherPort?: ReturnType<typeof fakePublisher>['port']
  prepareRepository?: Parameters<typeof createDispatchSources>[0]['prepareRepository']
  queue?: Pool
  agentOutputKey?: Uint8Array
} = {}) {
  const auth = createDispatchAuth({ store: h.dispatch })
  const core = { store: h.dispatch, auth, enabled: true, productAllowlist: [f.input.product_id] }
  const executor = { credentialKeys: { 1: Buffer.alloc(32, 7) }, keyVersion: 1, startPermitPrivateKey: generateKeyPairSync('ed25519').privateKey, startPermitKeyId: 'permit-test' }
  const publisher = options.publisherPort
    ? createDispatchPublication({ ...core, port: options.publisherPort, loadBaseBranch: async () => 'main' })
    : undefined
  const app = createDispatchApp({ ...core, executor, publisher, ...(options.agentOutputKey ? { agentOutputKey: options.agentOutputKey } : {}) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/dispatch/v1`
  const client = createDispatchClient({ baseUrl: root, token: TOKEN })
  const sources = createDispatchSources({ ...core, fetchGit: async () => ({ ok: false, reason: 'network' as const }), prepareRepository: options.prepareRepository })
  const attempts = createDispatchAttempts({ ...core, ...executor })
  const delivery = createDispatchDelivery({ store: h.dispatch, queue: options.queue ?? projector })
  const tick = createDispatchTick({
    store: h.dispatch, selection: createDispatchSelection(core), attempts, sources, delivery, publications: publisher,
  })
  return { core, executor, client, tick, attempts, sources, publisher, artifacts: createDispatchArtifacts(core), root, server }
}

async function counters(f: DispatchHarnessSeed, requestId: string, runtime: ReturnType<typeof fakeRuntime>, publisher?: ReturnType<typeof fakePublisher>): Promise<RunCounters> {
  const one = async (sql: string, params: unknown[], pool: Pool = h.dispatch) => Number((await pool.query<{ n: string }>(sql, params)).rows[0].n)
  return {
    modelStarts: runtime.calls.start,
    runtimePrepares: runtime.calls.prepare,
    publishCalls: publisher?.calls.publish ?? 0,
    reconcileCalls: publisher?.calls.reconcile ?? 0,
    canonicalResults: await one('SELECT count(*)::text n FROM queue_dispatch_results WHERE request_id=$1', [requestId]),
    rootMessages: await one("SELECT count(*)::text n FROM agent_message WHERE dispatch_request_id=$1 AND dispatch_role='ROOT'", [requestId], h.admin),
    replyMessages: await one("SELECT count(*)::text n FROM agent_message WHERE dispatch_request_id=$1 AND dispatch_role='REPLY'", [requestId], h.admin),
    taskUpdates: await one("SELECT count(*)::text n FROM tasks WHERE product_id=$1 AND status<>'TO_DO'", [f.input.product_id], h.admin),
    mergeCalls: await one("SELECT count(*)::text n FROM claude_jobs WHERE product_id=$1 AND kind IN ('DEPLOY','PR_REVIEW','SPRINT_IMPLEMENTATION')", [f.input.product_id], h.admin),
    deployJobs: await one("SELECT count(*)::text n FROM claude_jobs WHERE product_id=$1 AND kind='DEPLOY'", [f.input.product_id], h.admin),
    slotOccupancy: await one('SELECT count(*)::text n FROM queue_dispatch_reservations WHERE released_at IS NULL', []),
  }
}

async function authorizeToken(f: DispatchHarnessSeed) {
  await h.admin.query('UPDATE api_tokens SET token_hash=$1 WHERE id=$2', [createHash('sha256').update(TOKEN).digest('hex'), f.actor.tokenId])
}
/** Replace the fixture profile with one that fits this variant. Binding a revision to a slot is
 * operator configuration; the revision itself is created through the real POST /profiles route. */
async function reprofile(f: DispatchHarnessSeed, slotId: string, patch: Partial<DispatchProfileConfig>) {
  const base = (await h.dispatch.query<{ config: DispatchProfileConfig }>('SELECT config FROM queue_dispatch_profiles WHERE id=$1', [f.profileId])).rows[0].config
  const config = { ...base, ...patch }
  const id = randomUUID()
  await h.dispatch.query(
    'INSERT INTO queue_dispatch_profiles(id,key,revision,product_id,owner_user_id,config,sha256) VALUES($1::uuid,$1::text,1,$2,$3,$4::jsonb,$5)',
    [id, f.input.product_id, f.actor.userId, JSON.stringify(config), PROFILE_SHA256])
  // Revisions are immutable and bindings are append-only for the dispatch role by design:
  // the variant profile is added next to the fixture one, never in place of it.
  await h.dispatch.query('INSERT INTO queue_dispatch_slot_profiles(slot_id,profile_revision_id) VALUES($1,$2)', [slotId, id])
  return { id, config }
}
async function useRoute(f: DispatchHarnessSeed, route: 'job' | 'host') {
  const off = route === 'job' ? f.hostSlot.id : f.jobSlot.id
  await h.dispatch.query('UPDATE queue_dispatch_slots SET enabled=false WHERE id=$1', [off])
  return route === 'job' ? f.jobSlot : f.hostSlot
}
async function useRuntime(f: DispatchHarnessSeed, slotId: string, runtime: 'CLAUDE' | 'CODEX') {
  await h.dispatch.query("UPDATE queue_dispatch_slots SET config=jsonb_set(config,'{runtime}',to_jsonb($2::text)) WHERE id=$1", [slotId, runtime])
  await h.admin.query('UPDATE claude_workers SET runtime=$2 WHERE user_id=$1', [f.actor.userId, runtime])
}
async function pinnedDocument(f: DispatchHarnessSeed) {
  const docId = randomUUID(), revisionId = randomUUID(), sha256 = artifactHash('pinned source')
  await h.admin.query("INSERT INTO product_docs(id,product_id,folder,slug,title,content_md,status,created_by,updated_at) VALUES($1,$2,'PLANS','source','Source','pinned source','active',$3,now())", [docId, f.input.product_id, f.actor.userId])
  await h.admin.query("INSERT INTO product_doc_revisions(id,doc_id,revision,title,status,content_md,content_hash,created_by) VALUES($1,$2,1,'Source','active','pinned source',$3,$4)", [revisionId, docId, sha256, f.actor.userId])
  return { version: 1 as const, items: [{ key: 'plan', title: 'Plan', source: 'product_doc' as const, product_id: f.input.product_id, doc_id: docId, revision_id: revisionId, sha256 }] }
}

/** Supervisor side of the contract, always over the real HTTP API. */
async function registerSupervisor(service: Service, slotId: string, runtime: 'CLAUDE' | 'CODEX') {
  return service.client.registerExecutor({
    registration_key: randomUUID().replaceAll('-', ''), slot_id: slotId, boot_id: BOOT_ID,
    runtime, image_digest: IMAGE_DIGEST, profile_sha256: PROFILE_SHA256,
  })
}
async function claimAndStart(service: Service, session: { incarnation_id: string; session_credential: string }, runtime: ReturnType<typeof fakeRuntime>) {
  const receipt = await service.client.claimAttempt({ ...session, claim_key: randomUUID().replaceAll('-', '') })
  if (!receipt?.context) throw new Error(`no execution authority: ${receipt?.authority ?? 'none'}`)
  const scope = await runtime.port.prepare(receipt.context)
  const permit = await service.client.startAttempt({
    proof: receipt.context.proof, scope_id: scope.scopeId, boot_id: scope.bootId,
    image_digest: scope.imageDigest, profile_sha256: scope.profileSha256,
  })
  await runtime.port.start(scope, permit)
  return { proof: receipt.context.proof, scope, context: receipt.context }
}
function stopObservation(slotId: string, proof: { request_id: string; candidate_id: string; generation: number; attempt_id: string; incarnation_id: string }, scope: RuntimeScope, status: 'created' | 'exited' = 'exited') {
  const body: RuntimeStopObservationBody = {
    version: 1, slotId, binding: { requestId: proof.request_id, candidateId: proof.candidate_id, generation: proof.generation, attemptId: proof.attempt_id, incarnationId: proof.incarnation_id, scope },
    runtimeBootId: 'vm-boot', observer: `broker:${slotId}`, observedAt: new Date().toISOString(),
    commands: [{ command: 'stop', succeeded: true }], containerId: scope.scopeId, pid: 0, running: false, status,
  }
  return { ...body, sha256: artifactHash(canonicalRuntimeStopObservation(body)) }
}
/** The agent's own read receipt: a review result is only acceptable for sources it actually read. */
async function readReviewSources(service: Service, proof: { request_id: string; candidate_id: string; generation: number; attempt_id: string; incarnation_id: string }, input: DispatchInput) {
  const capabilities = createAgentOutputCapabilities(Buffer.alloc(32, 2))
  const inputHash = (await h.dispatch.query<{ input_hash: string }>('SELECT input_hash FROM queue_dispatch_requests WHERE id=$1', [proof.request_id])).rows[0].input_hash
  const gateway = createAgentGateway({ ...service.core, capabilities })
  for (const ref of input.review_documents?.items ?? []) {
    const token = capabilities.mint({
      binding: { request_id: proof.request_id, candidate_id: proof.candidate_id, generation: proof.generation, attempt_id: proof.attempt_id, incarnation_id: proof.incarnation_id, input_sha256: inputHash, profile_sha256: PROFILE_SHA256 },
      action: input.action, access: input.requirements.access, attemptDeadlineMs: Date.now() + 60_000,
    }, Date.now())
    await gateway.readSource(token, proof.attempt_id, ref.key)
  }
}

describe('IP-13 REST matrix wiring', () => {
  it('serves every REST-matrix route instead of falling through to the not-found handler', async () => {
    const app = createDispatchApp({
      store: h.dispatch, enabled: true, productAllowlist: [],
      executor: { credentialKeys: { 1: Buffer.alloc(32, 7) }, keyVersion: 1, startPermitPrivateKey: generateKeyPairSync('ed25519').privateKey, startPermitKeyId: 'permit-test' },
    })
    const server = app.listen(0, '127.0.0.1')
    try {
      await new Promise<void>(resolve => server.once('listening', resolve))
      const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/dispatch/v1`
      const matrix: [string, string][] = [
        ['POST', '/requests'], ['GET', '/requests/id'], ['POST', '/requests/id/cancel'],
        ['POST', '/requests/id/recover'], ['PUT', '/requests/id/evidence/key'],
        ['POST', '/executors/register'], ['POST', '/executors/heartbeat'],
        ['POST', '/attempts/claim'], ['POST', '/attempts/start'], ['POST', '/attempts/reconcile'],
        ['POST', '/attempts/heartbeat'], ['POST', '/attempts/stop-evidence'], ['POST', '/attempts/result'],
        ['PUT', '/attempts/artifacts/key'], ['PUT', '/attempts/collected/report'],
        ['PUT', '/attempts/collected/code'], ['POST', '/attempts/sources/manifest'], ['GET', '/artifacts/id'],
        ['POST', '/attempts/recovery/lookup'], ['POST', '/attempts/recovery/stop'], ['POST', '/attempts/recovery/result'],
        ['POST', '/profiles'], ['POST', '/profiles/id/revoke'], ['GET', '/profiles?product_id=p'],
        ['POST', '/slots'], ['POST', '/slots/id/disable'], ['POST', '/reply-addresses'],
        ['POST', '/outbox/republish'], ['POST', '/publications/id/resolve'],
      ]
      const statuses: Record<string, number> = {}
      for (const [method, path] of matrix) {
        const response = await fetch(`${root}${path}`, { method, ...(method === 'GET' ? {} : { body: '{}' }) })
        statuses[`${method} ${path}`] = response.status
      }
      // No identity at all is 401 everywhere; a route that is not wired would answer 404.
      expect(Object.entries(statuses).filter(([, status]) => status !== 401)).toEqual([])
      expect((await fetch(`${root}/not-a-route`)).status).toBe(404)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it('refuses supervisor routes outright where the deployment holds no executor keys', async () => {
    const app = createDispatchApp({ store: h.dispatch, enabled: true, productAllowlist: [] })
    const server = app.listen(0, '127.0.0.1')
    try {
      await new Promise<void>(resolve => server.once('listening', resolve))
      const root = `http://127.0.0.1:${(server.address() as { port: number }).port}/dispatch/v1`
      const f = await h.seed(); await authorizeToken(f)
      const client = createDispatchClient({ baseUrl: root, token: TOKEN })
      await expect(client.claimAttempt({ incarnation_id: randomUUID(), session_credential: 'x', claim_key: 'k' }))
        .rejects.toMatchObject({ status: 404, code: 'DISPATCH_NOT_FOUND' })
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})

/** The supervisor's raw broker observation; staging and acceptance are one authenticated step. */
async function submitStop(service: Service, proof: unknown, observation: unknown) {
  const response = await fetch(`${service.root}/attempts/stop-evidence`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ proof, observation }),
  })
  if (!response.ok) throw new DispatchClientError(response.status, (await response.json() as { error: string }).error)
  return await response.json() as { receipt_id: string; evidence: unknown }
}

describe('end-to-end managed lifecycle over the real API, roles and projector', () => {
  it('runs a free review on the job route with one model start, one result and one reply', async () => {
    const f = await h.seed(); await authorizeToken(f)
    const documents = await pinnedDocument(f)
    const slot = await useRoute(f, 'job')
    await reprofile(f, slot.id, { runtime: 'CODEX', actions: ['review'], access: 'read', publish_modes: ['artifact'] })
    await h.dispatch.query(`UPDATE queue_dispatch_slots SET config=jsonb_set(config,'{capabilities}','["review"]') WHERE id=$1`, [slot.id])
    await h.admin.query("UPDATE claude_workers SET capabilities=ARRAY['review'] WHERE user_id=$1", [f.actor.userId])
    const service = await startService(f), runtime = fakeRuntime()
    const session = await registerSupervisor(service, slot.id, 'CODEX')
    const input: DispatchInput = { ...f.input, action: 'review', review_documents: documents }
    const submitted = await service.client.submitDispatch(input, randomUUID())
    expect(submitted.state).toBe('WAITING')
    expect((await service.tick()).reserved).toBe(1)
    expect((await service.client.getDispatch(submitted.id)).state).toBe('RESERVED')
    const { proof, scope } = await claimAndStart(service, session, runtime)
    expect((await service.client.getDispatch(submitted.id)).state).toBe('RUNNING')
    expect((await service.client.heartbeatAttempt({ proof, scope_id: scope.scopeId })).stopRequired).toBe(false)
    await readReviewSources(service, proof, input)
    await submitStop(service, proof, stopObservation(slot.id, proof, scope))
    const result: DispatchResult = {
      version: 1, outcome: 'succeeded', summary: 'Reviewed the pinned plan', report_markdown: 'GO on the pinned revision.',
      checks: [{ name: 'source', status: 'passed', evidence: 'pinned revision read through the gateway' }],
      review: { verdict: 'GO', documents },
    }
    expect(await service.client.submitResult({ proof, result })).toMatchObject({ status: 'accepted' })
    expect((await service.tick()).delivered).toBe(1)
    const run = await counters(f, submitted.id, runtime)
    expect(run.modelStarts).toBe(1)
    expect(run.canonicalResults).toBe(1)
    expect(run.rootMessages).toBe(1)
    expect(run.replyMessages).toBe(1)
    expect(run.taskUpdates).toBe(0)
    expect(run.mergeCalls).toBe(0)
    expect(run.deployJobs).toBe(0)
    expect(run.slotOccupancy).toBe(0)
    const final = await service.client.getDispatch(submitted.id)
    expect(final).toMatchObject({ state: 'SUCCEEDED', route: 'job', delivery: 'delivered' })
    expect((await h.dispatch.query("SELECT outcome FROM queue_dispatch_results WHERE request_id=$1", [submitted.id])).rows[0].outcome).toBe('SUCCEEDED')
    expect((await h.admin.query("SELECT status,kind FROM claude_jobs WHERE dispatch_request_id=$1", [submitted.id])).rows).toEqual([{ status: 'DONE', kind: 'QUEUE_REVIEW' }])
  })
})

async function repoFixture(f: DispatchHarnessSeed) {
  const root = await mkdtemp(join(tmpdir(), 'ip13-e2e-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  await mkdir(repo)
  await isolatedGit(repo, ['init', '-b', 'main'])
  await isolatedGit(repo, ['config', 'user.name', 'Fixture'])
  await isolatedGit(repo, ['config', 'user.email', 'fixture@example.invalid'])
  await writeFile(join(repo, 'file.txt'), 'base\n')
  await isolatedGit(repo, ['add', '.'])
  await isolatedGit(repo, ['commit', '-m', 'base'])
  const baseSha = await isolatedGit(repo, ['rev-parse', 'HEAD'])
  await isolatedGit(repo, ['bundle', 'create', join(root, 'base.bundle'), 'HEAD'])
  await isolatedGit(repo, ['remote', 'add', 'origin', repo])
  await h.admin.query('UPDATE products SET repo_url=$2 WHERE id=$1', [f.input.product_id, repo])
  return { root, repo, baseSha, bundle: await readFile(join(root, 'base.bundle')) }
}
async function seedTaskGraph(f: DispatchHarnessSeed) {
  const pbi = randomUUID(), story = randomUUID(), task = randomUUID()
  await h.admin.query("INSERT INTO pbis(id,product_id,code,title,priority,sort_order,updated_at) VALUES($1,$2,'PBI-1','PBI',1,1,now())", [pbi, f.input.product_id])
  await h.admin.query("INSERT INTO stories(id,pbi_id,product_id,code,title,acceptance_criteria,priority,sort_order,updated_at) VALUES($1,$2,$3,'ST-1','Story','accepted',1,1,now())", [story, pbi, f.input.product_id])
  await h.admin.query("INSERT INTO tasks(id,story_id,product_id,code,title,implementation_plan,priority,sort_order,updated_at) VALUES($1,$2,$3,'T-1','Task','Change `file.txt`',1,1,now())", [task, story, f.input.product_id])
  return { pbi, story, task }
}
/** Commit the change the agent claims to have made and hand back the exact code artifact bytes. */
async function codeArtifact(repo: string, requestId: string, baseSha: string) {
  const branch = `codex/queue-${requestId}`
  await isolatedGit(repo, ['checkout', '-b', branch])
  await writeFile(join(repo, 'file.txt'), 'changed\n')
  await isolatedGit(repo, ['commit', '-am', 'change'])
  const headSha = await isolatedGit(repo, ['rev-parse', 'HEAD'])
  const bytes = await createCodeArtifact(repo, { repoUrl: repo, baseSha, headSha, branch, checks: [] })
  return { branch, headSha, bytes, sha256: artifactHash(bytes) }
}

describe('end-to-end managed code delivery on the host route', () => {
  it.each([
    { label: 'free repo-write', action: 'free_task' as const, runtime: 'CLAUDE' as const },
    { label: 'explicit Task', action: 'task_implementation' as const, runtime: 'CODEX' as const },
  ])('delivers $label through one attempt, one publication and one reply', async variant => {
    const f = await h.seed(); await authorizeToken(f)
    const repo = await repoFixture(f)
    const graph = await seedTaskGraph(f)
    const slot = await useRoute(f, 'host')
    await useRuntime(f, slot.id, variant.runtime)
    await reprofile(f, slot.id, {
      runtime: variant.runtime, actions: [variant.action], access: 'repo_write',
      publish_modes: ['branch'], repository_product_ids: [f.input.product_id],
    })
    await h.dispatch.query(`UPDATE queue_dispatch_slots SET config=jsonb_set(jsonb_set(config,'{capabilities}','["code_edit"]'),'{runtime}',to_jsonb($2::text)) WHERE id=$1`, [slot.id, variant.runtime])
    const publisher = fakePublisher()
    const service = await startService(f, { publisherPort: publisher.port, prepareRepository: async () => ({ bytes: repo.bundle, repoUrl: repo.repo, baseSha: repo.baseSha }) })
    const runtime = fakeRuntime()
    const session = await registerSupervisor(service, slot.id, variant.runtime)
    const input: DispatchInput = {
      ...f.input, action: variant.action, publish: 'branch',
      ...(variant.action === 'task_implementation' ? { task_id: graph.task } : { work_item: { task_id: graph.task } }),
      requirements: { access: 'repo_write', environment_keys: [], repository: { product_id: f.input.product_id, base_sha: repo.baseSha } },
    }
    const submitted = await service.client.submitDispatch(input, randomUUID())
    expect((await service.tick()).reserved).toBe(1)
    const { proof, scope } = await claimAndStart(service, session, runtime)
    const code = await codeArtifact(repo.repo, submitted.id, repo.baseSha)
    const stored = await service.client.putArtifact('code', { proof, bytes: code.bytes, sha256: code.sha256 })
    expect(stored).toMatchObject({ sha256: code.sha256, byte_size: code.bytes.byteLength })
    await submitStop(service, proof, stopObservation(slot.id, proof, scope))
    const result: DispatchResult = {
      version: 1, outcome: 'succeeded', summary: 'Changed `file.txt` exactly as the plan required',
      report_markdown: 'Implementation report.', checks: [],
      code: { base_sha: repo.baseSha, head_sha: code.headSha, branch: code.branch, artifact_id: stored.artifact_id },
    }
    expect(await service.client.submitResult({ proof, result })).toMatchObject({ status: 'accepted' })
    expect((await service.tick()).delivered).toBe(1)
    const run = await counters(f, submitted.id, runtime, publisher)
    expect(run.modelStarts).toBe(1)
    expect(run.runtimePrepares).toBe(1)
    expect(run.publishCalls).toBe(1)
    expect(run.canonicalResults).toBe(1)
    expect(run.rootMessages).toBe(1)
    expect(run.replyMessages).toBe(1)
    expect(run.taskUpdates).toBe(variant.action === 'task_implementation' ? 1 : 0)
    expect(run.mergeCalls).toBe(0)
    expect(run.deployJobs).toBe(0)
    expect(run.slotOccupancy).toBe(0)
    const view = await service.client.getDispatch(submitted.id)
    expect(view).toMatchObject({ state: 'SUCCEEDED', route: 'host', delivery: 'delivered' })
    expect((await h.dispatch.query("SELECT state FROM queue_dispatch_publications WHERE request_id=$1", [submitted.id])).rows).toEqual([{ state: 'CONFIRMED' }])
    expect((await h.admin.query('SELECT status FROM tasks WHERE id=$1', [graph.task])).rows[0].status).toBe(variant.action === 'task_implementation' ? 'DONE' : 'TO_DO')
  })
})

type Scenario = Awaited<ReturnType<typeof scenario>>
async function scenario(options: { route?: 'job' | 'host'; publisher?: ReturnType<typeof fakePublisher>; documents?: boolean } = {}) {
  const f = await h.seed(); await authorizeToken(f)
  const slot = await useRoute(f, options.route ?? 'job')
  const service = await startService(f, options.publisher ? { publisherPort: options.publisher.port } : {})
  const runtime = fakeRuntime()
  const session = await registerSupervisor(service, slot.id, 'CODEX')
  const documents = options.documents ? await pinnedDocument(f) : undefined
  const input: DispatchInput = documents ? { ...f.input, action: 'review', review_documents: documents } : f.input
  if (documents) {
    await reprofile(f, slot.id, { runtime: 'CODEX', actions: ['review'], access: 'read', publish_modes: ['artifact'] })
    await h.dispatch.query(`UPDATE queue_dispatch_slots SET config=jsonb_set(config,'{capabilities}','["review"]') WHERE id=$1`, [slot.id])
    await h.admin.query("UPDATE claude_workers SET capabilities=ARRAY['review'] WHERE user_id=$1", [f.actor.userId])
  }
  const submitted = await service.client.submitDispatch(input, randomUUID())
  return { f, slot, service, runtime, session, submitted, input, documents, selection: createDispatchSelection(service.core) }
}
const openReservations = async (candidateId?: string) => Number((await h.dispatch.query<{ n: string }>(
  candidateId ? 'SELECT count(*)::text n FROM queue_dispatch_reservations WHERE released_at IS NULL AND candidate_id=$1' : 'SELECT count(*)::text n FROM queue_dispatch_reservations WHERE released_at IS NULL',
  candidateId ? [candidateId] : [])).rows[0].n)
/** The candidate deadline is immutable by design, so only a fixture may move the clock on it. */
async function expireCandidate(requestId: string) {
  const client = await h.admin.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL session_replication_role='replica'")
    await client.query("UPDATE queue_dispatch_candidates SET deadline=now()-interval '1 second' WHERE request_id=$1", [requestId])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
}
const stateOf = async (id: string) => (await h.dispatch.query<{ state: string }>('SELECT state FROM queue_dispatch_requests WHERE id=$1', [id])).rows[0].state
async function reserved(s: Scenario) {
  await s.service.sources.prepareRequestSources(s.submitted.id)
  expect(await s.selection.reserveRequest(s.submitted.id)).toBe(s.submitted.id)
}

describe('failure matrix', () => {
  it('intake transport failure before the commit leaves nothing behind; the same key then creates exactly one request', async () => {
    const f = await h.seed(); await authorizeToken(f)
    const service = await startService(f)
    const key = randomUUID()
    const broken = createDispatchClient({ baseUrl: service.root, token: TOKEN, fetch: async () => { throw new Error('transport lost before the bytes left') } })
    await expect(broken.submitDispatch(f.input, key)).rejects.toThrow('DISPATCH_TRANSPORT_ERROR')
    expect(Number((await h.dispatch.query<{ n: string }>('SELECT count(*)::text n FROM queue_dispatch_requests WHERE idempotency_key=$1', [key])).rows[0].n)).toBe(0)
    const view = await service.client.submitDispatch(f.input, key)
    expect(Number((await h.dispatch.query<{ n: string }>('SELECT count(*)::text n FROM queue_dispatch_requests WHERE idempotency_key=$1', [key])).rows[0].n)).toBe(1)
    expect(view.state).toBe('WAITING')
  })

  it('intake transport failure after the commit is recovered by the same key, not duplicated', async () => {
    const f = await h.seed(); await authorizeToken(f)
    const service = await startService(f)
    const key = randomUUID()
    let calls = 0
    const lossy = createDispatchClient({ baseUrl: service.root, token: TOKEN, fetch: async (url, init) => {
      calls++
      const response = await globalThis.fetch(url, init)
      if (calls === 1) throw new Error('response lost after the server committed')
      return response
    } })
    await expect(lossy.submitDispatch(f.input, key)).rejects.toThrow('DISPATCH_TRANSPORT_ERROR')
    const rows = (await h.dispatch.query<{ id: string }>('SELECT id FROM queue_dispatch_requests WHERE idempotency_key=$1', [key])).rows
    expect(rows).toHaveLength(1)
    expect(await lossy.submitDispatch(f.input, key)).toMatchObject({ id: rows[0].id, state: 'WAITING', version: '1' })
    expect(Number((await h.dispatch.query<{ n: string }>('SELECT count(*)::text n FROM queue_dispatch_outbox WHERE request_id=$1', [rows[0].id])).rows[0].n)).toBe(1)
  })

  it('two selectors racing the same waiting request produce one candidate and one reservation', async () => {
    const s = await scenario()
    await s.service.sources.prepareRequestSources(s.submitted.id)
    const barrier = h.barrier(2)
    const outcomes = await Promise.all([
      barrier().then(() => s.selection.reserveRequest(s.submitted.id)),
      barrier().then(() => s.selection.reserveRequest(s.submitted.id)),
    ])
    expect(outcomes.filter(Boolean)).toEqual([s.submitted.id])
    expect(Number((await h.dispatch.query<{ n: string }>('SELECT count(*)::text n FROM queue_dispatch_candidates WHERE request_id=$1', [s.submitted.id])).rows[0].n)).toBe(1)
    expect(await openReservations()).toBe(1)
    expect(s.runtime.calls.start).toBe(0)
  })

  it('a claim racing candidate retirement resolves to exactly one outcome and never both', async () => {
    const s = await scenario()
    await reserved(s)
    await expireCandidate(s.submitted.id)
    const barrier = h.barrier(2)
    const [retired, receipt] = await Promise.all([
      barrier().then(() => s.selection.retireExpiredCandidate(s.submitted.id)),
      barrier().then(() => s.service.client.claimAttempt({ ...s.session, claim_key: 'retire-race' }).catch(() => null)),
    ])
    const claimed = !!receipt?.context
    expect(retired).toBe(!claimed)
    const attempts = Number((await h.dispatch.query<{ n: string }>('SELECT count(*)::text n FROM queue_dispatch_attempts a JOIN queue_dispatch_candidates c ON c.id=a.candidate_id WHERE c.request_id=$1', [s.submitted.id])).rows[0].n)
    expect(attempts).toBe(claimed ? 1 : 0)
    expect(await stateOf(s.submitted.id)).toBe(claimed ? 'CLAIMED' : 'WAITING')
    expect(await openReservations()).toBe(claimed ? 1 : 0)
    expect(s.runtime.calls.start).toBe(0)
    expect(await counters(s.f, s.submitted.id, s.runtime)).toMatchObject({ canonicalResults: 0, rootMessages: 0, replyMessages: 0 })
  })

  it('cancel racing start never releases capacity and never starts a second model', async () => {
    const s = await scenario()
    await reserved(s)
    const receipt = await s.service.client.claimAttempt({ ...s.session, claim_key: 'cancel-race' })
    if (!receipt?.context) throw new Error('claim required')
    const proof = receipt.context.proof
    const scope = await s.runtime.port.prepare(receipt.context)
    const version = (await s.service.client.getDispatch(s.submitted.id)).version
    const barrier = h.barrier(2)
    const [cancelled, started] = await Promise.all([
      barrier().then(() => s.service.client.cancelDispatch(s.submitted.id, { action_id: 'cancel-race', expected_version: version }).catch(error => error as DispatchClientError)),
      barrier().then(() => s.service.client.startAttempt({ proof, scope_id: scope.scopeId, boot_id: scope.bootId, image_digest: scope.imageDigest, profile_sha256: scope.profileSha256 }).catch(error => error as DispatchClientError)),
    ])
    if (!(started instanceof DispatchClientError)) await s.runtime.port.start(scope, started)
    expect(s.runtime.calls.start).toBeLessThanOrEqual(1)
    // Whoever wins, cancel is terminal for authority and capacity stays held until stop evidence.
    if (!(cancelled instanceof DispatchClientError)) {
      expect(await stateOf(s.submitted.id)).toBe('CANCEL_REQUESTED')
      expect((await h.dispatch.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM queue_dispatch_attempts WHERE id=$1', [proof.attempt_id])).rows[0].revoked_at).not.toBeNull()
    }
    expect(await openReservations()).toBe(1)
    await s.service.tick()
    expect(await counters(s.f, s.submitted.id, s.runtime)).toMatchObject({ canonicalResults: 0, rootMessages: 1, replyMessages: 0, slotOccupancy: 1 })
  })

  it('a dead supervisor with a live child goes UNCERTAIN, keeps its slot and resumes the same attempt', async () => {
    const s = await scenario()
    await reserved(s)
    const { proof, scope } = await claimAndStart(s.service, s.session, s.runtime)
    await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1", [proof.attempt_id])
    expect((await s.service.tick()).uncertain).toBe(1)
    expect(await stateOf(s.submitted.id)).toBe('UNCERTAIN')
    expect(await openReservations()).toBe(1)
    expect(s.runtime.calls.start).toBe(1)
    await s.service.client.reconcileAttempt({ proof, scope_id: scope.scopeId, boot_id: scope.bootId, image_digest: scope.imageDigest, profile_sha256: scope.profileSha256 })
    expect(await stateOf(s.submitted.id)).toBe('RUNNING')
    expect(await counters(s.f, s.submitted.id, s.runtime)).toMatchObject({ modelStarts: 1, runtimePrepares: 1, canonicalResults: 0, replyMessages: 0, slotOccupancy: 1 })
  })

  it('the ordinary stale-claim reset cannot touch a managed job row', async () => {
    const s = await scenario()
    await reserved(s)
    await claimAndStart(s.service, s.session, s.runtime)
    const job = (await h.dispatch.query<{ id: string; status: string }>('SELECT id,status FROM claude_jobs WHERE dispatch_request_id=$1', [s.submitted.id])).rows[0]
    await expect(h.admin.query("UPDATE claude_jobs SET status='QUEUED',claimed_at=NULL WHERE id=$1", [job.id])).rejects.toThrow('DISPATCH_MANAGED_ROW')
    expect((await h.dispatch.query<{ status: string }>('SELECT status FROM claude_jobs WHERE id=$1', [job.id])).rows[0].status).toBe('RUNNING')
    expect(await openReservations()).toBe(1)
    expect(s.runtime.calls.start).toBe(1)
  })

  it('a host reincarnation inherits nothing: the new session cannot claim the running attempt', async () => {
    const s = await scenario({ route: 'host' })
    await reserved(s)
    const { proof } = await claimAndStart(s.service, s.session, s.runtime)
    const next = await registerSupervisor(s.service, s.slot.id, 'CODEX')
    expect(next.incarnation_id).not.toBe(s.session.incarnation_id)
    const receipt = await s.service.client.claimAttempt({ ...next, claim_key: 'reincarnated' })
    expect(receipt === null || receipt.authority === 'none').toBe(true)
    // The old session's own credential is signed off with its incarnation.
    await expect(s.service.client.heartbeatExecutor({ ...s.session, busy: true })).rejects.toMatchObject({ status: 403 })
    expect((await h.dispatch.query<{ incarnation_id: string }>('SELECT incarnation_id FROM queue_dispatch_attempts WHERE id=$1', [proof.attempt_id])).rows[0].incarnation_id).toBe(s.session.incarnation_id)
    expect(await counters(s.f, s.submitted.id, s.runtime)).toMatchObject({ modelStarts: 1, canonicalResults: 0, slotOccupancy: 1 })
  })

  it('a review source that disappears before the claim fails the request without starting a model', async () => {
    const s = await scenario({ documents: true })
    await h.admin.query('DELETE FROM product_doc_revisions WHERE id=$1', [s.documents!.items[0].revision_id])
    await s.service.tick()
    expect(await stateOf(s.submitted.id)).toBe('FAILED')
    const result = (await h.dispatch.query<{ payload: DispatchResult }>('SELECT payload FROM queue_dispatch_results WHERE request_id=$1', [s.submitted.id])).rows[0]
    expect(result.payload.summary).toMatch(/^source_/)
    await s.service.tick()
    expect(await counters(s.f, s.submitted.id, s.runtime)).toMatchObject({
      modelStarts: 0, runtimePrepares: 0, canonicalResults: 1, rootMessages: 1, replyMessages: 1, slotOccupancy: 0,
    })
  })
  it('a publication whose response is lost never produces a result and is settled by the reconciler alone', async () => {
    const f = await h.seed(); await authorizeToken(f)
    const repo = await repoFixture(f)
    const slot = await useRoute(f, 'host')
    await reprofile(f, slot.id, { runtime: 'CODEX', actions: ['free_task'], access: 'repo_write', publish_modes: ['branch'], repository_product_ids: [f.input.product_id] })
    await h.dispatch.query(`UPDATE queue_dispatch_slots SET config=jsonb_set(config,'{capabilities}','["code_edit"]') WHERE id=$1`, [slot.id])
    const publisher = fakePublisher(); publisher.outcome = 'unknown'
    const service = await startService(f, { publisherPort: publisher.port, prepareRepository: async () => ({ bytes: repo.bundle, repoUrl: repo.repo, baseSha: repo.baseSha }) })
    const runtime = fakeRuntime()
    const session = await registerSupervisor(service, slot.id, 'CODEX')
    const input: DispatchInput = { ...f.input, publish: 'branch', requirements: { access: 'repo_write', environment_keys: [], repository: { product_id: f.input.product_id, base_sha: repo.baseSha } } }
    const submitted = await service.client.submitDispatch(input, randomUUID())
    await service.tick()
    const { proof, scope } = await claimAndStart(service, session, runtime)
    const code = await codeArtifact(repo.repo, submitted.id, repo.baseSha)
    const stored = await service.client.putArtifact('code', { proof, bytes: code.bytes, sha256: code.sha256 })
    await submitStop(service, proof, stopObservation(slot.id, proof, scope))
    const result: DispatchResult = { version: 1, outcome: 'succeeded', summary: 'Implemented', report_markdown: 'Report.', checks: [], code: { base_sha: repo.baseSha, head_sha: code.headSha, branch: code.branch, artifact_id: stored.artifact_id } }
    // No canonical result exists yet, so the receipt carries none: only the reason the service
    // could not accept one. A supervisor must not turn this into a local completion.
    expect(await service.client.submitResult({ proof, result })).toEqual({ status: 'late', result_id: null, reason: 'publication_unknown' })
    expect((await h.dispatch.query("SELECT state FROM queue_dispatch_publications WHERE request_id=$1", [submitted.id])).rows).toEqual([{ state: 'UNKNOWN' }])
    expect(await counters(f, submitted.id, runtime, publisher)).toMatchObject({ modelStarts: 1, publishCalls: 1, canonicalResults: 0, replyMessages: 0, slotOccupancy: 1 })
    // Only the reconciler settles it, and it never sends a second publication.
    expect((await service.tick()).publications).toBe(1)
    expect((await h.dispatch.query("SELECT state FROM queue_dispatch_publications WHERE request_id=$1", [submitted.id])).rows).toEqual([{ state: 'CONFIRMED' }])
    expect(await service.client.submitResult({ proof, result })).toMatchObject({ status: 'accepted' })
    await service.tick()
    expect(await counters(f, submitted.id, runtime, publisher)).toMatchObject({
      modelStarts: 1, publishCalls: 1, reconcileCalls: 1, canonicalResults: 1, rootMessages: 1, replyMessages: 1, slotOccupancy: 0,
    })
  })

  it('a lost result response replays the same canonical result instead of creating a second one', async () => {
    const s = await scenario()
    await reserved(s)
    const { proof, scope } = await claimAndStart(s.service, s.session, s.runtime)
    await submitStop(s.service, proof, stopObservation(s.slot.id, proof, scope))
    const result: DispatchResult = { version: 1, outcome: 'succeeded', summary: 'Observed the pinned source', report_markdown: 'Final report.', checks: [] }
    let calls = 0
    const lossy = createDispatchClient({ baseUrl: s.service.root, token: TOKEN, fetch: async (url, init) => {
      calls++
      const response = await globalThis.fetch(url, init)
      if (calls === 1) throw new Error('result response lost in transport')
      return response
    } })
    await expect(lossy.submitResult({ proof, result })).rejects.toThrow('DISPATCH_TRANSPORT_ERROR')
    expect(await stateOf(s.submitted.id)).toBe('SUCCEEDED')
    expect(await lossy.submitResult({ proof, result })).toMatchObject({ status: 'accepted' })
    await s.service.tick()
    expect(await counters(s.f, s.submitted.id, s.runtime)).toMatchObject({
      modelStarts: 1, canonicalResults: 1, rootMessages: 1, replyMessages: 1, slotOccupancy: 0,
    })
  })

  it('a queue outage backs the projection off without touching the authoritative result', async () => {
    const s = await scenario()
    await reserved(s)
    const { proof, scope } = await claimAndStart(s.service, s.session, s.runtime)
    await submitStop(s.service, proof, stopObservation(s.slot.id, proof, scope))
    await s.service.client.submitResult({ proof, result: { version: 1, outcome: 'succeeded', summary: 'Done', report_markdown: 'Report.', checks: [] } })
    const before = (await h.dispatch.query('SELECT state,result_id,version::text v FROM queue_dispatch_requests WHERE id=$1', [s.submitted.id])).rows[0]
    const dead = new Pool({ connectionString: 'postgresql://nobody:nothing@127.0.0.1:1/s4m_dispatch_test', connectionTimeoutMillis: 500, max: 1 })
    try {
      const down = createDispatchDelivery({ store: h.dispatch, queue: dead, random: () => 0 })
      expect(await down.deliverDispatchOutbox(100)).toEqual({ delivered: 0, failed: 1 })
      expect((await h.dispatch.query('SELECT state,result_id,version::text v FROM queue_dispatch_requests WHERE id=$1', [s.submitted.id])).rows[0]).toEqual(before)
      expect(await counters(s.f, s.submitted.id, s.runtime)).toMatchObject({ canonicalResults: 1, rootMessages: 0, replyMessages: 0 })
    } finally { await dead.end() }
    await h.dispatch.query('UPDATE queue_dispatch_outbox SET next_attempt_at=now() WHERE request_id=$1', [s.submitted.id])
    expect((await s.service.tick()).delivered).toBe(1)
    expect(await counters(s.f, s.submitted.id, s.runtime)).toMatchObject({
      modelStarts: 1, canonicalResults: 1, rootMessages: 1, replyMessages: 1, slotOccupancy: 0,
    })
  })

  it('an out-of-order outbox replay never regresses the delivered root or duplicates the reply', async () => {
    const s = await scenario()
    await reserved(s)
    const { proof, scope } = await claimAndStart(s.service, s.session, s.runtime)
    await submitStop(s.service, proof, stopObservation(s.slot.id, proof, scope))
    await s.service.client.submitResult({ proof, result: { version: 1, outcome: 'succeeded', summary: 'Done', report_markdown: 'Report.', checks: [] } })
    await s.service.tick()
    const delivered = (await h.admin.query<{ version: string }>("SELECT dispatch_projection_version::text AS version FROM agent_message WHERE dispatch_request_id=$1 AND dispatch_role='ROOT'", [s.submitted.id])).rows[0].version
    // Replay every older snapshot of the same request, newest first and then backwards.
    const rows = (await h.dispatch.query<{ payload: DispatchProjectionPayload }>('SELECT payload FROM queue_dispatch_outbox WHERE request_id=$1 ORDER BY version DESC', [s.submitted.id])).rows
    const client = await projector.connect()
    try { for (const row of rows) await applyDispatchProjection(client, row.payload) } finally { client.release() }
    const after = (await h.admin.query<{ version: string }>("SELECT dispatch_projection_version::text AS version FROM agent_message WHERE dispatch_request_id=$1 AND dispatch_role='ROOT'", [s.submitted.id])).rows[0].version
    expect(after).toBe(delivered)
    expect(await counters(s.f, s.submitted.id, s.runtime)).toMatchObject({ rootMessages: 1, replyMessages: 1, canonicalResults: 1, slotOccupancy: 0 })
  })

  it('repeated recovery reads its own receipt and refuses a second authorization for the same generation', async () => {
    const s = await scenario()
    await reserved(s)
    const { proof, scope } = await claimAndStart(s.service, s.session, s.runtime)
    await h.dispatch.query("UPDATE queue_dispatch_attempts SET heartbeat_at=now()-interval '121 seconds' WHERE id=$1", [proof.attempt_id])
    expect((await s.service.tick()).uncertain).toBe(1)
    const stop = await submitStop(s.service, proof, stopObservation(s.slot.id, proof, scope))
    const evidence = stop.evidence as Parameters<DispatchClient['recoverDispatch']>[1]['evidence']
    const version = (await s.service.client.getDispatch(s.submitted.id)).version
    const action = { action_id: 'recover-once', expected_version: version, evidence, mode: 'retry_same_contract' as const }
    const first = await s.service.client.recoverDispatch(s.submitted.id, action)
    expect(first.state).toBe('WAITING')
    expect(await s.service.client.recoverDispatch(s.submitted.id, action)).toEqual(first)
    await expect(s.service.client.recoverDispatch(s.submitted.id, { ...action, action_id: 'recover-twice' })).rejects.toMatchObject({ status: 409 })
    const events = Number((await h.dispatch.query<{ n: string }>("SELECT count(*)::text n FROM queue_dispatch_events WHERE request_id=$1 AND type='retry_authorized'", [s.submitted.id])).rows[0].n)
    expect(events).toBe(1)
    await s.service.tick()
    expect(await counters(s.f, s.submitted.id, s.runtime)).toMatchObject({ modelStarts: 1, canonicalResults: 0, replyMessages: 0 })
  })
})

/** IP-13 supervisor-facing surface. Every case below drives the real HTTP routes with the
 * exact authority the domain function was written for; none of them reaches into the module. */
const AGENT_OUTPUT_KEY = Buffer.alloc(32, 2)
const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const bindingOf = (proof: { request_id: string; candidate_id: string; generation: number; attempt_id: string; incarnation_id: string }, scope: RuntimeScope) =>
  ({ requestId: proof.request_id, candidateId: proof.candidate_id, generation: proof.generation, attemptId: proof.attempt_id, incarnationId: proof.incarnation_id, scope })
async function putCollected(service: Service, binding: unknown, key: string, bytes: Uint8Array, token = TOKEN) {
  const response = await fetch(`${service.root}/attempts/collected/${key}`, {
    method: 'PUT', body: Buffer.from(bytes),
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream',
      'X-Content-SHA256': artifactHash(bytes), 'X-Dispatch-Start-Binding': base64url(binding),
    },
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}
async function recoveryCall(service: Service, path: 'lookup' | 'stop' | 'result', body: unknown) {
  const response = await fetch(`${service.root}/attempts/recovery/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}
async function agentRead(service: Service, token: string, attemptId: string, key: string) {
  const response = await fetch(`${service.root}/agent/sources/${key}`, {
    headers: { 'X-Dispatch-Agent-Token': token, 'X-Dispatch-Attempt-Id': attemptId },
  })
  return { status: response.status, text: await response.text() }
}
async function agentStage(service: Service, token: string, attemptId: string, key: string, bytes: Uint8Array, extra: Record<string, string> = {}) {
  const response = await fetch(`${service.root}/agent/outputs/${key}`, {
    method: 'PUT', body: Buffer.from(bytes),
    headers: {
      'Content-Type': 'application/octet-stream', 'X-Content-SHA256': artifactHash(bytes),
      'X-Dispatch-Agent-Token': token, 'X-Dispatch-Attempt-Id': attemptId, ...extra,
    },
  })
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> }
}
function mintAgentToken(proof: { request_id: string; candidate_id: string; generation: number; attempt_id: string; incarnation_id: string }, inputHash: string, input: DispatchInput, ms = 60_000) {
  return createAgentOutputCapabilities(AGENT_OUTPUT_KEY).mint({
    binding: { request_id: proof.request_id, candidate_id: proof.candidate_id, generation: proof.generation, attempt_id: proof.attempt_id, incarnation_id: proof.incarnation_id, input_sha256: inputHash, profile_sha256: PROFILE_SHA256 },
    action: input.action, access: input.requirements.access, attemptDeadlineMs: Date.now() + ms,
  }, Date.now())
}
const inputHashOf = async (id: string) => (await h.dispatch.query<{ input_hash: string }>('SELECT input_hash FROM queue_dispatch_requests WHERE id=$1', [id])).rows[0].input_hash
/** A second, perfectly valid bearer that simply is not the supervisor token this slot is bound to. */
async function otherSupervisorToken(f: DispatchHarnessSeed, value: string) {
  const id = randomUUID()
  await h.admin.query("INSERT INTO api_tokens(id,user_id,token_hash,kind,scoped_products) VALUES($1,$2,$3,'IMPLEMENTATION',$4::text[])",
    [id, f.otherUser, createHash('sha256').update(value).digest('hex'), [f.input.product_id]])
  h.trackToken(id)
  return value
}

describe('POST /attempts/result answers with the canonical receipt', () => {
  it('returns the domain outcome, not only an id, and replays the same canonical result', async () => {
    const f = await h.seed(); await authorizeToken(f)
    const documents = await pinnedDocument(f)
    const slot = await useRoute(f, 'job')
    await reprofile(f, slot.id, { runtime: 'CODEX', actions: ['review'], access: 'read', publish_modes: ['artifact'] })
    await h.dispatch.query(`UPDATE queue_dispatch_slots SET config=jsonb_set(config,'{capabilities}','["review"]') WHERE id=$1`, [slot.id])
    await h.admin.query("UPDATE claude_workers SET capabilities=ARRAY['review'] WHERE user_id=$1", [f.actor.userId])
    const service = await startService(f), runtime = fakeRuntime()
    const session = await registerSupervisor(service, slot.id, 'CODEX')
    const input: DispatchInput = { ...f.input, action: 'review', review_documents: documents }
    const submitted = await service.client.submitDispatch(input, randomUUID())
    expect((await service.tick()).reserved).toBe(1)
    const { proof, scope } = await claimAndStart(service, session, runtime)
    await readReviewSources(service, proof, input)
    await submitStop(service, proof, stopObservation(slot.id, proof, scope))
    const result: DispatchResult = {
      version: 1, outcome: 'succeeded', summary: 'Reviewed the pinned plan', report_markdown: 'GO on the pinned revision.',
      checks: [], review: { verdict: 'GO', documents },
    }
    const receipt = await service.client.submitResult({ proof, result })
    expect(receipt.status).toBe('accepted')
    expect(receipt.reason).toBe('succeeded')
    expect(receipt.canonical_result).toEqual(result)
    // The stored canonical payload is what the receipt carried; the supervisor never has to
    // guess which of the two the service considers authoritative.
    const stored = (await h.dispatch.query<{ payload: DispatchResult }>('SELECT payload FROM queue_dispatch_results WHERE request_id=$1', [submitted.id])).rows[0].payload
    expect(receipt.canonical_result).toEqual(stored)
    const replay = await service.client.submitResult({ proof, result })
    expect(replay).toMatchObject({ status: 'accepted', result_id: receipt.result_id, reason: 'replayed' })
    expect(replay.canonical_result).toEqual(receipt.canonical_result)
    expect(Number((await h.dispatch.query<{ n: string }>('SELECT count(*)::text n FROM queue_dispatch_results WHERE request_id=$1', [submitted.id])).rows[0].n)).toBe(1)
  })

  it('hands back the rewritten outcome when the domain refuses the submitted one', async () => {
    const f = await h.seed(); await authorizeToken(f)
    const documents = await pinnedDocument(f)
    const slot = await useRoute(f, 'job')
    await reprofile(f, slot.id, { runtime: 'CODEX', actions: ['review'], access: 'read', publish_modes: ['artifact'] })
    await h.dispatch.query(`UPDATE queue_dispatch_slots SET config=jsonb_set(config,'{capabilities}','["review"]') WHERE id=$1`, [slot.id])
    await h.admin.query("UPDATE claude_workers SET capabilities=ARRAY['review'] WHERE user_id=$1", [f.actor.userId])
    const service = await startService(f), runtime = fakeRuntime()
    const session = await registerSupervisor(service, slot.id, 'CODEX')
    const input: DispatchInput = { ...f.input, action: 'review', review_documents: documents }
    await service.client.submitDispatch(input, randomUUID())
    await service.tick()
    const { proof, scope } = await claimAndStart(service, session, runtime)
    await submitStop(service, proof, stopObservation(slot.id, proof, scope))
    // A review that never read its pinned source cannot succeed; the service rewrites the
    // outcome and the supervisor must learn that from the receipt itself.
    const receipt = await service.client.submitResult({
      proof, result: { version: 1, outcome: 'succeeded', summary: 'claimed a review', report_markdown: 'GO', checks: [] },
    })
    expect(receipt.status).toBe('accepted')
    expect(receipt.canonical_result).toMatchObject({ outcome: 'failed', summary: 'review_sources_unverified' })
  })
})

describe('the child capability gateway is reachable over its own routes', () => {
  async function capabilityFixture() {
    const f = await h.seed(); await authorizeToken(f)
    const documents = await pinnedDocument(f)
    const slot = await useRoute(f, 'job')
    await reprofile(f, slot.id, { runtime: 'CODEX', actions: ['review'], access: 'read', publish_modes: ['artifact'] })
    await h.dispatch.query(`UPDATE queue_dispatch_slots SET config=jsonb_set(config,'{capabilities}','["review"]') WHERE id=$1`, [slot.id])
    await h.admin.query("UPDATE claude_workers SET capabilities=ARRAY['review'] WHERE user_id=$1", [f.actor.userId])
    const service = await startService(f, { agentOutputKey: AGENT_OUTPUT_KEY }), runtime = fakeRuntime()
    const session = await registerSupervisor(service, slot.id, 'CODEX')
    const input: DispatchInput = { ...f.input, action: 'review', review_documents: documents }
    const submitted = await service.client.submitDispatch(input, randomUUID())
    await service.tick()
    const started = await claimAndStart(service, session, runtime)
    return { f, slot, service, runtime, session, submitted, input, documents, ...started }
  }

  it('lets the bounded child read its pinned source and stage a report, with no dispatch identity at all', async () => {
    const x = await capabilityFixture()
    const token = mintAgentToken(x.proof, await inputHashOf(x.submitted.id), x.input)
    const read = await agentRead(x.service, token, x.proof.attempt_id, 'plan')
    expect(read.status).toBe(200)
    expect(read.text).toBe('pinned source')
    const bytes = Buffer.from('# report\n')
    const staged = await agentStage(x.service, token, x.proof.attempt_id, 'report', bytes)
    expect(staged.status).toBe(200)
    expect(staged.body).toMatchObject({ sha256: artifactHash(bytes), byte_size: bytes.byteLength })
    expect((await h.dispatch.query<{ key: string }>("SELECT key FROM queue_dispatch_artifacts WHERE attempt_id=$1 AND key='report'", [x.proof.attempt_id])).rowCount).toBe(1)
  })

  it('refuses a wrong, expired, foreign or over-scoped capability and never echoes it back', async () => {
    const x = await capabilityFixture()
    const hash = await inputHashOf(x.submitted.id)
    const token = mintAgentToken(x.proof, hash, x.input)
    const wrong = await agentRead(x.service, `${token}x`, x.proof.attempt_id, 'plan')
    expect(wrong.status).toBe(403)
    expect(wrong.text).not.toContain(token.slice(0, 24))
    // A token minted for another attempt carries a binding this attempt cannot match.
    const foreign = mintAgentToken({ ...x.proof, attempt_id: randomUUID() }, hash, x.input)
    expect((await agentRead(x.service, foreign, x.proof.attempt_id, 'plan')).status).toBe(403)
    // A read-only review never receives `stage_code` in its operation set.
    expect((await agentStage(x.service, token, x.proof.attempt_id, 'code', Buffer.from('{}'))).status).toBe(403)
    // The capability is the whole authority: a bearer alongside it is a second, wider one.
    expect((await agentStage(x.service, token, x.proof.attempt_id, 'report', Buffer.from('x'), { Authorization: `Bearer ${TOKEN}` })).status).toBe(401)
    expect((await agentRead(x.service, token, x.proof.attempt_id, 'not-a-source')).status).toBe(403)
  })

  it('has no capability routes at all where the deployment holds no agent-output key', async () => {
    const f = await h.seed(); await authorizeToken(f)
    const service = await startService(f)
    expect((await agentRead(service, 'agent-output.x.y', randomUUID(), 'plan')).status).toBe(404)
  })
})

describe('post-stop collection is original-supervisor authority over its own route', () => {
  async function stoppedAttempt(options: { access?: 'read' | 'repo_write' } = {}) {
    const f = await h.seed(); await authorizeToken(f)
    const slot = await useRoute(f, 'job')
    const service = await startService(f), runtime = fakeRuntime()
    const session = await registerSupervisor(service, slot.id, 'CODEX')
    const input: DispatchInput = { ...f.input, ...(options.access ? { requirements: { ...f.input.requirements, access: options.access } } : {}) }
    const submitted = await service.client.submitDispatch(input, randomUUID())
    await service.tick()
    const { proof, scope } = await claimAndStart(service, session, runtime)
    await submitStop(service, proof, stopObservation(slot.id, proof, scope))
    return { f, slot, service, submitted, proof, scope, binding: bindingOf(proof, scope) }
  }

  it('accepts the collected report after the supervisor\'s own stop revoked the attempt', async () => {
    const x = await stoppedAttempt()
    const bytes = Buffer.from('collected after the stop\n')
    // The same bytes through the live route are refused, because this supervisor's own stop
    // revoked the attempt that route requires. That is exactly the gap this route closes.
    await expect(x.service.client.putArtifact('report', { proof: x.proof, bytes, sha256: artifactHash(bytes) })).rejects.toMatchObject({ status: 403 })
    const staged = await putCollected(x.service, x.binding, 'report', bytes)
    expect(staged.status).toBe(200)
    expect(staged.body).toMatchObject({ sha256: artifactHash(bytes), byte_size: bytes.byteLength })
    const replay = await putCollected(x.service, x.binding, 'report', bytes)
    expect(replay.body.artifact_id).toBe(staged.body.artifact_id)
    expect((await putCollected(x.service, x.binding, 'report', Buffer.from('different bytes'))).status).toBe(409)
  })

  it('refuses a foreign binding, a reserved key and a code artifact a read-only request may not carry', async () => {
    const x = await stoppedAttempt()
    const bytes = Buffer.from('collected\n')
    expect((await putCollected(x.service, { ...x.binding, scope: { ...x.scope, scopeId: randomUUID() } }, 'report', bytes)).status).toBe(409)
    expect((await putCollected(x.service, x.binding, '__operator_recovery', bytes)).status).toBe(422)
    expect((await putCollected(x.service, x.binding, 'code', bytes)).status).toBe(403)
    const other = await otherSupervisorToken(x.f, 'ip13-other-supervisor-token')
    expect((await putCollected(x.service, x.binding, 'report', bytes, other)).status).toBe(403)
  })
})

describe('non-launch recovery has a REST surface bound to its historical binding', () => {
  it('looks up, accepts a stop and accepts the historical result for a cancelled attempt', async () => {
    const f = await h.seed(); await authorizeToken(f)
    const slot = await useRoute(f, 'job')
    const service = await startService(f), runtime = fakeRuntime()
    const session = await registerSupervisor(service, slot.id, 'CODEX')
    const submitted = await service.client.submitDispatch(f.input, randomUUID())
    await service.tick()
    const { proof, scope } = await claimAndStart(service, session, runtime)
    const binding = bindingOf(proof, scope)
    const key = { requestId: proof.request_id, attemptId: proof.attempt_id, incarnationId: proof.incarnation_id, scope }
    const pending = await recoveryCall(service, 'lookup', { key })
    expect(pending.status).toBe(200)
    expect(pending.body).toEqual({ status: 'pending', binding })
    // The supervisor's own broker observation, staged and accepted through the one stop route,
    // is the evidence this recovery submits.
    const stop = await submitStop(service, proof, stopObservation(slot.id, proof, scope))
    const receipt = await recoveryCall(service, 'stop', { binding, evidence: stop.evidence })
    expect(receipt.status).toBe(200)
    expect(receipt.body.receipt_id).toBe(stop.receipt_id)
    const result: DispatchResult = { version: 1, outcome: 'failed', summary: 'the child never produced a report', report_markdown: 'No report.', checks: [] }
    const accepted = await recoveryCall(service, 'result', { binding, result })
    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({ status: 'accepted', result: { outcome: 'failed' } })
    const again = await recoveryCall(service, 'lookup', { key })
    expect(again.body).toMatchObject({ status: 'accepted', resultId: accepted.body.resultId })
    expect(await stateOf(submitted.id)).toBe('FAILED')
    expect(await openReservations()).toBe(0)
    expect(runtime.calls.start).toBe(1)
  })

  it('refuses a foreign binding, another token and an unreadable result', async () => {
    const f = await h.seed(); await authorizeToken(f)
    const slot = await useRoute(f, 'job')
    const service = await startService(f), runtime = fakeRuntime()
    const session = await registerSupervisor(service, slot.id, 'CODEX')
    await service.client.submitDispatch(f.input, randomUUID())
    await service.tick()
    const { proof, scope } = await claimAndStart(service, session, runtime)
    const binding = bindingOf(proof, scope)
    const key = { requestId: proof.request_id, attemptId: proof.attempt_id, incarnationId: proof.incarnation_id, scope }
    expect((await recoveryCall(service, 'lookup', { key: { ...key, scope: { ...scope, scopeId: randomUUID() } } })).status).toBe(409)
    expect((await recoveryCall(service, 'result', { binding, result: { version: 1, outcome: 'nonsense' } })).status).toBe(422)
    const other = await otherSupervisorToken(f, 'ip13-other-recovery-token')
    const response = await fetch(`${service.root}/attempts/recovery/lookup`, {
      method: 'POST', headers: { Authorization: `Bearer ${other}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
    })
    expect(response.status).toBe(403)
  })
})

describe('managed administration contract shared by the MCP, CLI and workers clients', () => {
  it('creates immutable revisions, revokes without overwriting, lists slot facts separately and disables on version', async () => {
    const f = await h.seed(); await authorizeToken(f)
    const service = await startService(f)
    const config = (await h.dispatch.query<{ config: DispatchProfileConfig }>('SELECT config FROM queue_dispatch_profiles WHERE id=$1', [f.profileId])).rows[0].config
    const input = { action_id: 'profile-one', key: 'ip13-profile', product_id: f.input.product_id, config }
    const created = await service.client.createProfile(input)
    expect(created).toMatchObject({ key: 'ip13-profile', revision: 1, product_id: f.input.product_id, revoked_at: null })
    expect((created as unknown as { revision_id: string }).revision_id).toBe(created.id)
    expect(created.sha256).toMatch(/^[a-f0-9]{64}$/)
    // Same action id is one action; a different body under it is a conflict, never a silent second revision.
    expect(await service.client.createProfile(input)).toEqual(created)
    await expect(service.client.createProfile({ ...input, config: { ...config, max_duration_seconds: 600 } }))
      .rejects.toMatchObject({ status: 409, code: 'DISPATCH_IDEMPOTENCY_CONFLICT' })
    const second = await service.client.createProfile({ ...input, action_id: 'profile-two', config: { ...config, max_duration_seconds: 600 } })
    expect(second.revision).toBe(2)
    expect(second.sha256).not.toBe(created.sha256)
    const revoked = await service.client.revokeProfile(created.id, { action_id: 'revoke-one', reason: 'superseded by revision 2' })
    expect(revoked.revoked_at).not.toBeNull()
    expect(revoked.config).toEqual(created.config)
    const listing = await service.client.listProfiles(f.input.product_id)
    expect(listing.profiles.filter(p => p.key === 'ip13-profile').map(p => p.revision)).toEqual([1, 2])
    const slot = listing.slots.find(row => row.id === f.jobSlot.id)
    expect(slot).toMatchObject({ kind: 'job', address: null, enabled: true, occupied: false, protocol_ready: true, isolation_verified: true, liveness: 'live' })
    expect(slot!.profile_revision_ids).toContain(f.profileId)
    const disabled = await service.client.disableSlot(f.jobSlot.id, { action_id: 'disable-one', expected_version: '1' })
    expect(disabled).toMatchObject({ id: f.jobSlot.id, enabled: false, version: '2' })
    expect((await h.dispatch.query<{ enabled: boolean }>('SELECT enabled FROM queue_dispatch_slots WHERE id=$1', [f.jobSlot.id])).rows[0].enabled).toBe(false)
    await expect(service.client.disableSlot(f.jobSlot.id, { action_id: 'disable-two', expected_version: '1' })).rejects.toMatchObject({ status: 409 })
    expect(await service.client.allowReplyAddress({ action_id: 'address-one', user_id: f.actor.userId, address: 'MAC:CODEX' }))
      .toEqual({ user_id: f.actor.userId, address: 'mac:codex', enabled: true })
    expect(Number((await h.dispatch.query<{ n: string }>('SELECT count(*)::text n FROM queue_dispatch_reply_addresses WHERE user_id=$1', [f.actor.userId])).rows[0].n)).toBe(2)
  })

  it('refuses administration from a principal without product-administrator rights', async () => {
    const f = await h.seed(); await authorizeToken(f)
    const service = await startService(f)
    await h.admin.query('UPDATE products SET user_id=$1 WHERE id=$2', [f.otherUser, f.input.product_id])
    await h.admin.query("INSERT INTO product_members(id,product_id,user_id,access,role,updated_at) VALUES($1,$2,$3,'READ_WRITE','DEVELOPER',now())", [randomUUID(), f.input.product_id, f.actor.userId])
    const config = (await h.dispatch.query<{ config: DispatchProfileConfig }>('SELECT config FROM queue_dispatch_profiles WHERE id=$1', [f.profileId])).rows[0].config
    await expect(service.client.createProfile({ action_id: 'denied', key: 'ip13-denied', product_id: f.input.product_id, config }))
      .rejects.toMatchObject({ status: 403 })
    await expect(service.client.listProfiles(f.input.product_id)).rejects.toMatchObject({ status: 403 })
    await expect(service.client.allowReplyAddress({ action_id: 'denied-address', user_id: f.otherUser, address: 'mac:codex' }))
      .rejects.toMatchObject({ status: 403 })
    expect(Number((await h.dispatch.query<{ n: string }>("SELECT count(*)::text n FROM queue_dispatch_profiles WHERE key='ip13-denied'", [])).rows[0].n)).toBe(0)
  })
})
