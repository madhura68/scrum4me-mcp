// Session-scoped advisory lock op een pooler-vrije verbinding (issue-tracker
// spec §6). Session- en niet transaction-scoped omdat de lock de HTTP-calls naar
// Forgejo moet overspannen; een Prisma-transactie zou daar allang zijn
// afgekapt.
//
// Zonder DIRECT_URL slaat de MCP inline-sync over in plaats van te forceren: de
// repair-sweep in Scrum4Me is het gegarandeerde pad, dus niets gaat verloren.
import { Client } from 'pg'

export type LockResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'no-direct-url' | 'locked' }

export async function withIssueSessionLock<T>(
  issueId: string,
  fn: (client: Client) => Promise<T>,
): Promise<LockResult<T>> {
  const directUrl = process.env.DIRECT_URL
  if (!directUrl) return { ok: false, reason: 'no-direct-url' }

  const client = new Client({ connectionString: directUrl })
  let locked = false
  try {
    await client.connect()
    const res = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked',
      ['issfj', issueId],
    )
    locked = res.rows[0]?.locked === true
    if (!locked) return { ok: false, reason: 'locked' }
    return { ok: true, value: await fn(client) }
  } finally {
    if (locked) {
      // Alleen unlocken als we de lock hadden: unlocken zonder lock geeft per
      // keer een Postgres-WARNING op precies het pad waar sweep en inline-sync
      // elkaar correct passeren.
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', ['issfj', issueId])
      } catch {
        // Verbinding al weg — de lock vervalt dan vanzelf.
      }
    }
    try {
      await client.end()
    } catch {
      // idem
    }
  }
}
