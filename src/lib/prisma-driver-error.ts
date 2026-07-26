// Prisma 7 + @prisma/adapter-pg report Postgres failures through a
// DriverAdapterError instead of the engine-filled fields older code matched on:
//
//   23505 → PrismaClientKnownRequestError P2002, but `meta.target` is absent;
//           the columns sit in meta.driverAdapterError.cause.constraint.fields
//   40001 → raised inside the callback: P2034 as before;
//           raised at COMMIT: no P2002/P2034 wrapper at all — the bare
//           DriverAdapterError escapes `$transaction`
//
// Both wrappings carry the SQLSTATE in `cause.originalCode`, so that is what
// the retry predicates key on. Matching the old shapes silently matched
// nothing, which turned every bounded retry into a single attempt.

export const UNIQUE_VIOLATION = '23505'
export const SERIALIZATION_FAILURE = '40001'

export type DriverAdapterCause = {
  originalCode: string
  originalMessage?: string
  kind?: string
  constraint?: { fields?: string[]; index?: string }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function causeWithSqlState(value: unknown): DriverAdapterCause | undefined {
  const cause = asRecord(asRecord(value)?.cause)
  return typeof cause?.originalCode === 'string' ? (cause as DriverAdapterCause) : undefined
}

/**
 * The driver-adapter cause of `error`, whether it escaped bare or arrived
 * wrapped in a PrismaClientKnownRequestError.
 */
export function driverAdapterCause(error: unknown): DriverAdapterCause | undefined {
  return (
    causeWithSqlState(error) ??
    causeWithSqlState(asRecord(asRecord(error)?.meta)?.driverAdapterError)
  )
}
