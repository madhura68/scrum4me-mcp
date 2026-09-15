import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { DispatchInput } from '@shared/queue-dispatch.js'
import { resolveRuntimeJobConfig, type RuntimeJobConfig } from '@shared/job-config.js'
import { DispatchError } from './errors.js'
import { requestJob } from './eligibility.js'
export type ManagedRequest = { id: string; user_id: string; product_id: string; input: DispatchInput; snapshot: Record<string, unknown> }
export type ManagedJobSnapshot = { CLAUDE: RuntimeJobConfig | null; CODEX: RuntimeJobConfig | null }
/** Configuration is resolved before the create transaction and then copied to
 * the job/audit once. Task contract remains the immutable intake snapshot. */
export async function readManagedJobSnapshot(db: Pool, request: ManagedRequest): Promise<ManagedJobSnapshot> {
  const kind = requestJob(request.input, request.user_id, 'CODEX', 'pending').kind
  const product = (await db.query('SELECT preferred_model,thinking_budget_default,preferred_permission_mode FROM products WHERE id=$1', [request.product_id])).rows[0] ?? {}
  const task = request.input.task_id ? (await db.query('SELECT requires_opus FROM tasks WHERE id=$1', [request.input.task_id])).rows[0] : undefined
  const kindConfig = (await db.query('SELECT * FROM job_kind_config WHERE kind=$1', [kind])).rows[0]
  function resolve(runtime:'CLAUDE'|'CODEX') {
    try { return resolveRuntimeJobConfig({kind},product,task,kindConfig,runtime) }
    catch(error) { if(error instanceof Error && error.message==='DISPATCH_JOB_CONFIG_UNSAFE') return null; throw error }
  }
  return {CLAUDE:resolve('CLAUDE'),CODEX:resolve('CODEX')}
}
/** Called before any candidate/slot/job locks. Both ordinary and managed enqueue
 * use this same tasks row lock, so an ordinary enqueue cannot race the check. */
export async function lockManagedTask(db: PoolClient, request: ManagedRequest) {
  if (request.input.action !== 'task_implementation') return
  const task = (await db.query<{ product_id: string; status: string; repo_url: string | null; dispatch_request_id: string | null }>('SELECT product_id,status,repo_url,dispatch_request_id FROM tasks WHERE id=$1 FOR UPDATE', [request.input.task_id])).rows[0]
  if (!task || task.product_id !== request.product_id) throw new DispatchError('DISPATCH_FORBIDDEN')
  const active = await db.query(`SELECT 1 FROM claude_jobs WHERE task_id=$1 AND status IN ('QUEUED','CLAIMED','RUNNING') AND dispatch_request_id IS DISTINCT FROM $2::uuid
  UNION ALL SELECT 1 FROM sprint_task_executions WHERE task_id=$1 AND status IN ('PENDING','RUNNING') LIMIT 1`, [request.input.task_id, request.id])
  if ((task.dispatch_request_id !== null && task.dispatch_request_id !== request.id) || task.status !== 'TO_DO' || active.rowCount) throw new DispatchError('DISPATCH_STATE_CONFLICT')
  const repos = (await db.query<{ id: string; repo_url: string | null }>('SELECT id,repo_url FROM products WHERE id=ANY($1::text[])', [[request.product_id, request.input.requirements.repository!.product_id]])).rows
  const main = repos.find(p => p.id === request.product_id), repo = repos.find(p => p.id === request.input.requirements.repository!.product_id)
  const accepted = request.snapshot.repository as { repo_url?: string } | undefined
  if (!repo?.repo_url || (task.repo_url ?? main?.repo_url) !== repo.repo_url || accepted?.repo_url !== repo.repo_url) throw new DispatchError('DISPATCH_FORBIDDEN')
}
export async function enqueueManagedJob(db: PoolClient, request: ManagedRequest, candidate: { id: string; profileRevisionId: string; runtime: 'CODEX' | 'CLAUDE' }, snapshot: RuntimeJobConfig): Promise<string> {
  // The selection transaction already owns the Task lock before candidate locks.
  // Reentrant acquisition keeps this public adapter safe when called directly.
  await lockManagedTask(db, request)
  const old = (await db.query<{ id: string }>('SELECT id FROM claude_jobs WHERE dispatch_candidate_id=$1', [candidate.id])).rows[0]
  if (old) return old.id
  const job = requestJob(request.input, request.user_id, candidate.runtime, candidate.profileRevisionId, request.id), id = randomUUID()
  await db.query(`INSERT INTO claude_jobs(id,user_id,product_id,task_id,kind,status,source,runtime,required_capability,
  requested_model,requested_thinking_budget,requested_permission_mode,plan_snapshot,base_sha,dispatch_request_id,dispatch_candidate_id,updated_at)
  VALUES($1,$2,$3,$4,$5,'QUEUED','COPILOT',$6,$7,$8,$9,$10,$11,$12,$13,$14,now())`,
    [id, request.user_id, request.product_id, request.input.task_id ?? null, job.kind, candidate.runtime, job.requiredCapability, snapshot.model, snapshot.thinking_budget,
      snapshot.runtime === 'CLAUDE' ? snapshot.permission_mode : 'default', request.snapshot.implementation_plan ?? null, request.input.requirements.repository?.base_sha ?? null, request.id, candidate.id])
  return id
}
