// NotifyEnvelope for the s4m-queue channel — byte-compatible with
// s4m-queue/src/db.ts envelopeOf(): same fields, same order.
// CLI --wait and the Messages-dashboard parse this payload unchanged.
import { prisma } from '../prisma.js'
import { assertLegacyQueueRow } from './marked.js'

// Het kanaal ligt hier vast op de CLI-default. De CLI leest het uit
// S4M_QUEUE_CHANNEL (s4m-queue/src/config.ts) en kán dus afwijken; dat wordt
// vandaag nergens gezet, en scrum4me-workers hardcodeert dezelfde waarde.
// Wie die env-var ooit wél zet, krijgt een stil dood kanaal: de MCP notify't
// op 'agent_queue' terwijl de CLI ergens anders luistert, zonder foutmelding.
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
  ppe_protocol?: string | null
  ppe_run_id?: string | null
  ppe_operation_key?: string | null
  ppe_payload_sha256?: string | null
  ppe_from_principal?: string | null
  ppe_to_principal?: string | null
  ppe_to_consumer_id?: string | null
  ppe_consumer_generation?: number | null
  ppe_lease_generation?: bigint | number | null
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
  assertLegacyQueueRow(m as unknown as Record<string, unknown>)
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
