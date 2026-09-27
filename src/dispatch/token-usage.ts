import type { PoolClient } from 'pg'
import { apiTokenUsageUpdate, type TokenUsage } from '@shared/api-token-usage.js'
import type { DispatchStore } from './db.js'

/** A timed-out waiter still owns its eventual checkout and must release it. */
function acquire(store: DispatchStore): Promise<PoolClient> {
  return new Promise((resolve, reject) => {
    let expired = false
    const timer = setTimeout(() => { expired = true; reject(new Error('ACQUIRE_TIMEOUT')) }, 1000)
    store.connect().then(client => {
      clearTimeout(timer)
      if (expired) client.release()
      else resolve(client)
    }, error => { clearTimeout(timer); reject(error) })
  })
}

export async function recordDispatchTokenUse(store: DispatchStore, usage: TokenUsage): Promise<void> {
  let client: PoolClient | undefined
  try {
    const query = apiTokenUsageUpdate(usage)
    client = await acquire(store)
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout = '500ms'")
    await client.query("SET LOCAL lock_timeout = '100ms'")
    await client.query(query.text, query.values)
    await client.query('COMMIT')
  } catch {
    if (client) await client.query('ROLLBACK').catch(() => undefined)
    try { console.error('api_token_usage_write_failed interface=dispatch code=WRITE_FAILED') } catch { /* nonfatal */ }
  } finally {
    client?.release()
  }
}

import type { Request, Response } from 'express'
import type { DispatchActor } from './ports.js'

/** Attach before the handler: artifact routes may finish their response inside it. */
export function observeDispatchTokenUse(
  req: Request, res: Response, actor: DispatchActor,
  record: (usage: TokenUsage) => Promise<void>,
): { succeeded(): void; failed(): void } {
  let finished = false
  let handlerSucceeded = false
  let failed = req.aborted || (res.destroyed && !res.writableFinished)
  let recorded = false
  const logFailure = () => {
    try { console.error('api_token_usage_write_failed interface=dispatch code=WRITE_FAILED') } catch { /* nonfatal */ }
  }
  const tryRecord = () => {
    if (recorded || failed || !finished || !handlerSucceeded || req.aborted
      || res.statusCode < 200 || res.statusCode >= 300 || actor.source !== 'bearer' || !actor.tokenId) return
    recorded = true
    const usage = { tokenId: actor.tokenId, userId: actor.userId, completedAt: new Date() }
    try { void record(usage).catch(logFailure) } catch { logFailure() }
  }
  res.once('finish', () => { finished = true; tryRecord() })
  res.once('close', () => { if (!finished) failed = true })
  res.once('error', () => { failed = true })
  return {
    succeeded() { handlerSucceeded = true; tryRecord() },
    failed() { failed = true },
  }
}
