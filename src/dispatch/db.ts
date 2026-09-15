import { Pool, type PoolClient } from 'pg'
import { DispatchError } from './errors.js'

export type DispatchStore = Pool
export type DispatchTransaction<T> = (client: PoolClient) => Promise<T>

export function createDispatchStore(databaseUrl: string): DispatchStore {
  if (!databaseUrl?.trim()) {
    throw new DispatchError('DISPATCH_DATABASE_URL_REQUIRED')
  }
  try {
    const parsed = new URL(databaseUrl)
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('protocol')
  } catch (cause) {
    throw new DispatchError('DISPATCH_DATABASE_URL_INVALID', { cause })
  }
  return new Pool({
    connectionString: databaseUrl,
    application_name: 'scrum4me-dispatch',
  })
}

/**
 * Runs one database-only dispatch action atomically. Callers must finish any
 * external network or runtime work before or after this callback.
 */
export async function withDispatchTransaction<T>(
  store: DispatchStore,
  fn: DispatchTransaction<T>,
): Promise<T> {
  const client = await store.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
