// LISTEN mechanics shared by the bounded-wait queue tools (spec §5):
// NOTIFY is exclusively a wake-up signal — the claim query is the single
// source of truth (payloads can be lost or duplicated). Dedicated pg.Client
// per wait call on DATABASE_URL; callers own the `finally { end() }`.
// openQueueListener is covered by the integration test (needs a real DB).
import { Client } from 'pg'
import { QUEUE_CHANNEL } from './notify.js'

export const QUEUE_POLL_INTERVAL_MS = 5_000

export async function openQueueListener(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  // QUEUE_CHANNEL is a module constant ('agent_queue'), safe as identifier.
  await client.query(`LISTEN ${QUEUE_CHANNEL}`)
  return client
}

/**
 * Resolves on a relevant NOTIFY payload, on the poll interval, or on abort —
 * whichever comes first. A missed NOTIFY costs at most poll latency, never a
 * hanging agent. The caller re-runs its claim query after every wake-up.
 */
export function waitForQueueWakeup(
  client: Client,
  signal: AbortSignal,
  isRelevant: (payload: Record<string, unknown>) => boolean,
  pollIntervalMs: number = QUEUE_POLL_INTERVAL_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const onNotification = (msg: { channel: string; payload?: string }) => {
      if (msg.channel !== QUEUE_CHANNEL) return
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(msg.payload ?? '{}') as Record<string, unknown>
      } catch {
        return
      }
      if (isRelevant(payload)) finish()
    }
    const onAbort = () => finish()
    const timer = setTimeout(() => finish(), pollIntervalMs)
    function finish() {
      clearTimeout(timer)
      client.removeListener('notification', onNotification)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    client.on('notification', onNotification)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) finish()
  })
}
