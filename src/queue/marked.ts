import { Prisma } from '@prisma/client'

export const MARKER_COLUMNS = [
  'ppe_protocol', 'ppe_run_id', 'ppe_operation_key', 'ppe_payload_sha256',
  'ppe_from_principal', 'ppe_to_principal', 'ppe_to_consumer_id',
  'ppe_consumer_generation', 'ppe_lease_generation',
] as const

export const LEGACY_MARKER_SQL = Prisma.sql`
  ppe_protocol IS NULL
  AND ppe_run_id IS NULL
  AND ppe_operation_key IS NULL
  AND ppe_payload_sha256 IS NULL
  AND ppe_from_principal IS NULL
  AND ppe_to_principal IS NULL
  AND ppe_to_consumer_id IS NULL
  AND ppe_consumer_generation IS NULL
  AND ppe_lease_generation IS NULL
`

export function legacyMarkerWhere(): Record<(typeof MARKER_COLUMNS)[number], null> {
  return Object.fromEntries(MARKER_COLUMNS.map((column) => [column, null])) as
    Record<(typeof MARKER_COLUMNS)[number], null>
}
export function assertLegacyQueueRow<T extends Record<string, unknown>>(row: T): T {
  if (MARKER_COLUMNS.some((column) => row[column] !== null && row[column] !== undefined)) {
    throw new Error('PPE_LEGACY_ROUTE_REJECTED')
  }
  return row
}
