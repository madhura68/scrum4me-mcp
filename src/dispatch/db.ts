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
  try { return await withDispatchClientTransaction(client, fn) }
  finally { client.release() }
}

/** A caller already owning a session lock must not acquire another pool client. */
export async function withDispatchClientTransaction<T>(client: PoolClient, fn: DispatchTransaction<T>): Promise<T> {
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

/** Only PostgreSQL-confirmed aborts are replayable. Connection loss, including
 * an ambiguous COMMIT response, is left for a caller retry with the same key. */
export async function withDispatchRetryTransaction<T>(store: DispatchStore, fn: DispatchTransaction<T>): Promise<T> {
  return retryAbortedTransaction(() => withDispatchTransaction(store, fn))
}
export async function withDispatchRetryClientTransaction<T>(client: PoolClient, fn: DispatchTransaction<T>): Promise<T> {
  return retryAbortedTransaction(() => withDispatchClientTransaction(client, fn))
}
async function retryAbortedTransaction<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await run() } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (attempt >= 3 || (code !== '40001' && code !== '40P01')) throw error
      await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 10 * attempt)))
    }
  }
}
