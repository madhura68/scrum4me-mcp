import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    sprint: { findMany: vi.fn(), create: vi.fn() },
    pbi: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    pbiDoc: { upsert: vi.fn() },
    productDoc: { findMany: vi.fn() },
    productDocRevision: { findUnique: vi.fn() },
    story: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    task: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn().mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' }),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn().mockResolvedValue(true) }))

import { prisma } from '../src/prisma.js'
import { handleCreateSprint } from '../src/tools/create-sprint.js'
import { handleCreatePbi } from '../src/tools/create-pbi.js'
import { handleCreateStory } from '../src/tools/create-story.js'
import { handleCreateTask } from '../src/tools/create-task.js'

const DATABASE_URL = process.env.PPE_CONTROLLER_TEST_DATABASE_URL
  ?? 'postgresql://idea169:idea169@127.0.0.1:55442/idea169_plan_b_tests'
const RUN_ID = '11111111-1111-4111-8111-111111111111'
const FAMILY_ID = '11111111-1111-4111-8111-111111111112'
const PRINCIPAL = `orchestrator:${RUN_ID}`
const PLAN_AUTHORITY = `bootstrap-invocation:${RUN_ID}`

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}
function receipt(operationKey: string, kind: string, payload: unknown, result: unknown) {
  const value = {
    version: 'operation-receipt-v1', run_id: RUN_ID, operation_key: operationKey,
    payload_sha256: hash(payload), kind, status: 'COMMITTED', payload, result,
  }
  return { value, receiptHash: hash(value) }
}

async function seedController(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  await client.query('BEGIN')
  await client.query('SELECT pg_advisory_xact_lock(1690501)')
  await client.query('DELETE FROM ppe_operation_receipt WHERE run_id=$1', [RUN_ID])
  await client.query('DELETE FROM ppe_orchestrator_lease WHERE run_id=$1', [RUN_ID])
  await client.query('DELETE FROM ppe_run_registry WHERE run_id=$1', [RUN_ID])
  await client.query('DELETE FROM ppe_bootstrap_family WHERE id=$1', [FAMILY_ID])
  await client.query(
    `INSERT INTO ppe_bootstrap_family(id,family_key,current_ordinal,updated_at)
     VALUES ($1,$2,1,now())`, [FAMILY_ID, `b5-family:${RUN_ID}`],
  )
  await client.query(
    `INSERT INTO ppe_run_registry
      (run_id,family_id,ordinal,invocation_operation_key,invocation_payload_sha256,
       principal,state,generation,registry_receipt_sha256,updated_at)
     VALUES ($1,$2,1,$3,$4,$5,'ACTIVE',3,$6,now())`,
    [RUN_ID, FAMILY_ID, PLAN_AUTHORITY, 'a'.repeat(64), PRINCIPAL, 'b'.repeat(64)],
  )
  for (const generation of [1, 2, 3]) {
    await client.query(
      `INSERT INTO ppe_orchestrator_lease
        (run_id,generation,owner_principal,lease_expires_at,fence_sha256,status,updated_at)
       VALUES ($1,$2,$3,now()+interval '1 day',$4,$5,now())`,
      [RUN_ID, generation, PRINCIPAL, String(generation).repeat(64), generation === 3 ? 'CURRENT' : 'SUPERSEDED'],
    )
  }
  const authorityPayload = { version: 'bootstrap-invocation-v1', reviewed_plan_authority: true }
  const authority = receipt(PLAN_AUTHORITY, 'COMPOSITION_BOOTSTRAP', authorityPayload, {
    version: 'bootstrap-result-v1', runId: RUN_ID, principal: PRINCIPAL, registryState: 'ACTIVE',
  })
  await client.query(
    `INSERT INTO ppe_operation_receipt
      (run_id,operation_key,payload_sha256,kind,status,receipt_json,receipt_sha256,updated_at)
     VALUES ($1,$2,$3,'COMPOSITION_BOOTSTRAP','COMMITTED',$4,$5,now())`,
    [RUN_ID, PLAN_AUTHORITY, hash(authorityPayload), JSON.stringify(authority.value), authority.receiptHash],
  )
  await client.query('COMMIT')
  await client.end()
}

async function clearController(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  await client.query('DELETE FROM ppe_operation_receipt WHERE run_id=$1', [RUN_ID])
  await client.query('DELETE FROM ppe_orchestrator_lease WHERE run_id=$1', [RUN_ID])
  await client.query('DELETE FROM ppe_run_registry WHERE run_id=$1', [RUN_ID])
  await client.query('DELETE FROM ppe_bootstrap_family WHERE id=$1', [FAMILY_ID])
  await client.end()
}

function operationPayload(operationKey: string, operationKind: string, request: unknown, targetScope: string) {
  return { operation_key: operationKey, operation_kind: operationKind, request, target_scope: targetScope, version: 'operation-payload-v1' }
}
function ppe(operationKey: string, operationKind: string, request: unknown, targetScope: string) {
  return {
    run_id: RUN_ID,
    orchestrator_id: PRINCIPAL,
    orchestrator_generation: 3,
    operation_key: operationKey,
    payload_hash: hash(operationPayload(operationKey, operationKind, request, targetScope)),
    plan_authority_operation_key: PLAN_AUTHORITY,
  }
}
function objectKey(kind: string): string { return `b5:${kind}:${crypto.randomUUID()}` }
function ceremonyKey(kind: string, stableObjectKey: string): string {
  return `ceremony:${RUN_ID}:${kind}:${createHash('sha256').update(stableObjectKey).digest('hex')}`
}
function text(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.[0]?.text ?? ''
}

const db = prisma as unknown as Record<string, any>

beforeAll(async () => {
  process.env.PPE_CONTROLLER_DATABASE_URL = DATABASE_URL
  await seedController()
})
afterAll(async () => { await clearController() })

beforeEach(() => {
  vi.clearAllMocks()
  db.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma))
  db.sprint.findMany.mockResolvedValue([])
  db.sprint.create.mockImplementation(async ({ data }: any) => ({ id: 'sprint-1', created_at: new Date('2026-08-11T00:00:00Z'), ...data }))
  db.productDoc.findMany.mockResolvedValue([])
  db.pbi.findMany.mockResolvedValue([])
  db.pbi.findFirst.mockResolvedValue(null)
  db.pbi.create.mockImplementation(async ({ data }: any) => ({ id: 'pbi-1', created_at: new Date('2026-08-11T00:00:00Z'), ...data }))
  db.story.findUnique.mockResolvedValue({ product_id: 'product-1', sprint_id: 'sprint-1', assignee_id: null })
  db.story.findMany.mockResolvedValue([])
  db.story.findFirst.mockResolvedValue(null)
  db.story.create.mockImplementation(async ({ data }: any) => ({ id: 'story-1', created_at: new Date('2026-08-11T00:00:00Z'), ...data }))
  db.task.findMany.mockResolvedValue([])
  db.task.findFirst.mockResolvedValue(null)
  db.task.create.mockImplementation(async ({ data }: any) => ({ id: 'task-1', created_at: new Date('2026-08-11T00:00:00Z'), ...data }))
})

describe('PPE ceremony idempotency', () => {
  it('returns the original sprint, PBI, story and task on identical keyed replay', async () => {
    const sprintObject = objectKey('sprint')
    const sprintRequest = { product_id: 'product-1', code: 'B5-SPRINT', sprint_goal: 'B5', start_date: '2026-08-11', ceremony_object_key: sprintObject }
    const sprintPpe = ppe(ceremonyKey('sprint', sprintObject), 'CEREMONY_SPRINT', sprintRequest, 'product:product-1')
    const sprintInput = { ...sprintRequest, ppe: sprintPpe }
    const sprintFirst = await handleCreateSprint(sprintInput)
    const sprintReplay = await handleCreateSprint(sprintInput)
    expect(text(sprintReplay)).toBe(text(sprintFirst))
    expect(db.sprint.create).toHaveBeenCalledTimes(1)

    const pbiObject = objectKey('pbi')
    const pbiRequest = { product_id: 'product-1', title: 'B5 PBI', description: null, priority: 1, source_docs: null, ceremony_object_key: pbiObject }
    const pbiPpe = ppe(ceremonyKey('pbi', pbiObject), 'CEREMONY_PBI', pbiRequest, 'product:product-1')
    const pbiFirst = await handleCreatePbi({ product_id: 'product-1', title: 'B5 PBI', priority: 1, ceremony_object_key: pbiObject, ppe: pbiPpe })
    const pbiReplay = await handleCreatePbi({ product_id: 'product-1', title: 'B5 PBI', priority: 1, ceremony_object_key: pbiObject, ppe: pbiPpe })
    expect(text(pbiReplay)).toBe(text(pbiFirst))
    expect(db.pbi.create).toHaveBeenCalledTimes(1)

    db.pbi.findUnique = vi.fn().mockResolvedValue({ product_id: 'product-1' })
    db.sprint.findUnique = vi.fn().mockResolvedValue({ product_id: 'product-1' })
    const storyObject = objectKey('story')
    const storyRequest = { pbi_id: 'pbi-1', title: 'B5 Story', description: null, acceptance_criteria: null, priority: 1, sprint_id: 'sprint-1', ceremony_object_key: storyObject }
    const storyPpe = ppe(ceremonyKey('story', storyObject), 'CEREMONY_STORY', storyRequest, 'product:product-1')
    const storyInput = { pbi_id: 'pbi-1', title: 'B5 Story', priority: 1, sprint_id: 'sprint-1', ceremony_object_key: storyObject, ppe: storyPpe }
    const storyFirst = await handleCreateStory(storyInput)
    const storyReplay = await handleCreateStory(storyInput)
    expect(text(storyReplay)).toBe(text(storyFirst))
    expect(db.story.create).toHaveBeenCalledTimes(1)

    const taskObject = objectKey('task')
    const taskRequest = { story_id: 'story-1', title: 'B5 Task', description: null, implementation_plan: null, priority: 1, repo_url: null, ceremony_object_key: taskObject }
    const taskPpe = ppe(ceremonyKey('task', taskObject), 'CEREMONY_TASK', taskRequest, 'product:product-1')
    const taskInput = { story_id: 'story-1', title: 'B5 Task', priority: 1, ceremony_object_key: taskObject, ppe: taskPpe }
    const taskFirst = await handleCreateTask(taskInput)
    const taskReplay = await handleCreateTask(taskInput)
    expect(text(taskReplay)).toBe(text(taskFirst))
    expect(db.task.create).toHaveBeenCalledTimes(1)
  })

  it('rejects changed reuse, a stale generation and the wrong principal before mutation', async () => {
    const stable = objectKey('sprint')
    const operationKey = ceremonyKey('sprint', stable)
    const originalRequest = { product_id: 'product-1', code: 'B5-ORIGINAL', sprint_goal: 'Original', start_date: '2026-08-11', ceremony_object_key: stable }
    await handleCreateSprint({ ...originalRequest, ppe: ppe(operationKey, 'CEREMONY_SPRINT', originalRequest, 'product:product-1') })

    const changedRequest = { ...originalRequest, sprint_goal: 'Changed' }
    const changed = await handleCreateSprint({ ...changedRequest, ppe: ppe(operationKey, 'CEREMONY_SPRINT', changedRequest, 'product:product-1') })
    expect(text(changed)).toContain('PPE_OPERATION_KEY_REUSE')

    const staleStable = objectKey('sprint')
    const staleRequest = { product_id: 'product-1', code: 'B5-STALE', sprint_goal: 'Stale', start_date: '2026-08-11', ceremony_object_key: staleStable }
    const stalePpe = { ...ppe(ceremonyKey('sprint', staleStable), 'CEREMONY_SPRINT', staleRequest, 'product:product-1'), orchestrator_generation: 2 }
    expect(text(await handleCreateSprint({ ...staleRequest, ppe: stalePpe }))).toContain('PPE_CONTROLLER_FENCE')

    const wrongStable = objectKey('sprint')
    const wrongRequest = { product_id: 'product-1', code: 'B5-WRONG', sprint_goal: 'Wrong', start_date: '2026-08-11', ceremony_object_key: wrongStable }
    const wrongPpe = { ...ppe(ceremonyKey('sprint', wrongStable), 'CEREMONY_SPRINT', wrongRequest, 'product:product-1'), orchestrator_id: 'orchestrator:wrong' }
    expect(text(await handleCreateSprint({ ...wrongRequest, ppe: wrongPpe }))).toContain('PPE_CONTROLLER_FENCE')
    expect(db.sprint.create).toHaveBeenCalledTimes(1)
  })

  it('requires durable reviewed-plan authority and forbids a JP-start receipt during composition', async () => {
    const stable = objectKey('sprint')
    const request = { product_id: 'product-1', code: 'B5-TOPOLOGY', sprint_goal: 'Topology', start_date: '2026-08-11', ceremony_object_key: stable }
    const base = ppe(ceremonyKey('sprint', stable), 'CEREMONY_SPRINT', request, 'product:product-1')
    expect(text(await handleCreateSprint({ ...request, ppe: { ...base, plan_authority_operation_key: 'missing' } }))).toContain('PPE_PLAN_AUTHORITY')
    expect(text(await handleCreateSprint({ ...request, ppe: { ...base, jp_start_operation_key: 'jp-start:too-early' } }))).toContain('PPE_CEREMONY_TOPOLOGY')
    expect(db.sprint.create).not.toHaveBeenCalled()
  })
})
