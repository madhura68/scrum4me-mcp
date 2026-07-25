// NotifyEnvelope for the s4m-queue channel — byte-compatible with
// s4m-queue/src/db.ts envelopeOf(): same fields, same order.
// CLI --wait and the Messages-dashboard parse this payload unchanged.
import { prisma } from '../prisma.js'

export const QUEUE_CHANNEL = 'agent_queue'

export interface QueueMessageRow {
  id: string
  type: string
  from_server: string
  from_model: string
  to_server: string
  to_model: string
  in_reply_to: string | null
  status: string
}

export interface QueueNotifyEnvelope {
  id: string
  type: string
  from_server: string
  from_model: string
  to_server: string
  to_model: string
  in_reply_to: string | null
  status: string
  previous_status: string | null
}

export function envelopeOf(
  m: QueueMessageRow,
  previousStatus: string | null,
): QueueNotifyEnvelope {
  return {
    id: m.id,
    type: m.type,
    from_server: m.from_server,
    from_model: m.from_model,
    to_server: m.to_server,
    to_model: m.to_model,
    in_reply_to: m.in_reply_to,
    status: m.status,
    previous_status: previousStatus,
  }
}

/**
 * Best-effort NOTIFY for already-committed rows (queue_push). A failing notify
 * must never surface as a tool error (§7; same convention as notifyJobEnqueued
 * in src/lib/dispatch/notify.ts) — LISTEN consumers have a 5 s poll safety net.
 */
export async function emitQueueNotifyBestEffort(envelope: QueueNotifyEnvelope): Promise<void> {
  try {
    const payload = JSON.stringify(envelope)
    await prisma.$executeRaw`SELECT pg_notify(${QUEUE_CHANNEL}, ${payload}::text)`
  } catch (err) {
    console.error('[scrum4me-mcp] queue notify failed (row is already committed):', err)
  }
}
