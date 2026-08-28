import { createHash, randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    task: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    sprintRun: { findUnique: vi.fn() },
    claudeJob: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn().mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' }),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/access.js', () => ({ userCanAccessTask: vi.fn().mockResolvedValue(true) }))
vi.mock('../src/lib/resolve-entity.js', () => ({ resolveTaskRef: vi.fn().mockResolvedValue({ id: 'task-1' }) }))
vi.mock('../src/lib/tasks-status-update.js', () => ({
  updateTaskStatusWithStoryPromotion: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { updateTaskStatusWithStoryPromotion } from '../src/lib/tasks-status-update.js'
import { handleUpdateTaskPlan } from '../src/tools/update-task-plan.js'
import { handleUpdateTaskStatus } from '../src/tools/update-task-status.js'

const DATABASE_URL = process.env.PPE_CONTROLLER_TEST_DATABASE_URL
  ?? 'postgresql://idea169:idea169@127.0.0.1:55442/idea169_plan_b_tests'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const FAMILY_ID = '22222222-2222-4222-8222-222222222223'
const PRINCIPAL = `orchestrator:${RUN_ID}`
const PLAN_AUTHORITY = `bootstrap-invocation:${RUN_ID}`
const JP_START = `jp-start:${RUN_ID}`

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const bytesHash = (value: string | null) => createHash('sha256').update(value ?? '').digest('hex')

function makeReceipt(operationKey: string, kind: string, payload: unknown, result: unknown) {
  const value = { version: 'operation-receipt-v1', run_id: RUN_ID, operation_key: operationKey, payload_sha256: hash(payload), kind, status: 'COMMITTED', payload, result }
  return { value, receiptHash: hash(value) }
}
async function seedController(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL }); await client.connect()
  await client.query('DELETE FROM ppe_operation_receipt WHERE run_id=$1', [RUN_ID])
  await client.query('DELETE FROM ppe_orchestrator_lease WHERE run_id=$1', [RUN_ID])
  await client.query('DELETE FROM ppe_run_registry WHERE run_id=$1', [RUN_ID])
  await client.query('DELETE FROM ppe_bootstrap_family WHERE id=$1', [FAMILY_ID])
  await client.query(`INSERT INTO ppe_bootstrap_family(id,family_key,current_ordinal,updated_at) VALUES ($1,$2,1,now())`, [FAMILY_ID, `b5-family:${RUN_ID}`])
  await client.query(
    `INSERT INTO ppe_run_registry(run_id,family_id,ordinal,invocation_operation_key,invocation_payload_sha256,principal,state,generation,registry_receipt_sha256,updated_at)
     VALUES ($1,$2,1,$3,$4,$5,'ACTIVE',3,$6,now())`, [RUN_ID, FAMILY_ID, PLAN_AUTHORITY, 'a'.repeat(64), PRINCIPAL, 'b'.repeat(64)],
  )
  for (const generation of [1, 2, 3]) await client.query(
    `INSERT INTO ppe_orchestrator_lease(run_id,generation,owner_principal,lease_expires_at,fence_sha256,status,updated_at)
     VALUES ($1,$2,$3,now()+interval '1 day',$4,$5,now())`,
    [RUN_ID, generation, PRINCIPAL, String(generation).repeat(64), generation === 3 ? 'CURRENT' : 'SUPERSEDED'],
  )
  for (const [key, kind] of [[PLAN_AUTHORITY, 'COMPOSITION_BOOTSTRAP'], [JP_START, 'JP_START_GATE']] as const) {
    const payload = { version: `${kind.toLowerCase()}-v1`, run_id: RUN_ID }
    const receipt = makeReceipt(key, kind, payload, { runId: RUN_ID, principal: PRINCIPAL })
    await client.query(
      `INSERT INTO ppe_operation_receipt(run_id,operation_key,payload_sha256,kind,status,receipt_json,receipt_sha256,updated_at)
       VALUES ($1,$2,$3,$4,'COMMITTED',$5,$6,now())`,
      [RUN_ID, key, hash(payload), kind, JSON.stringify(receipt.value), receipt.receiptHash],
    )
  }
  await client.end()
}
async function clearController(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL }); await client.connect()
  await client.query('DELETE FROM ppe_operation_receipt WHERE run_id=$1', [RUN_ID])
  await client.query('DELETE FROM ppe_orchestrator_lease WHERE run_id=$1', [RUN_ID])
  await client.query('DELETE FROM ppe_run_registry WHERE run_id=$1', [RUN_ID])
  await client.query('DELETE FROM ppe_bootstrap_family WHERE id=$1', [FAMILY_ID])
  await client.end()
}
function operationPayload(operationKey: string, operationKind: string, request: unknown) {
  return { operation_key: operationKey, operation_kind: operationKind, request, target_scope: 'task:task-1', version: 'operation-payload-v1' }
}
function ppe(operationKey: string, operationKind: string, request: unknown, withStart = false) {
  return {
    run_id: RUN_ID, orchestrator_id: PRINCIPAL, orchestrator_generation: 3,
    operation_key: operationKey, payload_hash: hash(operationPayload(operationKey, operationKind, request)),
    plan_authority_operation_key: PLAN_AUTHORITY,
    ...(withStart ? { jp_start_operation_key: JP_START } : {}),
  }
}
const text = (result: { content?: Array<{ type: string; text?: string }> }) => result.content?.[0]?.text ?? ''
const db = prisma as unknown as Record<string, any>
const statusMutation = updateTaskStatusWithStoryPromotion as ReturnType<typeof vi.fn>

beforeAll(async () => { process.env.PPE_CONTROLLER_DATABASE_URL = DATABASE_URL; await seedController() })
afterAll(async () => { await clearController() })
beforeEach(() => {
  vi.clearAllMocks()
  db.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma))
  db.task.findUnique.mockResolvedValue({ id: 'task-1', status: 'TO_DO', implementation_plan: 'old\n' })
  db.task.updateMany.mockResolvedValue({ count: 1 })
  db.task.update.mockImplementation(async ({ data }: any) => ({ id: 'task-1', status: 'TO_DO', implementation_plan: data.implementation_plan }))
  statusMutation.mockResolvedValue({
    task: { id: 'task-1', status: 'IN_PROGRESS', implementation_plan: 'new\n' },
    storyStatusChange: null, sprintRunChanged: false,
  })
})

describe('PPE task plan and status CAS', () => {
  it('replays one exact task-plan CAS and rejects changed or stale replacement', async () => {
    const operationKey = `task-plan:${RUN_ID}:${randomUUID()}`
    const request = { task_id: 'task-1', expected_current_hash: bytesHash('old\n'), replacement_hash: bytesHash('new\n'), implementation_plan: 'new\n' }
    const input = { ...request, ppe: ppe(operationKey, 'TASK_PLAN_CAS', request) }
    const first = await handleUpdateTaskPlan(input)
    const replay = await handleUpdateTaskPlan(input)
    expect(text(replay)).toBe(text(first))
    expect(db.task.updateMany).toHaveBeenCalledTimes(1)

    const changedRequest = { ...request, implementation_plan: 'changed\n', replacement_hash: bytesHash('changed\n') }
    expect(text(await handleUpdateTaskPlan({ ...changedRequest, ppe: ppe(operationKey, 'TASK_PLAN_CAS', changedRequest) }))).toContain('PPE_OPERATION_KEY_REUSE')

    const staleOperation = `task-plan:${RUN_ID}:${randomUUID()}`
    const staleRequest = { ...request, expected_current_hash: bytesHash('stale\n') }
    expect(text(await handleUpdateTaskPlan({ ...staleRequest, ppe: ppe(staleOperation, 'TASK_PLAN_CAS', staleRequest) }))).toContain('PPE_TASK_PLAN_CAS')
    expect(db.task.updateMany).toHaveBeenCalledTimes(1)
  })

  it('requires a positive affected row count for the plan CAS', async () => {
    db.task.updateMany.mockResolvedValue({ count: 0 })
    const operationKey = `task-plan:${RUN_ID}:${randomUUID()}`
    const request = { task_id: 'task-1', expected_current_hash: bytesHash('old\n'), replacement_hash: bytesHash('new\n'), implementation_plan: 'new\n' }
    expect(text(await handleUpdateTaskPlan({ ...request, ppe: ppe(operationKey, 'TASK_PLAN_CAS', request) }))).toContain('PPE_ZERO_AFFECTED_ROWS')
  })

  it('replays an exact status CAS, requires the later JP-start receipt and rejects regressions', async () => {
    const operationKey = `task-status:${RUN_ID}:${randomUUID()}`
    const request = { task_id: 'task-1', expected_status: 'todo', target_status: 'in_progress', sprint_run_id: null }
    const input = { task_id: 'task-1', status: 'in_progress', expected_status: 'todo', ppe: ppe(operationKey, 'TASK_STATUS_CAS', request, true) }
    const first = await handleUpdateTaskStatus(input)
    const replay = await handleUpdateTaskStatus(input)
    expect(text(replay)).toBe(text(first))
    expect(statusMutation).toHaveBeenCalledTimes(1)

    const noStartKey = `task-status:${RUN_ID}:${randomUUID()}`
    expect(text(await handleUpdateTaskStatus({ ...input, ppe: ppe(noStartKey, 'TASK_STATUS_CAS', request) }))).toContain('PPE_JP_START_AUTHORITY')

    db.task.findUnique.mockResolvedValue({ id: 'task-1', status: 'DONE', implementation_plan: 'new\n' })
    const regressionKey = `task-status:${RUN_ID}:${randomUUID()}`
    const regressionRequest = { task_id: 'task-1', expected_status: 'done', target_status: 'in_progress', sprint_run_id: null }
    expect(text(await handleUpdateTaskStatus({ task_id: 'task-1', status: 'in_progress', expected_status: 'done', ppe: ppe(regressionKey, 'TASK_STATUS_CAS', regressionRequest, true) }))).toContain('PPE_STATUS_REGRESSION')
    expect(statusMutation).toHaveBeenCalledTimes(1)
  })
})
