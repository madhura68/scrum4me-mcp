import { createHash, randomBytes } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { requireWriteAccess } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'
import { prisma } from '../prisma.js'
import { consumerAuthoritySchema, lockConsumerAuthority } from './queue-register-consumer.js'

const claimSchema = consumerAuthoritySchema.extend({
  types: z.array(z.enum(['task', 'info', 'review_request'])).min(1),
})
type ClaimInput = z.infer<typeof claimSchema>
type Candidate = { id: string; type: string; body: string; meta: unknown; ppe_operation_key: string }

export async function claimMarkedMessage(input: ClaimInput) {
  return prisma.$transaction(async (tx) => {
    await lockConsumerAuthority(tx, input)
    const candidates = await tx.$queryRawUnsafe<Candidate[]>(
      `SELECT id,type,body,meta,ppe_operation_key FROM agent_message
        WHERE ppe_protocol='parallel-plan-execution/v1' AND ppe_run_id=$1
          AND ppe_from_principal=$2 AND ppe_to_principal IS NULL
          AND ppe_to_consumer_id=$3 AND ppe_consumer_generation=$4
          AND ppe_operation_key IS NOT NULL AND ppe_payload_sha256 IS NOT NULL
          AND ppe_lease_generation IS NULL AND type=ANY($5::text[]) AND status='pending'
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
      input.run_id, `orchestrator:${input.run_id}`, input.consumer_id,
      input.consumer_generation, input.types,
    )
    const message = candidates[0]
    if (!message) return null
    const next = await tx.$queryRawUnsafe<Array<{ lease_generation: bigint }>>(
      `SELECT COALESCE(MAX(lease_generation),0)+1 AS lease_generation
         FROM ppe_claim_lease WHERE message_id=$1`, message.id,
    )
    const leaseGeneration = next[0]?.lease_generation ?? 1n
    const token = randomBytes(32).toString('base64url')
    const tokenSha256 = createHash('sha256').update(token).digest('hex')
    await tx.$executeRawUnsafe(
      `INSERT INTO ppe_claim_lease
        (message_id,run_id,consumer_id,consumer_generation,lease_generation,
         token_sha256,status,claimed_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'CURRENT',now(),now())`,
      message.id, input.run_id, input.consumer_id, input.consumer_generation,
      leaseGeneration, tokenSha256,
    )
    const changed = await tx.$executeRawUnsafe(
      `UPDATE agent_message SET status='claimed',claimed_by=$2,claimed_at=now(),
         ppe_lease_generation=$3
       WHERE id=$1 AND status='pending' AND ppe_run_id=$4
         AND ppe_to_consumer_id=$2 AND ppe_consumer_generation=$5
         AND ppe_lease_generation IS NULL`,
      message.id, input.consumer_id, leaseGeneration, input.run_id, input.consumer_generation,
    )
    if (changed !== 1) throw new Error('PPE_CLAIM_FENCE')
    return { message, claim_token: token, lease_generation: leaseGeneration.toString() }
  })
}

export function registerQueueClaimMarkedTool(server: McpServer): void {
  server.registerTool('queue_claim_marked', {
    title: 'Claim marked request',
    description: 'Claim one complete marked request FIFO with all run/orchestrator/consumer fences.',
    inputSchema: claimSchema,
  }, async (raw) => withToolErrors(async () => {
    await requireWriteAccess()
    return toolJson(await claimMarkedMessage(claimSchema.parse(raw)))
  }))
}
