import type { AttemptProof, DispatchInput, DispatchProfileConfig, DispatchResult, DispatchRuntime, DispatchView, StopEvidence } from '@shared/queue-dispatch.js'
import type { DispatchClaimReceipt, DispatchStartPermit } from './ports.js'
import { DispatchError } from './errors.js'

export type VersionAction = { action_id: string; expected_version: string }
export type WorkerObservation = { quota_pct: number | null; observed_at: string }
export type ExecutorHeartbeat = ExecutorSession & { busy: boolean; worker_observation?: WorkerObservation }
export type ExecutorSession = { incarnation_id: string; session_credential: string }
export type RegisterExecutorInput = {
  registration_key: string; slot_id: string; boot_id: string; runtime: DispatchRuntime
  image_digest: string; profile_sha256: string
}
export type ArtifactReceipt = { artifact_id: string; sha256: string; byte_size: number }
export type DispatchProfileView = { id: string; key: string; revision: number; product_id: string; config: DispatchProfileConfig; sha256: string; revoked_at: string | null }
export type DispatchSlotView = { id: string; version: string; enabled: boolean; kind: 'job' | 'host'; address: string | null; profile_revision_ids: string[] }
export type ProfileInput = { action_id: string; key: string; product_id: string; config: DispatchProfileConfig }
export type SlotInput = { action_id: string; token_id: string; product_id: string; kind: 'job' | 'host'; capacity_key: string; address: string | null; profile_revision_ids: string[] }
export type BinaryArtifact = { bytes: Uint8Array; sha256: string }
export interface DispatchClient {
  submitDispatch(input: DispatchInput, key: string): Promise<DispatchView>
  getDispatch(id: string): Promise<DispatchView>
  cancelDispatch(id: string, input: VersionAction): Promise<DispatchView>
  recoverDispatch(id: string, input: VersionAction & { evidence: StopEvidence; mode: 'close_failed' | 'close_cancelled' | 'retry_same_contract' }): Promise<DispatchView>
  putRecoveryEvidence(id: string, key: string, input: BinaryArtifact & { attempt_id: string }): Promise<ArtifactReceipt>
  registerExecutor(input: RegisterExecutorInput): Promise<ExecutorSession>
  heartbeatExecutor(input: ExecutorHeartbeat): Promise<{ live: boolean }>
  claimAttempt(input: ExecutorSession & { claim_key: string }): Promise<DispatchClaimReceipt | null>
  startAttempt(input: { proof: AttemptProof; scope_id: string; boot_id: string; image_digest: string; profile_sha256: string }): Promise<DispatchStartPermit>
  reconcileAttempt(input: { proof: AttemptProof; scope_id: string; boot_id: string; image_digest: string; profile_sha256: string }): Promise<void>
  heartbeatAttempt(input: { proof: AttemptProof; scope_id: string }): Promise<{ stopRequired: boolean }>
  submitStopEvidence(input: { proof: AttemptProof; evidence: StopEvidence }): Promise<{ receipt_id: string }>
  submitResult(input: { proof: AttemptProof; result: DispatchResult }): Promise<{ status: 'accepted' | 'late'; result_id: string | null }>
  putArtifact(key: string, input: BinaryArtifact & { proof: AttemptProof }): Promise<ArtifactReceipt>
  getArtifact(id: string, proof?: AttemptProof): Promise<BinaryArtifact>
  createProfile(input: ProfileInput): Promise<DispatchProfileView>
  revokeProfile(id: string, input: { action_id: string; reason: string }): Promise<DispatchProfileView>
  listProfiles(productId: string): Promise<{ profiles: DispatchProfileView[]; slots: DispatchSlotView[] }>
  createSlot(input: SlotInput): Promise<DispatchSlotView>
  disableSlot(id: string, input: VersionAction): Promise<DispatchSlotView>
  allowReplyAddress(input: { action_id: string; user_id: string; address: string }): Promise<{ user_id: string; address: string; enabled: boolean }>
}
export class DispatchClientError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = 'DispatchClientError' }
}
const segment = (value: string) => {
  if (!value || value === '.' || value === '..') throw new DispatchError('DISPATCH_INVALID_INPUT')
  return encodeURIComponent(value)
}
/** Transport only. Later producers/supervisors consume these existing types;
 * no import or placeholder implementation of future server handlers. */
export function createDispatchClient(config: { baseUrl: string; token: string; fetch?: typeof globalThis.fetch }): DispatchClient {
  let base: URL
  try {
    base = new URL(config.baseUrl)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
      || base.pathname.replace(/\/$/, '') !== '/dispatch/v1' || !config.token || /\s/.test(config.token)) throw new Error()
  } catch { throw new DispatchError('DISPATCH_CLIENT_CONFIG_INVALID') }
  const root = base.href.replace(/\/$/, '')
  const fetcher = config.fetch ?? globalThis.fetch
  async function send(path: string, method: string, body?: unknown, extra: Record<string, string> = {}, binary = false): Promise<Response> {
    let response: Response
    try {
      response = await fetcher(`${root}${path}`, { method, redirect: 'error',
        headers: { Authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }), ...extra },
        ...(body === undefined ? {} : { body: binary ? body as RequestInit['body'] : JSON.stringify(body) }) })
    } catch { throw new DispatchError('DISPATCH_TRANSPORT_ERROR') }
    if (!response.ok) {
      let code = 'DISPATCH_HTTP_ERROR'
      try { const value: unknown = await response.json(); if (value && typeof value === 'object' && 'error' in value
        && typeof value.error === 'string' && /^DISPATCH_[A-Z_]+$/.test(value.error)) code = value.error } catch { /* redacted error */ }
      throw new DispatchClientError(response.status, code)
    }
    return response
  }
  async function json<T>(path: string, method: string, body?: unknown, headers?: Record<string, string>, binary?: boolean): Promise<T> {
    const response = await send(path, method, body, headers, binary)
    try { return await response.json() as T } catch { throw new DispatchError('DISPATCH_TRANSPORT_ERROR') }
  }
  const requestPath = (id: string) => `/requests/${segment(id)}`
  const proofHeader = (proof: AttemptProof) => ({ 'X-Dispatch-Attempt-Proof': Buffer.from(JSON.stringify(proof)).toString('base64url') })
  return {
    submitDispatch: (input, key) => json('/requests', 'POST', input, { 'Idempotency-Key': key }),
    getDispatch: id => json(requestPath(id), 'GET'),
    cancelDispatch: (id, input) => json(`${requestPath(id)}/cancel`, 'POST', input),
    recoverDispatch: (id, input) => json(`${requestPath(id)}/recover`, 'POST', input),
    putRecoveryEvidence: (id, key, input) => json(`${requestPath(id)}/evidence/${segment(key)}`, 'PUT', input.bytes,
      { 'X-Content-SHA256': input.sha256, 'X-Dispatch-Attempt-Id': input.attempt_id }, true),
    registerExecutor: input => json('/executors/register', 'POST', input),
    heartbeatExecutor: input => json('/executors/heartbeat', 'POST', input),
    claimAttempt: input => json('/attempts/claim', 'POST', input),
    startAttempt: input => json('/attempts/start', 'POST', input),
    reconcileAttempt: async input => { await send('/attempts/reconcile', 'POST', input) },
    heartbeatAttempt: input => json('/attempts/heartbeat', 'POST', input),
    submitStopEvidence: input => json('/attempts/stop-evidence', 'POST', input),
    submitResult: input => json('/attempts/result', 'POST', input),
    putArtifact: (key, input) => json(`/attempts/artifacts/${segment(key)}`, 'PUT', input.bytes,
      { ...proofHeader(input.proof), 'X-Content-SHA256': input.sha256 }, true),
    getArtifact: async (id, proof) => {
      const response = await send(`/artifacts/${segment(id)}`, 'GET', undefined, proof ? proofHeader(proof) : {})
      const sha256 = response.headers.get('X-Content-SHA256')
      if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new DispatchError('DISPATCH_TRANSPORT_ERROR')
      return { bytes: new Uint8Array(await response.arrayBuffer()), sha256 }
    },
    createProfile: input => json('/profiles', 'POST', input),
    revokeProfile: (id, input) => json(`/profiles/${segment(id)}/revoke`, 'POST', input),
    listProfiles: productId => json(`/profiles?product_id=${encodeURIComponent(productId)}`, 'GET'),
    createSlot: input => json('/slots', 'POST', input),
    disableSlot: (id, input) => json(`/slots/${segment(id)}/disable`, 'POST', input),
    allowReplyAddress: input => json('/reply-addresses', 'POST', input),
  }
}
