// Shared Postgres connection settings for every client this process opens.
//
// Two problems this solves, both observed on the shared server on 2026-08-16:
//
//  1. Attribution. The database sat at 100/100 with ~60 connections arriving
//     from remote hosts over Tailscale. Docker NATs that traffic, so every one
//     of them shows up as the bridge gateway address with no way to tell which
//     host or agent opened it — the only handle left was NAT forensics. An
//     application_name turns `pg_stat_activity` into a usable answer.
//  2. Bounding. `new Pool({ connectionString })` without `max` silently falls
//     back to the node-postgres default of 10 and ignores `connection_limit`
//     in the URL, because that parameter is Prisma's, not pg's. The same defect
//     was fixed in the web app; this is the MCP half of it.
//
// application_name is passed as a config field rather than folded into the
// connection string on purpose: rewriting the URL risks re-encoding the
// password.

const MAX_APPLICATION_NAME = 63 // Postgres truncates at NAMEDATALEN-1
export const DEFAULT_POOL_MAX = 10

/**
 * Identifies this process in `pg_stat_activity`. Falls back to explicit
 * `unknown` markers rather than omitting the field, so an unlabelled
 * connection is still distinguishable from a misconfigured one.
 */
export function applicationName(): string {
  const server = process.env.S4M_SERVER?.trim() || 'unknown-host'
  const model = process.env.S4M_MODEL?.trim() || 'unknown-model'
  const instance = process.env.SCRUM4ME_WORKER_INSTANCE_ID?.trim()
  const base = `s4m-mcp:${server}:${model}`
  return (instance ? `${base}:${instance}` : base).slice(0, MAX_APPLICATION_NAME)
}

/**
 * `connection_limit` is a Prisma-only URL parameter: with the PrismaPg adapter
 * node-postgres does the pooling and ignores it. Read it out explicitly so the
 * value in DATABASE_URL actually takes effect.
 */
export function poolMaxFromUrl(url: string): number {
  try {
    const value = Number(new URL(url).searchParams.get('connection_limit'))
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_POOL_MAX
  } catch {
    // Not a URL-shaped connection string (pg also accepts `host=... dbname=...`).
    return DEFAULT_POOL_MAX
  }
}

/** Config for a dedicated `pg.Client` (LISTEN waiters, one-off queries). */
export function dbClientConfig(): { connectionString: string | undefined; application_name: string } {
  return {
    connectionString: process.env.DATABASE_URL,
    application_name: applicationName(),
  }
}

/** Config for the shared pool behind the Prisma adapter. */
export function dbPoolConfig(url: string): {
  connectionString: string
  application_name: string
  max: number
} {
  return {
    connectionString: url,
    application_name: applicationName(),
    max: poolMaxFromUrl(url),
  }
}
