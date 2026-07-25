// Claim primitives for the s4m-queue tools (spec §5.2/§5.3).
// Pattern: FOR UPDATE SKIP LOCKED CTE inside an interactive Prisma transaction
// with pg_notify INSIDE the transaction (fires at COMMIT) — same consensus as
// pg-boss/Graphile Worker/River/Oban: NOTIFY is wake-up only, the claim query
// is the single source of truth.
import { prisma } from '../prisma.js'
import { QUEUE_CHANNEL, envelopeOf } from './notify.js'
import { QUEUE_REQUEST_TYPES, QUEUE_RESPONSE_TYPES, type QueueModel, type QueueServer } from '@shared/queue-identity.js'

export const DEFAULT_RECLAIM_AFTER = '4 hours'

/** Same semantics as s4m-queue/src/config.ts: env override with interval sanity check. */
export function reclaimInterval(): string {
  const fromEnv = process.env.S4M_RECLAIM_DEFAULT?.trim()
  if (fromEnv && /^[0-9 a-zA-Z.:-]+$/.test(fromEnv)) return fromEnv
  return DEFAULT_RECLAIM_AFTER
}

export interface AgentMessageRecord {
  id: string
  type: string
  from_server: string
  from_model: string
  to_server: string
  to_model: string
  body: string
  meta: Record<string, unknown>
  source: string
  status: string
  in_reply_to: string | null
  error: string | null
  claimed_by: string | null
  claimed_at: Date | null
  started_at: Date | null
  finished_at: Date | null
  created_at: Date
}

export interface ClaimedAgentMessage extends AgentMessageRecord {
  previous_status: string
}

export async function claimNextRequest(opts: {
  server: QueueServer
  model: QueueModel
  claimedBy: string
}): Promise<ClaimedAgentMessage | null> {
  const reclaim = reclaimInterval()
  const types = [...QUEUE_REQUEST_TYPES]
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimedAgentMessage[]>`
      WITH target AS (
        SELECT id, status FROM agent_message
         WHERE to_server = ${opts.server} AND to_model = ${opts.model}
           AND type = ANY(${types}::text[])
           AND (status = 'pending'
                OR (status = 'claimed' AND claimed_at < now() - ${reclaim}::interval))
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      ),
      updated AS (
        UPDATE agent_message
           SET status = 'claimed', claimed_by = ${opts.claimedBy},
               claimed_at = now(), started_at = now()
         WHERE id IN (SELECT id FROM target)
         RETURNING *
      )
      SELECT updated.*, target.status AS previous_status
        FROM updated JOIN target ON updated.id = target.id
    `
    const row = rows[0]
    if (!row) return null
    const payload = JSON.stringify(envelopeOf(row, row.previous_status))
    await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${payload})`
    return row
  })
}

export async function claimNextReply(opts: {
  server: QueueServer
  model: QueueModel
  messageIds: string[]
  claimedBy: string
}): Promise<ClaimedAgentMessage | null> {
  const reclaim = reclaimInterval()
  const types = [...QUEUE_RESPONSE_TYPES]
  return prisma.$transaction(async (tx) => {
    // §5.2: claim + auto-ack in ONE transaction — reading is processing; the
    // row itself stays (status done) for audit/queue_status and the idempotent
    // read. The correlation filter lives IN the WHERE clause: a session can
    // only ever claim replies to its own request handles.
    const rows = await tx.$queryRaw<ClaimedAgentMessage[]>`
      WITH target AS (
        SELECT id, status FROM agent_message
         WHERE to_server = ${opts.server} AND to_model = ${opts.model}
           AND type = ANY(${types}::text[])
           AND in_reply_to = ANY(${opts.messageIds}::uuid[])
           AND (status = 'pending'
                OR (status = 'claimed' AND claimed_at < now() - ${reclaim}::interval))
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      ),
      updated AS (
        UPDATE agent_message
           SET status = 'done', claimed_by = ${opts.claimedBy},
               claimed_at = now(), started_at = now(), finished_at = now()
         WHERE id IN (SELECT id FROM target)
         RETURNING *
      )
      SELECT updated.*, target.status AS previous_status
        FROM updated JOIN target ON updated.id = target.id
    `
    const row = rows[0]
    if (!row) return null
    const payload = JSON.stringify(envelopeOf(row, row.previous_status))
    await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${payload})`
    return row
  })
}

/** MCP-cancel after a queue_next claim (§7): claimed → pending, exact-owner only. */
export async function rollbackQueueClaim(messageId: string, claimedBy: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<AgentMessageRecord[]>`
      UPDATE agent_message
         SET status = 'pending', claimed_by = NULL, claimed_at = NULL, started_at = NULL
       WHERE id = ${messageId}::uuid
         AND status = 'claimed' AND claimed_by = ${claimedBy}
       RETURNING *
    `
    const row = rows[0]
    if (!row) return
    const payload = JSON.stringify(envelopeOf(row, 'claimed'))
    await tx.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${payload})`
  })
}
