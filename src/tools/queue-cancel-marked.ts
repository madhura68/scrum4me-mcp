import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { requireWriteAccess } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'
import { prisma } from '../prisma.js'
import { consumerAuthoritySchema, lockConsumerAuthority } from './queue-register-consumer.js'
import { leaseSchema, lockMarkedLease } from './queue-renew-marked.js'

const pendingSchema = consumerAuthoritySchema.extend({
  message_id: z.string().uuid(),
  expected_status: z.literal('pending'),
})
const claimedSchema = leaseSchema.extend({ expected_status: z.literal('claimed') })
const cancelSchema = z.discriminatedUnion('expected_status', [pendingSchema, claimedSchema])
type CancelInput = z.infer<typeof cancelSchema>

type MessageState = {
  status: string
  ppe_run_id: string
  ppe_to_consumer_id: string
  ppe_consumer_generation: number
  ppe_lease_generation: bigint | null
}

export async function cancelMarkedMessage(input: CancelInput): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockConsumerAuthority(tx, input)
    const rows = await tx.$queryRawUnsafe<MessageState[]>(
      `SELECT status,ppe_run_id,ppe_to_consumer_id,ppe_consumer_generation,ppe_lease_generation
         FROM agent_message WHERE id=$1 AND ppe_protocol='parallel-plan-execution/v1'
         FOR UPDATE`, input.message_id,
    )
    const row = rows[0]
    if (!row || row.status !== input.expected_status || row.ppe_run_id !== input.run_id
      || row.ppe_to_consumer_id !== input.consumer_id
      || row.ppe_consumer_generation !== input.consumer_generation) {
      throw new Error('PPE_CONSUMER_FENCE')
    }
    if (input.expected_status === 'pending') {
      if (row.ppe_lease_generation !== null) throw new Error('PPE_CLAIM_FENCE')
      const changed = await tx.$executeRawUnsafe(
        `UPDATE agent_message SET status='cancelled',finished_at=now()
          WHERE id=$1 AND status='pending' AND ppe_lease_generation IS NULL`, input.message_id,
      )
      if (changed !== 1) throw new Error('PPE_CONSUMER_FENCE')
      return true
    }
    if (row.ppe_lease_generation !== BigInt(input.lease_generation)) throw new Error('PPE_CLAIM_FENCE')
    await lockMarkedLease(tx, input)
    const lease = await tx.$executeRawUnsafe(
      `UPDATE ppe_claim_lease SET status='CANCELLED',finished_at=now(),updated_at=now()
        WHERE message_id=$1 AND lease_generation=$2 AND status='CURRENT'`,
      input.message_id, BigInt(input.lease_generation),
    )
    const message = await tx.$executeRawUnsafe(
      `UPDATE agent_message SET status='cancelled',finished_at=now()
        WHERE id=$1 AND status='claimed' AND ppe_lease_generation=$2`,
      input.message_id, BigInt(input.lease_generation),
    )
    if (lease !== 1 || message !== 1) throw new Error('PPE_CLAIM_FENCE')
    return true
  })
}

export function registerQueueCancelMarkedTool(server: McpServer): void {
  server.registerTool('queue_cancel_marked', {
    title: 'Cancel marked request',
    description: 'Cancel pending without a token or claimed with the exact marked lease token.',
    inputSchema: cancelSchema,
  }, async (raw) => withToolErrors(async () => {
    await requireWriteAccess()
    return toolJson({ cancelled: await cancelMarkedMessage(cancelSchema.parse(raw)) })
  }))
}
