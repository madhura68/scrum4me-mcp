import express, { type Express, type Request, type Response, type NextFunction, type RequestHandler } from 'express'
import { performance } from 'node:perf_hooks'
import type { KeyObject } from 'node:crypto'
import { z } from 'zod'
import { attemptProofSchema, stopEvidenceSchema, parseDispatchResult } from '@shared/queue-dispatch-validation.js'
import { dispatchStartPermitClaimsSchema } from '@shared/queue-dispatch-start-permit.js'
import { ARTIFACT_MAX_BYTES } from '@shared/queue-dispatch-sources.js'
import { createDispatchAuth } from './auth.js'
import { createDispatchHealth } from './health.js'
import type { DispatchAssertionKeys } from './assertions.js'
import type { DispatchStore } from './db.js'
import type { DispatchActor } from './ports.js'
import { createDispatchRequests } from './requests.js'
import { createDispatchCancellation } from './cancel.js'
import { createDispatchRecovery } from './recovery.js'
import { createDispatchArtifacts, artifactHash } from './artifacts.js'
import { createAgentGateway } from './agent-gateway.js'
import { signPreparedSourcesManifest } from './sources.js'
import { createAgentOutputCapabilities } from './agent-output-capability.js'
import { createDispatchCompletion, type CompletionDeps } from './completion.js'
import type { PublicationReceipt, PublicationResolution } from './publication.js'
import { createDispatchRegistration } from './registration.js'
import { createDispatchAttempts } from './attempts.js'
import { createDispatchAdministration, type OutboxRepublishInput, type ProfileCreateInput, type ProfileRevokeInput, type ReplyAddressInput, type SlotDisableInput } from './administration.js'
import type { ExecutorHeartbeat, RegisterExecutorInput, SlotInput } from './client.js'
import { DispatchError, dispatchHttpStatus } from './errors.js'
import { isQueueDispatchRequestId } from '@shared/queue-identity.js'

/** Operation names are a fixed vocabulary; they never carry an id, a path or request content. */
export type DispatchHttpOperation =
  | 'submit' | 'read' | 'cancel' | 'recover' | 'recovery_evidence'
  | 'register' | 'executor_heartbeat' | 'claim' | 'start' | 'reconcile' | 'attempt_heartbeat'
  | 'stop_evidence' | 'result' | 'put_artifact' | 'collect_artifact' | 'get_artifact'
  | 'agent_source' | 'agent_output' | 'source_manifest'
  | 'recovery_lookup' | 'recovery_stop' | 'recovery_result'
  | 'create_profile' | 'revoke_profile' | 'list_profiles' | 'create_slot' | 'disable_slot' | 'reply_address'
  | 'republish_outbox' | 'resolve_publication' | 'health'
export type DispatchHttpLog = { operation: DispatchHttpOperation; request_id: string | null; status: number; duration_ms: number }

/** Supervisor-facing routes exist only where the deployment actually holds the keys that make
 * their authority verifiable. Without them the executor/attempt routes are simply not there. */
export type DispatchExecutorKeys = {
  credentialKeys: Record<number, Uint8Array>; keyVersion: number; startPermitPrivateKey: KeyObject
}
export type DispatchAppDependencies = {
  store: DispatchStore; assertionKeys?: DispatchAssertionKeys; enabled: boolean
  productAllowlist: readonly string[]; log?: (event: DispatchHttpLog) => void
  executor?: DispatchExecutorKeys; publisher?: DispatchPublisher
  /** HMAC key for the bounded, attempt-scoped capability the child holds. Without it a
   * deployment simply has no child gateway, and no attempt is ever handed such a token. */
  agentOutputKey?: Uint8Array
  /** Whether this deployment holds a repository source producer; see `createDispatchRequests`.
   * The production entrypoint always states it, so intake can refuse what it cannot prepare. */
  repositorySources?: boolean
}
/** Completion only ever publishes; the operator resolution is an extra the configured publisher
 * brings with it, so a deployment without one simply has no resolve route. */
export type DispatchPublisher = NonNullable<CompletionDeps['publisher']> & {
  resolveUnknownPublication?(actor: DispatchActor, operationId: string, actionId: string, value: PublicationResolution): Promise<PublicationReceipt>
}

const versionAction = z.object({ action_id: z.string(), expected_version: z.string() }).strict()
const runtimeScope = z.object({
  proof: attemptProofSchema, scope_id: z.string().min(1).max(256), boot_id: z.string().min(1).max(256),
  image_digest: z.string(), profile_sha256: z.string(),
}).strict()
const sha256Header = /^[a-f0-9]{64}$/
/** The immutable identity of one historical attempt and its runtime scope, exactly as the
 * start permit pinned it. Every non-launch route below is bound to it and to nothing else. */
const startBindingSchema = dispatchStartPermitClaimsSchema.omit({ version: true, purpose: true, issuedAt: true, expiresAt: true })
const recoveryKeySchema = startBindingSchema.omit({ candidateId: true, generation: true })
/** Post-stop collection and the child's staging share one closed key vocabulary; a reserved
 * `__` control key can never be reached through either. */
const collectedKeys = { report: 'stage_report', checks: 'stage_checks', code: 'stage_code' } as const

function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new DispatchError('DISPATCH_INVALID_INPUT')
  return parsed.data
}
function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DispatchError('DISPATCH_INVALID_INPUT')
  return value as Record<string, unknown>
}
function attemptProof(req: Request) {
  const raw = req.get('X-Dispatch-Attempt-Proof')
  if (!raw) throw new DispatchError('DISPATCH_INVALID_INPUT')
  let value: unknown
  try { value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) } catch { throw new DispatchError('DISPATCH_INVALID_INPUT') }
  return parseWith(attemptProofSchema, value)
}
function contentHash(req: Request, bytes: Buffer) {
  const sha256 = req.get('X-Content-SHA256') ?? ''
  if (!sha256Header.test(sha256) || artifactHash(bytes) !== sha256) throw new DispatchError('DISPATCH_INVALID_INPUT')
  return sha256
}
function startBinding(req: Request) {
  const raw = req.get('X-Dispatch-Start-Binding')
  if (!raw) throw new DispatchError('DISPATCH_INVALID_INPUT')
  let value: unknown
  try { value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) } catch { throw new DispatchError('DISPATCH_INVALID_INPUT') }
  return parseWith(startBindingSchema, value)
}
/** The capability primitive refuses with a plain error by design; it is a crypto check, not an
 * HTTP layer. Translating it here keeps the answer a bare code and never the token or a binding. */
async function refusable<T>(work: Promise<T>): Promise<T> {
  try { return await work } catch (error) {
    if (error instanceof DispatchError) throw error
    if (error instanceof Error && error.message === 'DISPATCH_AGENT_OUTPUT_REFUSED') throw new DispatchError('DISPATCH_FORBIDDEN')
    throw error
  }
}
const scopeOf = (input: z.infer<typeof runtimeScope>) => ({
  scopeId: input.scope_id, bootId: input.boot_id, imageDigest: input.image_digest, profileSha256: input.profile_sha256,
})

export function createDispatchApp(deps: DispatchAppDependencies): Express {
  const app = express(); app.disable('x-powered-by')
  const auth = createDispatchAuth(deps)
  const core = { ...deps, auth }
  const requests = createDispatchRequests(core)
  const cancellation = createDispatchCancellation(core)
  const recovery = createDispatchRecovery(core)
  const artifacts = createDispatchArtifacts(core)
  const completion = createDispatchCompletion(core)
  const administration = createDispatchAdministration(core)
  const publisher = deps.publisher
  const registration = deps.executor ? createDispatchRegistration({ ...core, ...deps.executor }) : null
  const health = createDispatchHealth({ store: deps.store })
  const attempts = deps.executor ? createDispatchAttempts({ ...core, ...deps.executor }) : null
  const capabilities = deps.agentOutputKey ? createAgentOutputCapabilities(deps.agentOutputKey) : null
  const gateway = capabilities ? createAgentGateway({ store: deps.store, auth, capabilities }) : null

  type Context = { actor: DispatchActor; req: Request; res: Response; raw: Buffer; json: () => unknown }
  type Handler = (ctx: Context) => Promise<unknown>
  // Bytes are captured before JSON parsing so an assertion authenticates what actually arrived;
  // compression is refused outright rather than authenticating decompressed bytes.
  const raw = (limit: number): RequestHandler => express.raw({ type: () => true, limit, inflate: false })

  function handle(fn: Handler, decode: boolean) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
        // Unreadable bytes are answered before authentication, exactly as intake always did:
        // a malformed envelope is not an authorization question and never reaches the database.
        let decoded: unknown
        if (decode) {
          try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
          catch { throw new DispatchError('DISPATCH_BAD_JSON') }
        }
        const actor = await auth.resolveDispatchActor({
          authorization: req.get('Authorization'), assertion: req.get('X-Dispatch-Assertion'),
          method: req.method, path: req.originalUrl, rawBody: bytes,
          // Bound into the assertion's signed bytes: submit signs its real key, every other route
          // signs (and is checked against) the empty string its absent header decodes to.
          idempotencyKey: req.get('Idempotency-Key') ?? '',
        })
        const value = await fn({
          actor, req, res, raw: bytes,
          json: () => { if (!decode) throw new DispatchError('DISPATCH_BAD_JSON'); return decoded },
        })
        if (res.headersSent) return
        if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && isQueueDispatchRequestId(value.id)) res.locals.dispatchRequestId = value.id
        // `null` is a real answer — "no work for you" on a claim — so only an absent value
        // becomes an empty object. Collapsing null here would hand the client a receipt shape.
        res.status(200).json(value === undefined ? {} : value)
      } catch (error) { next(error) }
    }
  }
  function log(operation: DispatchHttpOperation): RequestHandler {
    return (req, res, next) => {
      const start = performance.now()
      res.on('finish', () => {
        const id = res.locals.dispatchRequestId ?? req.params.id
        try {
          deps.log?.({ operation, request_id: typeof id === 'string' && isQueueDispatchRequestId(id) ? id : null,
            status: res.statusCode, duration_ms: Math.round(performance.now() - start) })
        } catch { /* Logging cannot fail an action. */ }
      })
      next()
    }
  }
  /** A route whose service is not configured on this deployment is absent, not broken. */
  const unavailable: Handler = async () => { throw new DispatchError('DISPATCH_NOT_FOUND') }
  // Only the opaque artifact upload and the read routes carry no JSON envelope of their own.
  const opaque: DispatchHttpOperation[] = ['put_artifact', 'collect_artifact']
  const register = (method: 'post' | 'get' | 'put', path: string, operation: DispatchHttpOperation, limit: number, fn: Handler) =>
    app[method](`/dispatch/v1${path}`, log(operation), raw(limit), handle(fn, method !== 'get' && !opaque.includes(operation)))
  const json = 256 * 1024

  /** The child holds exactly one bounded, attempt-scoped capability and no dispatch identity:
   * not a bearer, not an assertion, not a supervisor proof. So these two routes resolve no
   * actor at all — the capability plus the gateway's own fresh database authority is the whole
   * authorization, exactly as `createAgentGateway` prescribes. A bearer presented alongside it
   * would be a second and far wider authority, so it is refused rather than ignored. */
  type CapabilityContext = { req: Request; res: Response; raw: Buffer; token: string; attemptId: string }
  function capabilityRoute(method: 'get' | 'put', path: string, operation: DispatchHttpOperation, limit: number,
    fn: (ctx: CapabilityContext) => Promise<unknown>) {
    const handler: RequestHandler = async (req, res, next) => {
      try {
        if (!gateway) throw new DispatchError('DISPATCH_NOT_FOUND')
        if (req.get('Authorization') || req.get('X-Dispatch-Assertion')) throw new DispatchError('DISPATCH_UNAUTHENTICATED')
        const token = req.get('X-Dispatch-Agent-Token') ?? ''
        const attemptId = req.get('X-Dispatch-Attempt-Id') ?? ''
        if (!token || !isQueueDispatchRequestId(attemptId)) throw new DispatchError('DISPATCH_UNAUTHENTICATED')
        const value = await fn({ req, res, raw: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), token, attemptId })
        if (res.headersSent) return
        res.status(200).json(value === undefined ? {} : value)
      } catch (error) { next(error) }
    }
    app[method](`/dispatch/v1${path}`, log(operation), raw(limit), handler)
  }
  /** Minted from the attempt the service itself just put into RUNNING, never from caller input,
   * and bounded by that attempt's own deadline. The supervisor is the only party between the
   * service and the child, so it carries the token across — it can do nothing else with it. */
  async function agentToken(proof: z.infer<typeof attemptProofSchema>, profileSha256: string): Promise<string | null> {
    if (!capabilities) return null
    try {
      const row = (await deps.store.query<{ input_hash: string; action: string; access: string; deadline: Date | null }>(
        `SELECT r.input_hash,r.input->>'action' AS action,r.input->'requirements'->>'access' AS access,
          a.started_at+make_interval(secs=>(p.config->>'max_duration_seconds')::int) AS deadline
         FROM queue_dispatch_attempts a
         JOIN queue_dispatch_candidates c ON c.id=a.candidate_id
         JOIN queue_dispatch_requests r ON r.id=c.request_id
         JOIN queue_dispatch_profiles p ON p.id=c.profile_revision_id
         WHERE a.id=$1 AND a.started_at IS NOT NULL`, [proof.attempt_id])).rows[0]
      if (!row?.deadline) return null
      return capabilities.mint({
        binding: {
          request_id: proof.request_id, candidate_id: proof.candidate_id, generation: proof.generation,
          attempt_id: proof.attempt_id, incarnation_id: proof.incarnation_id,
          input_sha256: row.input_hash, profile_sha256: profileSha256,
        },
        action: row.action as 'free_task' | 'review' | 'task_implementation',
        access: row.access as 'read' | 'repo_write',
        attemptDeadlineMs: row.deadline.getTime(),
      }, Date.now())
    } catch { return null }
  }

  /** Readiness. Unauthenticated on purpose — an orchestrator has no dispatch identity — and for
   * that reason side-effect free, cached for a probe window and limited to build facts. It is
   * outside `/dispatch/v1`: it is not part of the versioned protocol surface. */
  app.get('/healthz', log('health'), async (_req, res, next) => {
    try { res.status(200).json(await health.readiness()) } catch (error) { next(error) }
  })

  register('post', '/requests', 'submit', json, ({ actor, req, json: read }) =>
    requests.submitDispatch(actor, read(), req.get('Idempotency-Key') ?? ''))
  register('get', '/requests/:id', 'read', json, ({ actor, req }) => requests.getDispatch(actor, req.params.id))
  register('post', '/requests/:id/cancel', 'cancel', json, ({ actor, req, json: read }) => {
    const input = parseWith(versionAction, read())
    return cancellation.cancelDispatch(actor, req.params.id, input.action_id, input.expected_version)
  })
  register('post', '/requests/:id/recover', 'recover', json, ({ actor, req, json: read }) => {
    const input = parseWith(versionAction.extend({
      evidence: stopEvidenceSchema, mode: z.enum(['close_failed', 'close_cancelled', 'retry_same_contract']),
    }).strict(), read())
    return recovery.recoverDispatch(actor, req.params.id, input.action_id, input.expected_version, input.evidence, input.mode)
  })
  // The operator attestation is uploaded as its own exact bytes; the service re-derives the
  // canonical form and refuses anything whose hash or binding does not match.
  register('put', '/requests/:id/evidence/:key', 'recovery_evidence', ARTIFACT_MAX_BYTES, async ({ actor, req, raw: bytes, json: read }) => {
    contentHash(req, bytes)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(req.params.key)) throw new DispatchError('DISPATCH_INVALID_INPUT')
    const attemptId = req.get('X-Dispatch-Attempt-Id') ?? ''
    const attestation = body(read()) as Parameters<typeof recovery.stageRecoveryEvidence>[1]
    if (!isQueueDispatchRequestId(attemptId) || attestation.binding?.attemptId !== attemptId
      || attestation.binding?.requestId !== req.params.id) throw new DispatchError('DISPATCH_INVALID_INPUT')
    let evidence
    try { evidence = await recovery.stageRecoveryEvidence(actor, attestation) } catch (error) {
      if (error instanceof z.ZodError) throw new DispatchError('DISPATCH_INVALID_INPUT')
      throw error
    }
    return { artifact_id: evidence.artifact_id, sha256: evidence.sha256, byte_size: bytes.byteLength }
  })
  register('post', '/executors/register', 'register', json, registration
    ? ({ actor, json: read }) => registration.registerDispatchExecutor(actor, body(read()) as unknown as RegisterExecutorInput) : unavailable)
  register('post', '/executors/heartbeat', 'executor_heartbeat', json, registration
    ? ({ actor, json: read }) => registration.heartbeatExecutor(actor, body(read()) as unknown as ExecutorHeartbeat) : unavailable)
  register('post', '/attempts/claim', 'claim', json, attempts
    ? ({ actor, json: read }) => {
      const input = parseWith(z.object({ incarnation_id: z.string().min(1), session_credential: z.string().min(1), claim_key: z.string() }).strict(), read())
      return attempts.claimDispatchAttempt(actor, input.incarnation_id, input.claim_key, input.session_credential)
    } : unavailable)
  // The permit is the shared contract and never changes shape. Where a deployment runs a child
  // gateway, the same answer additively carries the child's own bounded capability, because the
  // supervisor is the only party that can hand it on before it starts the container.
  register('post', '/attempts/start', 'start', json, attempts
    ? async ({ actor, json: read }) => {
      const input = parseWith(runtimeScope, read())
      const permit = await attempts.startDispatchAttempt(actor, input.proof, scopeOf(input))
      const token = await agentToken(input.proof, input.profile_sha256)
      return token ? { ...permit, agent_token: token } : permit
    }
    : unavailable)
  register('post', '/attempts/reconcile', 'reconcile', json, attempts
    ? async ({ actor, json: read }) => { const input = parseWith(runtimeScope, read()); await attempts.reconcileDispatchAttempt(actor, input.proof, scopeOf(input)); return {} }
    : unavailable)
  register('post', '/attempts/heartbeat', 'attempt_heartbeat', json, attempts
    ? ({ actor, json: read }) => {
      const input = parseWith(z.object({ proof: attemptProofSchema, scope_id: z.string() }).strict(), read())
      return attempts.renewDispatchAttempt(actor, input.proof, input.scope_id)
    } : unavailable)
  // Two shapes, one meaning. A supervisor that already staged its observation submits the
  // resulting StopEvidence; one that has only the broker's raw observation submits that instead
  // and the service stages it under the reserved control key first. The observation cannot be
  // uploaded through PUT /attempts/artifacts, which refuses reserved `__` keys by design.
  register('post', '/attempts/stop-evidence', 'stop_evidence', json, async ({ actor, json: read }) => {
    const input = parseWith(z.union([
      z.object({ proof: attemptProofSchema, evidence: stopEvidenceSchema }).strict(),
      z.object({ proof: attemptProofSchema, observation: z.unknown() }).strict(),
    ]), read())
    const evidence = 'evidence' in input ? input.evidence
      : await artifacts.stageSupervisorStop(actor, input.observation as Parameters<typeof artifacts.stageSupervisorStop>[1])
    return { ...await completion.submitStop(actor, input.proof, evidence), evidence }
  })
  register('post', '/attempts/result', 'result', json, async ({ actor, json: read }) => {
    const input = parseWith(z.object({ proof: attemptProofSchema, result: z.unknown() }).strict(), read())
    let result
    try { result = parseDispatchResult(input.result) } catch { throw new DispatchError('DISPATCH_INVALID_INPUT') }
    const receipt = await completion.acceptDispatchResult(actor, input.proof, result)
    // The canonical result travels with the receipt. `acceptDispatchResult` may rewrite the
    // submitted outcome to failed or cancelled, so an id alone would leave the supervisor
    // guessing what the service actually accepted. Existing readers of `status`/`result_id`
    // are untouched, and a replay of the same result answers with the same canonical bytes.
    return {
      status: receipt.accepted ? 'accepted' : 'late', result_id: receipt.resultId, reason: receipt.reason,
      ...(receipt.result ? { canonical_result: receipt.result } : {}),
    }
  })
  register('put', '/attempts/artifacts/:key', 'put_artifact', ARTIFACT_MAX_BYTES, async ({ actor, req, raw: bytes }) => {
    const sha256 = contentHash(req, bytes)
    const artifactId = await artifacts.storeAttemptArtifact(actor, attemptProof(req), req.params.key, bytes, sha256)
    return { artifact_id: artifactId, sha256, byte_size: bytes.byteLength }
  })
  // Post-stop collection. The stop this very supervisor submitted revoked its own attempt, so
  // `PUT /attempts/artifacts/:key` refuses the child's output afterwards by design. This is the
  // route `stageCollectedArtifact` was written for: original-supervisor authority, proved by the
  // historical binding instead of a live attempt proof, and never a child capability.
  register('put', '/attempts/collected/:key', 'collect_artifact', ARTIFACT_MAX_BYTES, async ({ actor, req, raw: bytes }) => {
    const key = req.params.key as keyof typeof collectedKeys
    if (!Object.hasOwn(collectedKeys, key)) throw new DispatchError('DISPATCH_INVALID_INPUT')
    const sha256 = contentHash(req, bytes)
    const artifactId = await artifacts.stageCollectedArtifact(actor, startBinding(req), key, bytes, sha256)
    return { artifact_id: artifactId, sha256, byte_size: bytes.byteLength }
  })
  // Non-launch recovery. Same authenticated original supervisor, same historical binding, but no
  // AttemptProof and no execution authority anywhere on these three: they exist so a supervisor
  // whose attempt was cancelled, revoked or never launched can still finish it durably.
  register('post', '/attempts/recovery/lookup', 'recovery_lookup', json, ({ actor, json: read }) => {
    const input = parseWith(z.object({ key: recoveryKeySchema }).strict(), read())
    return recovery.nonLaunchRecovery(actor).lookup(input.key)
  })
  register('post', '/attempts/recovery/stop', 'recovery_stop', json, ({ actor, json: read }) => {
    const input = parseWith(z.object({ binding: startBindingSchema, evidence: stopEvidenceSchema }).strict(), read())
    return recovery.nonLaunchRecovery(actor).submitStop(input.binding, input.evidence)
  })
  register('post', '/attempts/recovery/result', 'recovery_result', json, ({ actor, json: read }) => {
    const input = parseWith(z.object({ binding: startBindingSchema, result: z.unknown() }).strict(), read())
    let result
    try { result = parseDispatchResult(input.result) } catch { throw new DispatchError('DISPATCH_INVALID_INPUT') }
    return recovery.nonLaunchRecovery(actor).submitResult(input.binding, result)
  })
  // The child's own two routes. Bytes in, bytes out, one capability, no identity.
  capabilityRoute('get', '/agent/sources/:key', 'agent_source', json, async ({ req, res, token, attemptId }) => {
    const bytes = await refusable(gateway!.readSource(token, attemptId, req.params.key))
    res.status(200).set({
      'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-SHA256': artifactHash(bytes),
    }).end(Buffer.from(bytes))
    return undefined
  })
  capabilityRoute('put', '/agent/outputs/:key', 'agent_output', ARTIFACT_MAX_BYTES, async ({ req, raw: bytes, token, attemptId }) => {
    const operation = collectedKeys[req.params.key as keyof typeof collectedKeys]
    if (!operation) throw new DispatchError('DISPATCH_INVALID_INPUT')
    const sha256 = contentHash(req, bytes)
    const artifactId = await refusable(gateway!.stage(token, attemptId, operation, bytes, sha256))
    return { artifact_id: artifactId, sha256, byte_size: bytes.byteLength }
  })
  // Three readers, exactly as the REST matrix names them: the requester, an authorized product
  // administrator, and the bound attempt. The third proves itself with its own attempt proof and
  // reaches only that request's prepared sources — the bytes the signed manifest already names.
  register('get', '/artifacts/:id', 'get_artifact', json, async ({ actor, req, res }) => {
    const download = req.get('X-Dispatch-Attempt-Proof')
      ? await artifacts.downloadBoundSource(actor, attemptProof(req), req.params.id)
      : await artifacts.downloadArtifact(actor, req.params.id)
    res.status(200).set(download.headers).end(Buffer.from(download.bytes))
    return undefined
  })
  // The signed statement of which prepared bytes belong to this attempt. It is a read under the
  // attempt's own proof; the supervisor hands the envelope to the operator broker, which verifies
  // the same signature before a single byte is mounted. Absent where no permit key is configured.
  register('post', '/attempts/sources/manifest', 'source_manifest', json, deps.executor
    ? ({ actor, json: read }) => {
      const input = parseWith(z.object({ proof: attemptProofSchema }).strict(), read())
      return signPreparedSourcesManifest({ store: deps.store, auth }, actor, input.proof, deps.executor!.startPermitPrivateKey)
    } : unavailable)
  register('post', '/profiles', 'create_profile', json, ({ actor, json: read }) =>
    administration.createProfile(actor, body(read()) as unknown as ProfileCreateInput))
  register('post', '/profiles/:id/revoke', 'revoke_profile', json, ({ actor, req, json: read }) =>
    administration.revokeProfile(actor, req.params.id, body(read()) as unknown as ProfileRevokeInput))
  register('get', '/profiles', 'list_profiles', json, ({ actor, req }) => {
    const productId = req.query.product_id
    if (typeof productId !== 'string') throw new DispatchError('DISPATCH_INVALID_INPUT')
    return administration.listProfiles(actor, productId)
  })
  register('post', '/slots', 'create_slot', json, registration
    ? ({ actor, json: read }) => registration.createSlot(actor, body(read()) as unknown as SlotInput) : unavailable)
  register('post', '/slots/:id/disable', 'disable_slot', json, ({ actor, req, json: read }) =>
    administration.disableSlot(actor, req.params.id, body(read()) as unknown as SlotDisableInput))
  register('post', '/reply-addresses', 'reply_address', json, ({ actor, json: read }) =>
    administration.allowReplyAddress(actor, body(read()) as unknown as ReplyAddressInput))
  // Queue restore: hand the newest outbox snapshot of every request delivered since the restore
  // point back to the projector. Audited under the caller's action id like every other operation.
  register('post', '/outbox/republish', 'republish_outbox', json, ({ actor, json: read }) =>
    administration.republishOutbox(actor, body(read()) as unknown as OutboxRepublishInput))
  // The audited way out of a publication reconciliation can never decide. It sends nothing, and
  // it carries the same authority as recovery: whoever may recover this request may attest here.
  const resolvePublication = publisher?.resolveUnknownPublication?.bind(publisher)
  register('post', '/publications/:id/resolve', 'resolve_publication', json, resolvePublication
    ? ({ actor, req, json: read }) => {
      const input = parseWith(z.object({ action_id: z.string(), resolution: z.unknown() }).strict(), read())
      return resolvePublication(actor, req.params.id, input.action_id, input.resolution as PublicationResolution)
    } : unavailable)

  app.use((_req, res) => { res.status(404).json({ error: 'DISPATCH_NOT_FOUND' }) })
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return
    if (error instanceof DispatchError) { res.status(dispatchHttpStatus(error)).json({ error: error.code }); return }
    if (error instanceof z.ZodError) { res.status(422).json({ error: 'DISPATCH_INVALID_INPUT' }); return }
    const type = error && typeof error === 'object' && 'type' in error ? error.type : null
    const code = type === 'entity.too.large' ? 'DISPATCH_TOO_LARGE' : type === 'encoding.unsupported' ? 'DISPATCH_BAD_JSON' : null
    res.status(code === 'DISPATCH_TOO_LARGE' ? 413 : code ? 400 : 500).json({ error: code ?? 'DISPATCH_INTERNAL_ERROR' })
  })
  return app
}
