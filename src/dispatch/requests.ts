import { createHash, randomUUID } from 'node:crypto'
import { writeDispatchOutbox, DELIVERY_FAILED_AFTER } from './outbox.js'
import type { PoolClient } from 'pg'
import { DISPATCH_REPLY_UUID_NAMESPACE, dispatchReplyUuidName, type DispatchInput, type DispatchView } from '@shared/queue-dispatch.js'
import { canonicalDispatchInput, parseDispatchInput } from '@shared/queue-dispatch-validation.js'
import { isQueueDispatchRequestId } from '@shared/queue-identity.js'
import { withDispatchRetryTransaction, type DispatchStore } from './db.js'
import { DispatchError } from './errors.js'
import type { DispatchAuth } from './auth.js'
import type { DispatchActor } from './ports.js'

export function dispatchReplyUuid(requestId: string): string {
  const namespace = Buffer.from(DISPATCH_REPLY_UUID_NAMESPACE.replaceAll('-', ''), 'hex')
  const digest = createHash('sha1').update(namespace).update(dispatchReplyUuidName(requestId), 'utf8').digest().subarray(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const h = digest.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
type RequestRow = {
  id: string; user_id: string; input: DispatchInput; input_hash: string; version: string
  state: DispatchView['state']; created_at: Date; result_id: string | null
  route: 'job' | 'host' | null; profile_revision_id: string | null; job_id: string | null
  delivery: DispatchView['delivery']; waiting_reason: string | null
}
const selectRequest = `SELECT r.id,r.user_id,r.input,r.input_hash,r.version::text,r.state,r.created_at,r.result_id,
 c.route,c.profile_revision_id,c.job_id,
 (SELECT e.payload->>'reason' FROM queue_dispatch_events e WHERE e.request_id=r.id AND e.type='waiting_reason' ORDER BY e.created_at DESC,e.id DESC LIMIT 1) AS waiting_reason,
 CASE WHEN o.published_at IS NOT NULL THEN 'delivered' WHEN o.attempts>=${DELIVERY_FAILED_AFTER} THEN 'failed' ELSE 'pending' END AS delivery
 FROM queue_dispatch_requests r
 LEFT JOIN queue_dispatch_candidates c ON c.request_id=r.id AND c.generation=r.generation
 LEFT JOIN queue_dispatch_outbox o ON o.request_id=r.id AND o.version=r.version`
function view(row: RequestRow): DispatchView {
  return { id: row.id, version: row.version, state: row.state, action: row.input.action,
    reason: row.state === 'WAITING' ? (row.waiting_reason ?? 'waiting_for_capacity') : row.state.toLowerCase(), route: row.route,
    profile_revision_id: row.profile_revision_id, job_id: row.job_id, executor_label: null,
    result_id: row.result_id, delivery: row.delivery, created_at: row.created_at.toISOString() }
}
function validateKey(key: string) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new DispatchError('DISPATCH_INVALID_INPUT')
}
function parse(value: unknown): DispatchInput {
  try { return parseDispatchInput(value) } catch { throw new DispatchError('DISPATCH_INVALID_INPUT') }
}
async function snapshotTask(db: PoolClient, input: DispatchInput): Promise<Record<string, unknown>> {
  if (input.action !== 'task_implementation') return {}
  const task = (await db.query<{
    id: string; product_id: string; story_id: string; implementation_plan: string | null; status: string
    title: string; description: string | null; verify_only: boolean; verify_required: string; repo_url: string | null
  }>('SELECT id,product_id,story_id,title,description,implementation_plan,status,verify_only,verify_required,repo_url FROM tasks WHERE id=$1 FOR UPDATE', [input.task_id])).rows[0]
  if (!task || task.product_id !== input.product_id) throw new DispatchError('DISPATCH_FORBIDDEN')
  const active = await db.query(`SELECT 1 FROM claude_jobs WHERE task_id=$1 AND status IN ('QUEUED','CLAIMED','RUNNING')
    UNION ALL SELECT 1 FROM sprint_task_executions WHERE task_id=$1 AND status IN ('PENDING','RUNNING') LIMIT 1`, [task.id])
  if (task.status !== 'TO_DO' || active.rowCount) throw new DispatchError('DISPATCH_STATE_CONFLICT')
  const story = (await db.query<{ acceptance_criteria: string | null }>('SELECT acceptance_criteria FROM stories WHERE id=$1', [task.story_id])).rows[0]
  const repositories = (await db.query<{ id: string; repo_url: string | null; definition_of_done: string }>(
    'SELECT id,repo_url,definition_of_done FROM products WHERE id=ANY($1::text[])', [[input.product_id, input.requirements.repository!.product_id]])).rows
  const product = repositories.find(p => p.id === input.product_id)!
  const repo = repositories.find(p => p.id === input.requirements.repository!.product_id)!
  if (!repo?.repo_url || (task.repo_url ?? product.repo_url) !== repo.repo_url) throw new DispatchError('DISPATCH_FORBIDDEN')
  // This immutable snapshot is the only Task execution contract. Selection must
  // recheck dispatchability under the same Task row lock, never replace the plan.
  return { task_id: task.id, product_id: task.product_id, story_id: task.story_id,
    title: task.title, description: task.description, implementation_plan: task.implementation_plan,
    acceptance_criteria: story?.acceptance_criteria ?? null, verify_only: task.verify_only,
    verify_required: task.verify_required, definition_of_done: product.definition_of_done,
    repository: { product_id: repo.id, repo_url: repo.repo_url, base_sha: input.requirements.repository!.base_sha } }
}
async function validateDocumentPins(db: PoolClient, input: DispatchInput) {
  for (const ref of input.review_documents?.items ?? []) {
    if (ref.source !== 'product_doc') continue // Git bytes are resolved by the source service in IP-08.
    const revision = await db.query(`SELECT 1 FROM product_doc_revisions r JOIN product_docs d ON d.id=r.doc_id
      WHERE r.id=$1 AND r.doc_id=$2 AND d.product_id=$3 AND r.content_hash=$4`, [ref.revision_id, ref.doc_id, ref.product_id, ref.sha256])
    if (!revision.rowCount) throw new DispatchError('DISPATCH_INVALID_INPUT')
  }
}
export function createDispatchRequests(deps: {
  store: DispatchStore; auth: DispatchAuth; enabled: boolean; productAllowlist: readonly string[]
}) {
  async function getDispatch(actor: DispatchActor, id: string): Promise<DispatchView> {
    if (!isQueueDispatchRequestId(id)) throw new DispatchError('DISPATCH_NOT_FOUND')
    const row = (await deps.store.query<RequestRow>(`${selectRequest} WHERE r.id=$1`, [id])).rows[0]
    if (!row) throw new DispatchError('DISPATCH_NOT_FOUND')
    try { await deps.auth.authorizeRequestRead(actor, row.input, row.user_id) } catch (error) {
      if (error instanceof DispatchError && error.code === 'DISPATCH_FORBIDDEN') throw new DispatchError('DISPATCH_NOT_FOUND')
      throw error
    }
    return view(row)
  }
  async function submitDispatch(actor: DispatchActor, value: unknown, key: string): Promise<DispatchView> {
    const input = parse(value); validateKey(key)
    await deps.auth.authorizeDispatch(actor, input, 'submit')
    if (!deps.enabled || !deps.productAllowlist.includes(input.product_id)) throw new DispatchError('DISPATCH_NOT_FOUND')
    const inputHash = createHash('sha256').update(canonicalDispatchInput(input), 'utf8').digest('hex')
    return withDispatchRetryTransaction(deps.store, async db => {
      await deps.auth.authorizeDispatch(actor, input, 'submit', db)
      const existing = (await db.query<RequestRow>(`${selectRequest} WHERE r.principal_key=$1 AND r.idempotency_key=$2`, [actor.principalKey, key])).rows[0]
      if (existing) {
        if (existing.input_hash !== inputHash) throw new DispatchError('DISPATCH_IDEMPOTENCY_CONFLICT')
        return view(existing)
      }
      const snapshot = await snapshotTask(db, input)
      await validateDocumentPins(db, input)
      const id = randomUUID(); const rootId = randomUUID(); const replyId = dispatchReplyUuid(id)
      const authSource = { source: actor.source, user_id: actor.userId, token_id: actor.tokenId,
        issuer: actor.source === 'bearer' ? null : `scrum4me-${actor.source}` }
      const inserted = await db.query(`INSERT INTO queue_dispatch_requests
        (id,principal_key,idempotency_key,user_id,product_id,auth_source,input,input_hash,snapshot,
         state,version,generation,root_message_id,reply_message_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,'WAITING',1,0,$10,$11,now(),now())
        ON CONFLICT(principal_key,idempotency_key) DO NOTHING RETURNING id`,
      [id, actor.principalKey, key, actor.userId, input.product_id, JSON.stringify(authSource), JSON.stringify(input), inputHash, JSON.stringify(snapshot), rootId, replyId])
      if (inserted.rowCount) {
        await db.query(`INSERT INTO queue_dispatch_events(id,request_id,type,actor,payload)
          VALUES($1,$2,'submitted',$3::jsonb,$4::jsonb)`, [randomUUID(), id, JSON.stringify(authSource), JSON.stringify({ input_hash: inputHash })])
        await writeDispatchOutbox(db, id)
      }
      const row = (await db.query<RequestRow>(`${selectRequest} WHERE r.principal_key=$1 AND r.idempotency_key=$2`, [actor.principalKey, key])).rows[0]
      if (row.input_hash !== inputHash) throw new DispatchError('DISPATCH_IDEMPOTENCY_CONFLICT')
      return view(row)
    })
  }
  return { submitDispatch, getDispatch }
}
export type DispatchRequests = ReturnType<typeof createDispatchRequests>

export type DispatchReceiptValue = string | number | boolean | null | DispatchReceipt | DispatchReceiptValue[]
export type DispatchReceipt = { [key: string]: DispatchReceiptValue }
function redactValue(value: DispatchReceiptValue): DispatchReceiptValue {
  if (Array.isArray(value)) return value.map(redactValue)
  return value && typeof value === 'object' ? redactReceipt(value) : value
}
function redactReceipt(value: DispatchReceipt): DispatchReceipt {
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key.endsWith('_id') || !/credential|token|secret|authorization|assertion|dsn|database.?url/i.test(key))
    .map(([key, item]) => [key, redactValue(item)]))
}
/** Outside-request actions share one durable receipt. The callback is DB-only;
 * claim credentials must be reconstructed by IP-06 for the bound incarnation. */
export async function withDispatchOperation(store: DispatchStore, input: {
  actor: DispatchActor; operation: 'register' | 'profile' | 'revoke_profile' | 'slot' | 'disable_slot' | 'reply_address'
  actionId: string; payloadHash: string
}, mutate: (db: PoolClient) => Promise<DispatchReceipt>): Promise<DispatchReceipt> {
  validateKey(input.actionId)
  if (!/^[a-f0-9]{64}$/.test(input.payloadHash)) throw new DispatchError('DISPATCH_INVALID_INPUT')
  const key = `${input.actor.principalKey}:${input.operation}:${input.actionId}`
  return withDispatchRetryTransaction(store, async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key])
    const old = (await db.query<{ payload: { input_hash: string; response: DispatchReceipt } }>(
      'SELECT payload FROM queue_dispatch_events WHERE operation_key=$1', [key])).rows[0]
    if (old) {
      if (old.payload.input_hash !== input.payloadHash) throw new DispatchError('DISPATCH_IDEMPOTENCY_CONFLICT')
      return old.payload.response
    }
    const response = redactReceipt(await mutate(db))
    await db.query(`INSERT INTO queue_dispatch_events(id,type,actor,payload,action_id,operation_key)
      VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6)`, [randomUUID(), input.operation,
      JSON.stringify({ source: input.actor.source, user_id: input.actor.userId, token_id: input.actor.tokenId }),
      JSON.stringify({ input_hash: input.payloadHash, response }), input.actionId, key])
    return response
  })
}
