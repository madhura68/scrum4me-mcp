import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { requireWriteAccess } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'
import { prisma } from '../prisma.js'

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/)
const authoritySchema = z.object({
  run_id: z.string().uuid(),
  run_generation: z.number().int().min(1).max(3),
  orchestrator_generation: z.number().int().positive(),
  fence_sha256: hashSchema,
})
export const consumerAuthoritySchema = authoritySchema.extend({
  consumer_id: z.string().uuid(),
  consumer_generation: z.number().int().min(1).max(3),
})
export type ConsumerAuthority = z.infer<typeof consumerAuthoritySchema>

const registerSchema = authoritySchema.extend({
  lane: z.enum(['lane-claude', 'lane-codex']),
  generation: z.number().int().min(1).max(4),
  operation_key: z.string().min(1),
  config_sha256: hashSchema,
  attestation_sha256: hashSchema,
})
type RegisterInput = z.infer<typeof registerSchema>

export type MarkedTx = Prisma.TransactionClient
type AuthorityRow = {
  run_generation: number
  run_state: string
  principal: string
  orchestrator_generation: number
  owner_principal: string
  lease_expires_at: Date
  fence_sha256: string
  consumer_generation?: number
  consumer_status?: string
}
type ConsumerRow = {
  consumer_id: string
  run_id: string
  lane: string
  generation: number
  operation_key: string
  config_sha256: string
  attestation_sha256: string
  status: string
}

function assertRunAuthority(row: AuthorityRow | undefined, input: z.infer<typeof authoritySchema>): void {
  if (!row || row.run_state !== 'ACTIVE' || row.run_generation !== input.run_generation) {
    throw new Error('PPE_RUN_FENCE')
  }
  if (row.orchestrator_generation !== input.orchestrator_generation
    || row.owner_principal !== row.principal
    || row.principal !== `orchestrator:${input.run_id}`
    || row.lease_expires_at.getTime() <= Date.now()) throw new Error('PPE_ORCHESTRATOR_FENCE')
  if (row.fence_sha256 !== input.fence_sha256) throw new Error('PPE_FENCE_MISMATCH')
}

export async function lockConsumerAuthority(tx: MarkedTx, input: ConsumerAuthority): Promise<void> {
  const rows = await tx.$queryRawUnsafe<AuthorityRow[]>(
    `SELECT r.generation AS run_generation,r.state AS run_state,r.principal,
            o.generation AS orchestrator_generation,o.owner_principal,
            o.lease_expires_at,o.fence_sha256,c.generation AS consumer_generation,
            c.status AS consumer_status
       FROM ppe_run_registry r
       JOIN ppe_orchestrator_lease o ON o.run_id=r.run_id AND o.status='CURRENT'
       JOIN ppe_consumer c ON c.run_id=r.run_id AND c.consumer_id=$2
      WHERE r.run_id=$1 FOR UPDATE OF r,o,c`, input.run_id, input.consumer_id,
  )
  assertRunAuthority(rows[0], input)
  if (rows[0]?.consumer_generation !== input.consumer_generation
    || rows[0]?.consumer_status !== 'READY_ACK') throw new Error('PPE_CONSUMER_FENCE')
}

export async function registerMarkedConsumer(input: RegisterInput): Promise<ConsumerRow> {
  if (input.generation === 4) throw new Error('PPE_CONSUMER_GENERATION_EXHAUSTED')
  return prisma.$transaction(async (tx) => {
    const replay = await tx.$queryRawUnsafe<ConsumerRow[]>(
      'SELECT * FROM ppe_consumer WHERE operation_key=$1 FOR UPDATE', input.operation_key,
    )
    if (replay[0]) {
      const row = replay[0]
      if (row.run_id !== input.run_id || row.lane !== input.lane
        || row.generation !== input.generation || row.config_sha256 !== input.config_sha256
        || row.attestation_sha256 !== input.attestation_sha256) {
        throw new Error('PPE_OPERATION_KEY_REUSE')
      }
      return row
    }
    const authority = await tx.$queryRawUnsafe<AuthorityRow[]>(
      `SELECT r.generation AS run_generation,r.state AS run_state,r.principal,
              o.generation AS orchestrator_generation,o.owner_principal,
              o.lease_expires_at,o.fence_sha256
         FROM ppe_run_registry r
         JOIN ppe_orchestrator_lease o ON o.run_id=r.run_id AND o.status='CURRENT'
        WHERE r.run_id=$1 FOR UPDATE OF r,o`, input.run_id,
    )
    assertRunAuthority(authority[0], input)
    const prior = await tx.$queryRawUnsafe<Array<{ generation: number; status: string }>>(
      `SELECT generation,status FROM ppe_consumer WHERE run_id=$1 AND lane=$2
        ORDER BY generation DESC LIMIT 1 FOR UPDATE`, input.run_id, input.lane,
    )
    if ((!prior[0] && input.generation !== 1)
      || (prior[0] && (prior[0].generation + 1 !== input.generation || prior[0].status !== 'RETIRED'))) {
      if (prior[0]?.generation === 3) throw new Error('PPE_CONSUMER_GENERATION_EXHAUSTED')
      throw new Error('PPE_CONSUMER_GENERATION_FENCE')
    }
    const consumerId = randomUUID()
    await tx.$executeRawUnsafe(
      `INSERT INTO ppe_consumer
        (consumer_id,run_id,lane,generation,operation_key,config_sha256,
         attestation_sha256,status,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'REGISTER_INTENT',now())`,
      consumerId, input.run_id, input.lane, input.generation, input.operation_key,
      input.config_sha256, input.attestation_sha256,
    )
    const ready = await tx.$queryRawUnsafe<ConsumerRow[]>(
      `UPDATE ppe_consumer SET status='READY_ACK',heartbeat_at=now(),updated_at=now()
        WHERE consumer_id=$1 AND status='REGISTER_INTENT' RETURNING *`, consumerId,
    )
    if (!ready[0]) throw new Error('PPE_CONSUMER_READY_CAS')
    return ready[0]
  })
}

export function registerQueueRegisterConsumerTool(server: McpServer): void {
  server.registerTool('queue_register_consumer', {
    title: 'Register marked consumer',
    description: 'Register one fenced lane consumer generation and atomically acknowledge readiness.',
    inputSchema: registerSchema,
  }, async (raw) => withToolErrors(async () => {
    await requireWriteAccess()
    const input = registerSchema.parse(raw)
    const row = await registerMarkedConsumer(input)
    return toolJson({ consumer_id: row.consumer_id, generation: row.generation, status: row.status })
  }))
}
