import { describe, expect, it } from 'vitest'
import { dispatchReplyUuid } from '../../src/dispatch/requests.js'
import { createDispatchClient } from '../../src/dispatch/client.js'

describe('dispatch transport', () => {
  it('derives the stable reply UUIDv5 from the shared DNS convention', () => {
    expect(dispatchReplyUuid('00000000-0000-4000-8000-000000000001')).toBe('a29f2284-57e2-5976-b010-ebda12509b08')
  })
  it('keeps bearer identity and idempotency in headers at the configured endpoint', async () => {
    const captured: { url: string; init?: RequestInit }[] = []
    const client = createDispatchClient({ baseUrl: 'https://dispatch.test/dispatch/v1', token: 'secret', fetch: async (url, init) => {
      captured.push({ url: String(url), init }); return new Response(JSON.stringify({ id: 'request' }), { status: 200 })
    } })
    await client.getDispatch('00000000-0000-4000-8000-000000000001')
    expect(captured[0].url).toBe('https://dispatch.test/dispatch/v1/requests/00000000-0000-4000-8000-000000000001')
    expect(captured[0].init?.method).toBe('GET')
    expect(new Headers(captured[0].init?.headers).get('Authorization')).toBe('Bearer secret')
  })
})

import type { AttemptProof, DispatchInput, DispatchProfileConfig, StopEvidence } from '@shared/queue-dispatch.js'
import { Pool } from 'pg'
import { createDispatchApp } from '../../src/dispatch/routes.js'

const input: DispatchInput = { version: 1, product_id: 'p', action: 'free_task', objective: 'read', verification: 'report',
  response_format: 'Markdown', requirements: { access: 'read', environment_keys: [] }, publish: 'artifact', reply_to: 'mac:jp' }
const proof: AttemptProof = { request_id: 'request', candidate_id: 'candidate', generation: 1, attempt_id: 'attempt', incarnation_id: 'incarnation', credential: 'attempt-secret' }
const evidence: StopEvidence = { attempt_id: 'attempt', incarnation_id: 'incarnation', scope_id: 'scope', profile_sha256: 'a'.repeat(64), observed_at: '2026-01-01T00:00:00Z', kind: 'container_stopped', artifact_id: 'artifact', sha256: 'b'.repeat(64) }
const profile: DispatchProfileConfig = { version: 1, runtime: 'CODEX', actions: ['free_task'], product_ids: ['p'], repository_product_ids: [], environment_keys: [], access: 'read', publish_modes: ['artifact'], image_digest: 'sha256:' + 'c'.repeat(64), source_mount_keys: [], provider_egress_hosts: [], cpu_millis: 1000, memory_mb: 1024, pids_limit: 128, max_duration_seconds: 300, protocol: 'dispatch-v1' }

it('implements every REST matrix transport with exact methods, body, headers and binary preservation', async () => {
  const calls: { path: string; method: string; headers: Headers; body: RequestInit['body'] }[] = []
  const client = createDispatchClient({ baseUrl: 'https://dispatch.test/dispatch/v1/', token: 'bearer-secret', fetch: async (url, init) => {
    calls.push({ path: new URL(String(url)).pathname + new URL(String(url)).search, method: init!.method!, headers: new Headers(init!.headers), body: init?.body })
    return new Response(String(url).includes('/artifacts/artifact') ? new Uint8Array([0, 255, 10]) : '{}', { headers: { 'X-Content-SHA256': 'b'.repeat(64) } })
  } })
  const version = { action_id: 'action', expected_version: '9007199254740993' }
  const session = { incarnation_id: 'incarnation', session_credential: 'session-secret' }
  const register = { registration_key: 'registration-key', slot_id: 'slot', boot_id: 'boot', runtime: 'CODEX' as const, image_digest: profile.image_digest, profile_sha256: 'a'.repeat(64) }
  const result = { version: 1 as const, outcome: 'succeeded' as const, summary: 'done', report_markdown: 'report', checks: [] }
  const bytes = new Uint8Array([0, 255, 10])
  const createSlot = { action_id: 'action', token_id: 'token-id', product_id: 'p', kind: 'host' as const, capacity_key: 'host:mac:codex', address: 'mac:codex', profile_revision_ids: ['profile'] }
  await client.submitDispatch(input, 'intake-key')
  await client.getDispatch('request')
  await client.cancelDispatch('request', version)
  await client.recoverDispatch('request', { ...version, evidence, mode: 'close_failed' })
  await client.putRecoveryEvidence('request', 'proof-key', { attempt_id: 'attempt', bytes, sha256: 'b'.repeat(64) })
  await client.registerExecutor(register)
  await client.heartbeatExecutor({ ...session, busy: true })
  await client.claimAttempt({ ...session, claim_key: 'claim' })
  await client.startAttempt({ proof, scope_id: 'scope', boot_id: 'boot', image_digest: profile.image_digest, profile_sha256: 'a'.repeat(64) })
  await client.heartbeatAttempt({ proof, scope_id: 'scope' })
  await client.submitStopEvidence({ proof, evidence })
  await client.submitResult({ proof, result })
  await client.putArtifact('code.patch', { proof, bytes, sha256: 'b'.repeat(64) })
  expect(await client.getArtifact('artifact', proof)).toEqual({ bytes, sha256: 'b'.repeat(64) })
  await client.createProfile({ action_id: 'action', key: 'profile', product_id: 'p', config: profile })
  await client.revokeProfile('profile', { action_id: 'action', reason: 'revoked' })
  await client.listProfiles('p:one')
  await client.createSlot(createSlot)
  await client.disableSlot('slot', version)
  await client.allowReplyAddress({ action_id: 'action', user_id: 'user', address: 'mac:jp' })
  expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
    'POST /dispatch/v1/requests', 'GET /dispatch/v1/requests/request', 'POST /dispatch/v1/requests/request/cancel',
    'POST /dispatch/v1/requests/request/recover', 'PUT /dispatch/v1/requests/request/evidence/proof-key',
    'POST /dispatch/v1/executors/register', 'POST /dispatch/v1/executors/heartbeat', 'POST /dispatch/v1/attempts/claim',
    'POST /dispatch/v1/attempts/start', 'POST /dispatch/v1/attempts/heartbeat', 'POST /dispatch/v1/attempts/stop-evidence',
    'POST /dispatch/v1/attempts/result', 'PUT /dispatch/v1/attempts/artifacts/code.patch', 'GET /dispatch/v1/artifacts/artifact',
    'POST /dispatch/v1/profiles', 'POST /dispatch/v1/profiles/profile/revoke', 'GET /dispatch/v1/profiles?product_id=p%3Aone',
    'POST /dispatch/v1/slots', 'POST /dispatch/v1/slots/slot/disable', 'POST /dispatch/v1/reply-addresses',
  ])
  const bodies = [input, undefined, version, { ...version, evidence, mode: 'close_failed' }, bytes, register,
    { ...session, busy: true }, { ...session, claim_key: 'claim' },
    { proof, scope_id: 'scope', boot_id: 'boot', image_digest: profile.image_digest, profile_sha256: 'a'.repeat(64) }, { proof, scope_id: 'scope' },
    { proof, evidence }, { proof, result }, bytes, undefined,
    { action_id: 'action', key: 'profile', product_id: 'p', config: profile }, { action_id: 'action', reason: 'revoked' },
    undefined, createSlot, version, { action_id: 'action', user_id: 'user', address: 'mac:jp' }]
  calls.forEach((c, index) => {
    expect(c.headers.get('Authorization')).toBe('Bearer bearer-secret')
    const binary = [4, 12].includes(index)
    expect(c.body).toEqual(binary || bodies[index] === undefined ? bodies[index] : JSON.stringify(bodies[index]))
    if (c.body !== undefined) expect(c.headers.get('Content-Type')).toBe(binary ? 'application/octet-stream' : 'application/json')
    expect(c.path).not.toContain('secret')
  })
  expect(calls[0].headers.get('Idempotency-Key')).toBe('intake-key')
  expect(calls[4].headers.get('X-Dispatch-Attempt-Id')).toBe('attempt')
  for (const index of [4, 12]) expect(calls[index].headers.get('X-Content-SHA256')).toBe('b'.repeat(64))
  for (const index of [12, 13]) expect(JSON.parse(Buffer.from(calls[index].headers.get('X-Dispatch-Attempt-Proof')!, 'base64url').toString())).toEqual(proof)
})

it('does not redirect bearer credentials or expose transport/server error bodies', async () => {
  const client = createDispatchClient({ baseUrl: 'https://dispatch.test/dispatch/v1', token: 'secret', fetch: async (_url, init) => {
    expect(init?.redirect).toBe('error')
    return new Response('{"error":"token=secret"}', { status: 403 })
  } })
  await expect(client.getDispatch('request')).rejects.toMatchObject({ status: 403, message: 'DISPATCH_HTTP_ERROR' })
  const broken = createDispatchClient({ baseUrl: 'https://dispatch.test/dispatch/v1', token: 'secret', fetch: async () => { throw new Error('dsn=secret') } })
  await expect(broken.getDispatch('request')).rejects.toThrow('DISPATCH_TRANSPORT_ERROR')
  expect(() => createDispatchClient({ baseUrl: 'https://secret@dispatch.test/dispatch/v1', token: 'secret' })).toThrow('DISPATCH_CLIENT_CONFIG_INVALID')
})

it('imports the app and entrypoint without connecting, and rejects malformed/oversized intake before DB access', async () => {
  await import('../../src/dispatch/server.js')
  const pool = new Pool({ connectionString: 'postgres://invalid:invalid@127.0.0.1:1/never_connect' })
  const app = createDispatchApp({ store: pool, enabled: false, productAllowlist: [] })
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const port = (server.address() as { port: number }).port
    const url = `http://127.0.0.1:${port}/dispatch/v1/requests`
    expect((await fetch(url, { method: 'POST', body: '{' })).status).toBe(400)
    expect((await fetch(url, { method: 'POST', body: 'a'.repeat(256 * 1024 + 1) })).status).toBe(413)
    expect((await fetch(url, { method: 'POST', body: '{}', headers: { 'Content-Encoding': 'gzip' } })).status).toBe(400)
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await fetch(url.replace('/requests', '/attempts/claim'), { method: 'POST', body: '{}' })).status).toBe(404)
    expect(pool.totalCount).toBe(0)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await pool.end() }
})

it('transports the authoritative no-authority claim receipt without inventing execution context',async()=>{
  const receipt:import('../../src/dispatch/ports.js').DispatchClaimReceipt={requestId:'request',attemptId:'attempt',requestState:'CANCEL_REQUESTED',attemptState:'CANCEL_REQUESTED',authority:'none',scopeId:'scope',context:null}
  const client=createDispatchClient({baseUrl:'https://dispatch.test/dispatch/v1',token:'secret',fetch:async()=>new Response(JSON.stringify(receipt))})
  expect(await client.claimAttempt({incarnation_id:'incarnation',session_credential:'session',claim_key:'claim'})).toEqual(receipt)
})
