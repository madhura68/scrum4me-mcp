import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { z } from 'zod'

const LOWER_SHA256 = /^[0-9a-f]{64}$/

export const ppeInputSchema = z.object({
  run_id: z.string().uuid(),
  orchestrator_id: z.string().min(1),
  orchestrator_generation: z.number().int().positive(),
  operation_key: z.string().min(1),
  payload_hash: z.string().regex(LOWER_SHA256),
  plan_authority_operation_key: z.string().min(1),
  jp_start_operation_key: z.string().min(1).optional(),
}).strict()

export type PpeMutationInput = z.infer<typeof ppeInputSchema>

export interface FencedMutation<T> {
  runId: string
  orchestratorId: string
  orchestratorGeneration: number
  operationKey: string
  payloadHash: string
  payload: T
}

export type PpeAuthorityRequirement = 'ceremony' | 'composition' | 'execution'

interface OperationReceiptRow {
  run_id: string
  operation_key: string
  payload_sha256: string
  kind: string
  status: string
  receipt_json: unknown
  receipt_sha256: string
}

interface OperationReceiptV1 {
  version: 'operation-receipt-v1'
  run_id: string
  operation_key: string
  payload_sha256: string
  kind: string
  status: 'COMMITTED'
  payload: unknown
  result: unknown
}

function assertUnicodeScalar(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('PPE_JCS_INVALID_UNICODE')
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('PPE_JCS_INVALID_UNICODE')
    }
  }
}

export function canonicalizePpeJcs(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') {
    assertUnicodeScalar(value)
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      if (Object.is(value, -0)) return '0'
      throw new Error('PPE_JCS_UNSUPPORTED_NUMBER')
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error('PPE_JCS_UNSUPPORTED_NUMBER')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizePpeJcs).join(',')}]`
  if (typeof value !== 'object' || value === undefined) throw new Error('PPE_JCS_UNSUPPORTED_VALUE')

  const record = value as Record<string, unknown>
  const prototype = Object.getPrototypeOf(record)
  if (prototype !== Object.prototype && prototype !== null) throw new Error('PPE_JCS_UNSUPPORTED_VALUE')
  const entries = Object.keys(record).sort().map((key) => {
    assertUnicodeScalar(key)
    if (record[key] === undefined) throw new Error('PPE_JCS_UNSUPPORTED_VALUE')
    return `${JSON.stringify(key)}:${canonicalizePpeJcs(record[key])}`
  })
  return `{${entries.join(',')}}`
}

export function sha256PpeJcs(value: unknown): string {
  return createHash('sha256').update(canonicalizePpeJcs(value)).digest('hex')
}

export function sha256PpeBytes(value: string | null): string {
  return createHash('sha256').update(value ?? '').digest('hex')
}

export function buildPpeOperationPayload(
  operationKey: string,
  operationKind: string,
  request: unknown,
  targetScope: string,
) {
  return {
    operation_key: operationKey,
    operation_kind: operationKind,
    request,
    target_scope: targetScope,
    version: 'operation-payload-v1' as const,
  }
}

export function ceremonyOperationKey(runId: string, kind: 'sprint' | 'pbi' | 'story' | 'task', objectKey: string): string {
  if (!objectKey) throw new Error('PPE_CEREMONY_OBJECT_KEY')
  return `ceremony:${runId}:${kind}:${createHash('sha256').update(objectKey).digest('hex')}`
}

export function assertCeremonyOperationKey(
  ppe: PpeMutationInput,
  kind: 'sprint' | 'pbi' | 'story' | 'task',
  objectKey: string,
): void {
  if (ppe.operation_key !== ceremonyOperationKey(ppe.run_id, kind, objectKey)) {
    throw new Error('PPE_CEREMONY_OBJECT_KEY')
  }
}

const LOG_KIND_TO_OPERATION = {
  implementation: 'LOG_IMPLEMENTATION',
  commit: 'LOG_COMMIT',
  'test-result': 'LOG_TEST_RESULT',
} as const

export function assertLogOperationKey(
  ppe: PpeMutationInput,
  logKind: keyof typeof LOG_KIND_TO_OPERATION,
  executionKey: string,
): void {
  const slug = '[a-z0-9][a-z0-9._-]*'
  const run = ppe.run_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const execution = executionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const prefix = `log-${logKind}:${run}:${execution}`
  const ordinary = new RegExp(`^${prefix}:attempt:[1-5]$`)
  const nodeRepair = new RegExp(`^${prefix}:node-repair:[0-9a-f]{64}:[1-3]$`)
  const gateRepair = new RegExp(`^${prefix}:gate-repair:${slug}:[0-9a-f]{64}:[1-3]$`)
  if (!new RegExp(`^${slug}$`).test(executionKey)
    || !(ordinary.test(ppe.operation_key) || nodeRepair.test(ppe.operation_key) || gateRepair.test(ppe.operation_key))) {
    throw new Error('PPE_LOG_OPERATION_KEY')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateReceipt(row: OperationReceiptRow): OperationReceiptV1 {
  if (!isRecord(row.receipt_json)) throw new Error('PPE_OPERATION_RECEIPT_CORRUPT')
  const receipt = row.receipt_json as unknown as OperationReceiptV1
  if (receipt.version !== 'operation-receipt-v1'
    || receipt.run_id !== row.run_id
    || receipt.operation_key !== row.operation_key
    || receipt.payload_sha256 !== row.payload_sha256
    || receipt.kind !== row.kind
    || receipt.status !== 'COMMITTED'
    || row.status !== 'COMMITTED'
    || sha256PpeJcs(receipt.payload) !== row.payload_sha256
    || sha256PpeJcs(receipt) !== row.receipt_sha256) {
    throw new Error('PPE_OPERATION_RECEIPT_CORRUPT')
  }
  return receipt
}

async function lookupReceipt(client: Client, runId: string, operationKey: string): Promise<OperationReceiptV1 | null> {
  const rows = await client.query<OperationReceiptRow>(
    `SELECT run_id,operation_key,payload_sha256,kind,status,receipt_json,receipt_sha256
       FROM ppe_operation_receipt WHERE run_id=$1 AND operation_key=$2 FOR UPDATE`,
    [runId, operationKey],
  )
  return rows.rows[0] ? validateReceipt(rows.rows[0]) : null
}

async function assertAuthority(
  client: Client,
  ppe: PpeMutationInput,
  requirement: PpeAuthorityRequirement,
): Promise<void> {
  const plan = await lookupReceipt(client, ppe.run_id, ppe.plan_authority_operation_key)
  if (!plan || plan.kind !== 'COMPOSITION_BOOTSTRAP') throw new Error('PPE_PLAN_AUTHORITY')
  if (!isRecord(plan.result)
    || plan.result.runId !== ppe.run_id
    || plan.result.principal !== ppe.orchestrator_id) throw new Error('PPE_PLAN_AUTHORITY')

  if (requirement === 'ceremony') {
    if (ppe.jp_start_operation_key !== undefined) throw new Error('PPE_CEREMONY_TOPOLOGY')
    return
  }
  if (requirement === 'execution') {
    if (!ppe.jp_start_operation_key
      || ppe.jp_start_operation_key === ppe.plan_authority_operation_key) {
      throw new Error('PPE_JP_START_AUTHORITY')
    }
    const start = await lookupReceipt(client, ppe.run_id, ppe.jp_start_operation_key)
    if (!start || start.kind !== 'JP_START_GATE') throw new Error('PPE_JP_START_AUTHORITY')
  } else if (ppe.jp_start_operation_key !== undefined) {
    const start = await lookupReceipt(client, ppe.run_id, ppe.jp_start_operation_key)
    if (!start || start.kind !== 'JP_START_GATE') throw new Error('PPE_JP_START_AUTHORITY')
  }
}

function controllerDatabaseUrl(): string {
  const value = process.env.PPE_CONTROLLER_DATABASE_URL
  if (!value) throw new Error('PPE_CONTROLLER_DATABASE_URL_MISSING')
  if (value === process.env.DATABASE_URL) throw new Error('PPE_CONTROLLER_DATABASE_ALIAS')
  return value
}

export async function executePpeMutation<T>(input: {
  ppe?: unknown
  operationKind: string
  targetScope: string
  request: unknown
  authority: PpeAuthorityRequirement
  mutate: () => Promise<T>
}): Promise<T> {
  if (input.ppe === undefined) return input.mutate()
  const ppe = ppeInputSchema.parse(input.ppe)
  const payload = buildPpeOperationPayload(
    ppe.operation_key, input.operationKind, input.request, input.targetScope,
  )
  const payloadHash = sha256PpeJcs(payload)
  if (payloadHash !== ppe.payload_hash) throw new Error('PPE_PAYLOAD_HASH')

  const fenced: FencedMutation<typeof payload> = {
    runId: ppe.run_id,
    orchestratorId: ppe.orchestrator_id,
    orchestratorGeneration: ppe.orchestrator_generation,
    operationKey: ppe.operation_key,
    payloadHash,
    payload,
  }
  const client = new Client({ connectionString: controllerDatabaseUrl() })
  await client.connect()
  let committed = false
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [fenced.operationKey])
    const authority = await client.query<{
      principal: string; generation: number; state: string
      owner_principal: string; lease_generation: number; lease_status: string
    }>(
      `SELECT r.principal,r.generation,r.state,o.owner_principal,
              o.generation AS lease_generation,o.status AS lease_status
         FROM ppe_run_registry r
         JOIN ppe_orchestrator_lease o ON o.run_id=r.run_id AND o.status='CURRENT'
        WHERE r.run_id=$1 FOR UPDATE OF r,o`,
      [fenced.runId],
    )
    const current = authority.rows[0]
    if (!current
      || current.state !== 'ACTIVE'
      || current.generation !== fenced.orchestratorGeneration
      || current.lease_generation !== fenced.orchestratorGeneration
      || current.lease_status !== 'CURRENT'
      || current.principal !== fenced.orchestratorId
      || current.owner_principal !== fenced.orchestratorId
      || fenced.orchestratorId !== `orchestrator:${fenced.runId}`) {
      throw new Error('PPE_CONTROLLER_FENCE')
    }

    await assertAuthority(client, ppe, input.authority)
    const replay = await lookupReceipt(client, fenced.runId, fenced.operationKey)
    if (replay) {
      if (replay.payload_sha256 !== fenced.payloadHash || replay.kind !== input.operationKind) {
        throw new Error('PPE_OPERATION_KEY_REUSE')
      }
      await client.query('COMMIT')
      committed = true
      return replay.result as T
    }

    const result = await input.mutate()
    const storedResult = JSON.parse(JSON.stringify(result)) as unknown
    const receipt: OperationReceiptV1 = {
      version: 'operation-receipt-v1',
      run_id: fenced.runId,
      operation_key: fenced.operationKey,
      payload_sha256: fenced.payloadHash,
      kind: input.operationKind,
      status: 'COMMITTED',
      payload: fenced.payload,
      result: storedResult,
    }
    await client.query(
      `INSERT INTO ppe_operation_receipt
        (run_id,operation_key,payload_sha256,kind,status,receipt_json,receipt_sha256,updated_at)
       VALUES ($1,$2,$3,$4,'COMMITTED',$5,$6,now())`,
      [fenced.runId, fenced.operationKey, fenced.payloadHash, input.operationKind,
       JSON.stringify(receipt), sha256PpeJcs(receipt)],
    )
    await client.query('COMMIT')
    committed = true
    return result
  } finally {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined)
    await client.end()
  }
}
