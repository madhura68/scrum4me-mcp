import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DispatchProfileConfig } from '@shared/queue-dispatch.js'
import type { DispatchStore } from './db.js'

/** The wire protocol this build speaks, typed against the shared contract: a protocol bump in
 * scrum4me-shared fails the typecheck here instead of silently advertising the old name. */
export const DISPATCH_PROTOCOL: DispatchProfileConfig['protocol'] = 'dispatch-v1'

/** The durable dispatch schema. `schema_ready` is false unless the running role can see all of it. */
export const DISPATCH_SCHEMA_TABLES = [
  'queue_dispatch_artifacts', 'queue_dispatch_attempts', 'queue_dispatch_candidates',
  'queue_dispatch_events', 'queue_dispatch_incarnations', 'queue_dispatch_outbox',
  'queue_dispatch_profiles', 'queue_dispatch_publications', 'queue_dispatch_reply_addresses',
  'queue_dispatch_requests', 'queue_dispatch_reservations', 'queue_dispatch_results',
  'queue_dispatch_slot_profiles', 'queue_dispatch_slots',
] as const

/** The contract role of the service connection. The preflight proves the same thing from the
 * other side: the dispatch connection is this role and carries none of the elevated flags. */
export const DISPATCH_DB_ROLE = 'scrum4me_dispatch'

/** How long one probe result is reused. The route is unauthenticated, so an unbounded caller
 * must not be able to turn it into one database round trip per request. */
export const DISPATCH_HEALTH_TTL_MS = 1000

function readPackageVersion(): string {
  try {
    // src/dispatch/health.ts → src/dispatch → src → repo root
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
    return (JSON.parse(readFileSync(path, 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch { return '0.0.0' }
}
export const DISPATCH_SERVICE_VERSION = readPackageVersion()

/** Deliberately four fields and no more: no credentials, no DSN, no product, request or actor
 * data, and no error text. Everything here is a fact about this build and its own connection. */
export type DispatchHealth = {
  version: string; protocol: typeof DISPATCH_PROTOCOL; schema_ready: boolean; role_ready: boolean
}

export function createDispatchHealth(deps: { store: DispatchStore; now?: () => number; ttlMs?: number }) {
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? DISPATCH_HEALTH_TTL_MS
  let cached: { at: number; value: DispatchHealth } | null = null

  /** One read-only statement, no transaction, no writes. `information_schema.tables` only lists
   * what this role may actually use, so it answers schema presence and its grants at once. */
  async function probe(): Promise<DispatchHealth> {
    const base = { version: DISPATCH_SERVICE_VERSION, protocol: DISPATCH_PROTOCOL }
    try {
      const row = (await deps.store.query<{ tables: number; role: string; elevated: boolean | null }>(
        `SELECT (SELECT count(*) FROM information_schema.tables
                 WHERE table_schema='public' AND table_name=ANY($1::text[]))::int AS tables,
                current_user AS role,
                (SELECT bool_or(rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)
                 FROM pg_roles WHERE rolname=current_user) AS elevated`,
        [[...DISPATCH_SCHEMA_TABLES]])).rows[0]
      return {
        ...base,
        schema_ready: row?.tables === DISPATCH_SCHEMA_TABLES.length,
        role_ready: row?.role === DISPATCH_DB_ROLE && row.elevated === false,
      }
    } catch {
      // A database that cannot be reached, or a role that may not read this, is simply not ready.
      return { ...base, schema_ready: false, role_ready: false }
    }
  }
  return {
    async readiness(): Promise<DispatchHealth> {
      const at = now()
      if (cached && at - cached.at < ttlMs) return cached.value
      const value = await probe()
      cached = { at, value }
      return value
    },
  }
}
