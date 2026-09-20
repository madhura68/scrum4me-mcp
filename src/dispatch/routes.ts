import express, { type Express, type Request, type Response, type NextFunction, type RequestHandler } from 'express'
import { performance } from 'node:perf_hooks'
import type { KeyObject } from 'node:crypto'
import { z } from 'zod'
import { attemptProofSchema, stopEvidenceSchema, parseDispatchResult } from '@shared/queue-dispatch-validation.js'
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
  | 'stop_evidence' | 'result' | 'put_artifact' | 'get_artifact'
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
  const register = (method: 'post' | 'get' | 'put', path: string, operation: DispatchHttpOperation, limit: number, fn: Handler) =>
    app[method](`/dispatch/v1${path}`, log(operation), raw(limit), handle(fn, method !== 'get' && operation !== 'put_artifact'))
  const json = 256 * 1024

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
  register('post', '/attempts/start', 'start', json, attempts
    ? ({ actor, json: read }) => { const input = parseWith(runtimeScope, read()); return attempts.startDispatchAttempt(actor, input.proof, scopeOf(input)) }
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
    return { status: receipt.accepted ? 'accepted' : 'late', result_id: receipt.resultId }
  })
  register('put', '/attempts/artifacts/:key', 'put_artifact', ARTIFACT_MAX_BYTES, async ({ actor, req, raw: bytes }) => {
    const sha256 = contentHash(req, bytes)
    const artifactId = await artifacts.storeAttemptArtifact(actor, attemptProof(req), req.params.key, bytes, sha256)
    return { artifact_id: artifactId, sha256, byte_size: bytes.byteLength }
  })
  register('get', '/artifacts/:id', 'get_artifact', json, async ({ actor, req, res }) => {
    const download = await artifacts.downloadArtifact(actor, req.params.id)
    res.status(200).set(download.headers).end(Buffer.from(download.bytes))
    return undefined
  })
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
