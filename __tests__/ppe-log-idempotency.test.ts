import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/prisma.js', () => ({ prisma: { storyLog: { create: vi.fn() } } }))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/lib/resolve-entity.js', () => ({ resolveStoryRef: vi.fn().mockResolvedValue({ id: 'story-1' }) }))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { handleLogImplementation } from '../src/tools/log-implementation.js'
import { handleLogCommit } from '../src/tools/log-commit.js'
import { handleLogTestResult } from '../src/tools/log-test-result.js'

const DATABASE_URL = process.env.PPE_CONTROLLER_TEST_DATABASE_URL
  ?? 'postgresql://idea169:idea169@127.0.0.1:55442/idea169_plan_b_tests'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const FAMILY_ID = '33333333-3333-4333-8333-333333333334'
const PRINCIPAL = `orchestrator:${RUN_ID}`
const PLAN_AUTHORITY = `bootstrap-invocation:${RUN_ID}`
const JP_START = `jp-start:${RUN_ID}`
const EXECUTION_KEY = 'b5-task'

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
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
  return { operation_key: operationKey, operation_kind: operationKind, request, target_scope: 'story:story-1', version: 'operation-payload-v1' }
}
function ppe(operationKey: string, operationKind: string, request: unknown) {
  return {
    run_id: RUN_ID, orchestrator_id: PRINCIPAL, orchestrator_generation: 3,
    operation_key: operationKey, payload_hash: hash(operationPayload(operationKey, operationKind, request)),
    plan_authority_operation_key: PLAN_AUTHORITY, jp_start_operation_key: JP_START,
  }
}
const text = (result: { content?: Array<{ type: string; text?: string }> }) => result.content?.[0]?.text ?? ''
const db = prisma as unknown as { storyLog: { create: ReturnType<typeof vi.fn> } }
const auth = requireWriteAccess as ReturnType<typeof vi.fn>

beforeAll(async () => { process.env.PPE_CONTROLLER_DATABASE_URL = DATABASE_URL; await seedController() })
afterAll(async () => { await clearController() })
beforeEach(() => {
  vi.clearAllMocks()
  auth.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1', username: 'claude' })
  let row = 0
  db.storyLog.create.mockImplementation(async () => ({ id: `log-${++row}`, created_at: new Date('2026-08-11T00:00:00Z') }))
})

describe('PPE execution log idempotency', () => {
  it('replays implementation, commit and test-result logs under one model-neutral principal', async () => {
    const implementationKey = `log-implementation:${RUN_ID}:${EXECUTION_KEY}:attempt:1`
    const implementationRequest = { story_id: 'story-1', task_id: 'task-1', execution_key: EXECUTION_KEY, content: 'implemented', metadata: null }
    const implementationInput = { story_id: 'story-1', task_id: 'task-1', execution_key: EXECUTION_KEY, content: 'implemented', ppe: ppe(implementationKey, 'LOG_IMPLEMENTATION', implementationRequest) }
    const implementationFirst = await handleLogImplementation(implementationInput)
    auth.mockResolvedValue({ userId: 'user-1', tokenId: 'token-2', username: 'codex' })
    const implementationReplay = await handleLogImplementation(implementationInput)
    expect(text(implementationReplay)).toBe(text(implementationFirst))

    const commitKey = `log-commit:${RUN_ID}:${EXECUTION_KEY}:attempt:1`
    const commitRequest = { story_id: 'story-1', task_id: 'task-1', execution_key: EXECUTION_KEY, content: 'commit', commit_hash: 'abc123', commit_message: 'feat: b5', metadata: null }
    const commitInput = { story_id: 'story-1', task_id: 'task-1', execution_key: EXECUTION_KEY, content: 'commit', commit_hash: 'abc123', commit_message: 'feat: b5', ppe: ppe(commitKey, 'LOG_COMMIT', commitRequest) }
    const commitFirst = await handleLogCommit(commitInput)
    const commitReplay = await handleLogCommit(commitInput)
    expect(text(commitReplay)).toBe(text(commitFirst))

    const testKey = `log-test-result:${RUN_ID}:${EXECUTION_KEY}:attempt:1`
    const testRequest = { story_id: 'story-1', task_id: 'task-1', execution_key: EXECUTION_KEY, content: 'tests', status: 'PASSED', metadata: null }
    const testInput = { story_id: 'story-1', task_id: 'task-1', execution_key: EXECUTION_KEY, content: 'tests', status: 'PASSED' as const, ppe: ppe(testKey, 'LOG_TEST_RESULT', testRequest) }
    const testFirst = await handleLogTestResult(testInput)
    const testReplay = await handleLogTestResult(testInput)
    expect(text(testReplay)).toBe(text(testFirst))
    expect(db.storyLog.create).toHaveBeenCalledTimes(3)
    expect(db.storyLog.create.mock.calls[0][0].data.metadata.ppe).toMatchObject({ task_id: 'task-1', execution_key: EXECUTION_KEY, operation_key: implementationKey })
  })

  it('rejects a second log body and invalid key variants without creating another row', async () => {
    const operationKey = `log-implementation:${RUN_ID}:${EXECUTION_KEY}:attempt:2`
    const request = { story_id: 'story-1', task_id: 'task-1', execution_key: EXECUTION_KEY, content: 'first', metadata: null }
    await handleLogImplementation({ story_id: 'story-1', task_id: 'task-1', execution_key: EXECUTION_KEY, content: 'first', ppe: ppe(operationKey, 'LOG_IMPLEMENTATION', request) })
    const changed = { ...request, content: 'second' }
    expect(text(await handleLogImplementation({ story_id: 'story-1', task_id: 'task-1', execution_key: EXECUTION_KEY, content: 'second', ppe: ppe(operationKey, 'LOG_IMPLEMENTATION', changed) }))).toContain('PPE_OPERATION_KEY_REUSE')

    const invalidKey = `log-implementation:${RUN_ID}:${EXECUTION_KEY}:attempt:6`
    expect(text(await handleLogImplementation({ story_id: 'story-1', task_id: 'task-1', execution_key: EXECUTION_KEY, content: 'invalid', ppe: ppe(invalidKey, 'LOG_IMPLEMENTATION', { ...request, content: 'invalid' }) }))).toContain('PPE_LOG_OPERATION_KEY')
    expect(db.storyLog.create).toHaveBeenCalledTimes(1)
  })
})
