// Presentation shape shared by queue_status / queue_list / queue_next /
// queue_wait_reply. Structural input type so both Prisma model rows and raw
// AgentMessageRecord rows fit without casts.

export interface QueueMessageLike {
  id: string
  type: string
  from_server: string
  from_model: string
  to_server: string
  to_model: string
  body: string
  meta: unknown
  status: string
  in_reply_to: string | null
  error: string | null
  claimed_by: string | null
  archived_at: Date | null
  created_at: Date
  finished_at: Date | null
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

import { assertLegacyQueueRow } from './marked.js'

export function messageView(row: QueueMessageLike) {
  assertLegacyQueueRow(row as unknown as Record<string, unknown>)
  return {
    id: row.id,
    type: row.type,
    from: `${row.from_server}:${row.from_model}`,
    to: `${row.to_server}:${row.to_model}`,
    status: row.status,
    body: row.body,
    meta: row.meta,
    in_reply_to: row.in_reply_to,
    error: row.error,
    claimed_by: row.claimed_by,
    archived_at: row.archived_at,
    created_at: row.created_at,
    finished_at: row.finished_at,
  }
}
