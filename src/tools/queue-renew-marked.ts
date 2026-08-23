import { createHash, timingSafeEqual } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { requireWriteAccess } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'
import { prisma } from '../prisma.js'
import {
  consumerAuthoritySchema, lockConsumerAuthority, type ConsumerAuthority, type MarkedTx,
} from './queue-register-consumer.js'

export const leaseSchema = consumerAuthoritySchema.extend({
  message_id: z.string().uuid(),
  lease_generation: z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)]),
  claim_token: z.string().min(1),
})
export type LeaseInput = z.infer<typeof leaseSchema>

type LeaseRow = { token_sha256: string }
export async function lockMarkedLease(tx: MarkedTx, input: LeaseInput): Promise<void> {
  await lockConsumerAuthority(tx, input as ConsumerAuthority)
  const messages = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM agent_message
      WHERE id=$1 AND status='claimed' AND ppe_run_id=$2
        AND ppe_to_consumer_id=$3 AND ppe_consumer_generation=$4
        AND ppe_lease_generation=$5 FOR UPDATE`,
    input.message_id, input.run_id, input.consumer_id,
    input.consumer_generation, BigInt(input.lease_generation),
  )
  if (!messages[0]) throw new Error('PPE_CLAIM_FENCE')
  const rows = await tx.$queryRawUnsafe<LeaseRow[]>(
    `SELECT token_sha256 FROM ppe_claim_lease
      WHERE message_id=$1 AND run_id=$2 AND consumer_id=$3
        AND consumer_generation=$4 AND lease_generation=$5 AND status='CURRENT'
      FOR UPDATE`, input.message_id, input.run_id, input.consumer_id,
    input.consumer_generation, BigInt(input.lease_generation),
  )
  const actual = createHash('sha256').update(input.claim_token).digest()
  const stored = rows[0] ? Buffer.from(rows[0].token_sha256, 'hex') : Buffer.alloc(0)
  if (stored.length !== actual.length || !timingSafeEqual(stored, actual)) {
    throw new Error('PPE_CLAIM_FENCE')
  }
}

export async function renewMarkedMessage(input: LeaseInput): Promise<boolean> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockMarkedLease(tx, input)
    const changed = await tx.$executeRawUnsafe(
      `UPDATE ppe_claim_lease SET renewed_at=now(),updated_at=now()
        WHERE message_id=$1 AND lease_generation=$2 AND status='CURRENT'`,
      input.message_id, BigInt(input.lease_generation),
    )
    if (changed !== 1) throw new Error('PPE_CLAIM_FENCE')
    return true
  })
}

export function registerQueueRenewMarkedTool(server: McpServer): void {
  server.registerTool('queue_renew_marked', {
    title: 'Renew marked claim',
    description: 'Renew only the exact opaque-token marked lease under all generation fences.',
    inputSchema: leaseSchema,
  }, async (raw) => withToolErrors(async () => {
    await requireWriteAccess()
    return toolJson({ renewed: await renewMarkedMessage(leaseSchema.parse(raw)) })
  }))
}
