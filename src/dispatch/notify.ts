import type { Client, PoolClient } from 'pg'

/** The dispatch service's own wake-up channel on its own database, separate from the queue's
 * `agent_queue`: this one carries no message and no delivery, only "there is work a tick would
 * pick up". Like every NOTIFY here it is a hint. The interval tick remains the safety net, so a
 * lost notification, a dropped LISTEN connection or a restart costs latency and nothing else. */
export const DISPATCH_TICK_CHANNEL = 'dispatch_tick'
/** How long a burst is folded into one early tick. Short enough to stay a latency improvement,
 * long enough that a submit storm does not become a tick storm. */
export const DISPATCH_TICK_COALESCE_MS = 25

/** `request` is any durable request transition, which is also exactly when an outbox row is
 * written; `capacity` is a newly registered incarnation, which writes no outbox row but is what
 * a waiting request was missing. Nothing else in the tick is event-driven: candidate deadlines
 * and attempt leases are elapsed time, and no notification can bring those forward. */
export type DispatchTickReason = 'request' | 'capacity'
/** Ids only. No secret, no credential, no product content: a reader learns that a tick is worth
 * running, and the tick itself re-reads the authoritative rows under their own locks. */
export type DispatchTickSignal = { v: 1; reason: DispatchTickReason; request_id: string | null }

/** Emitted inside the service's own transaction, so it fires at COMMIT and never for work that
 * rolled back. It is not a trigger: the transactions that change this state are all in this
 * service, and a database trigger would be a migration. */
export async function notifyDispatchTick(db: PoolClient, reason: DispatchTickReason, requestId: string | null = null): Promise<void> {
  const signal: DispatchTickSignal = { v: 1, reason, request_id: requestId }
  await db.query('SELECT pg_notify($1,$2)', [DISPATCH_TICK_CHANNEL, JSON.stringify(signal)])
}

export function parseDispatchTickSignal(payload: string | undefined): DispatchTickSignal | null {
  try {
    const value = JSON.parse(payload ?? '') as DispatchTickSignal
    if (value?.v !== 1 || !['request', 'capacity'].includes(value.reason)) return null
    return value
  } catch { return null }
}

export type DispatchTickListener = { start(): Promise<void>; stop(): Promise<void> }

/** The consumer half, on a connection of its own: a LISTEN session holds its backend for as long
 * as it lives, so it never comes out of the pool the tick's own transactions need.
 *
 * Building it starts nothing — `start()` is the only thing that connects, exactly as the server
 * entrypoint owns the timer. Wakes are coalesced, so a burst costs one early tick; the runner
 * keeps its own single-in-flight guarantee, so a wake during a tick becomes one follow-up rather
 * than a second concurrent tick. */
export function createDispatchTickListener(deps: {
  connect: () => Promise<Client>
  /** Asks the tick runner to run now. It, not this listener, guarantees one tick at a time. */
  wake: () => void
  log?: (event: Record<string, unknown>) => void
  /** Closes the coalescing window. Injected by tests; production uses DISPATCH_TICK_COALESCE_MS. */
  schedule?: (run: () => void) => () => void
  /** Reconnect backoff per consecutive failure. */
  backoffMs?: (attempt: number) => number
}): DispatchTickListener {
  const schedule = deps.schedule ?? ((run: () => void) => {
    const timer = setTimeout(run, DISPATCH_TICK_COALESCE_MS); timer.unref?.()
    return () => clearTimeout(timer)
  })
  const backoffMs = deps.backoffMs ?? ((attempt: number) => Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7)))
  let client: Client | null = null
  let cancelWake: (() => void) | null = null
  let retryTimer: NodeJS.Timeout | null = null
  let failures = 0
  let stopped = false

  /** One wake per coalescing window, however many notifications arrive inside it. */
  function signal() {
    if (cancelWake || stopped) return
    cancelWake = schedule(() => { cancelWake = null; if (!stopped) deps.wake() })
  }
  function retry() {
    if (stopped) return
    failures++
    retryTimer = setTimeout(() => { retryTimer = null; void open() }, backoffMs(failures))
    retryTimer.unref?.()
  }
  async function open(): Promise<void> {
    if (stopped || client) return
    let next: Client
    try {
      next = await deps.connect()
      await next.query(`LISTEN ${DISPATCH_TICK_CHANNEL}`)
    } catch (error) {
      deps.log?.({ tick_listener_failed: error instanceof Error ? error.name : 'unknown', attempt: failures + 1 })
      retry(); return
    }
    if (stopped) { await next.end().catch(() => undefined); return }
    const onNotification = (message: { channel: string; payload?: string }) => {
      if (message.channel === DISPATCH_TICK_CHANNEL && parseDispatchTickSignal(message.payload)) signal()
    }
    const drop = (reason: 'error' | 'end') => {
      if (client !== next) return
      client = null
      next.removeListener('notification', onNotification)
      next.removeListener('error', onError)
      next.removeListener('end', onEnd)
      void next.end().catch(() => undefined)
      deps.log?.({ tick_listener: `dropped_on_${reason}` })
      retry()
    }
    const onError = () => drop('error')
    const onEnd = () => drop('end')
    next.on('notification', onNotification)
    next.on('error', onError)
    next.on('end', onEnd)
    client = next
    failures = 0
    // Connecting deliberately wakes nothing. Anything committed while no session was listening is
    // picked up by the interval tick, which is the same safety net a lost notification relies on,
    // and a service that starts must not tick before its own first interval either.
    deps.log?.({ tick_listener: 'listening' })
  }
  return {
    start: open,
    async stop() {
      stopped = true
      cancelWake?.(); cancelWake = null
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      const current = client; client = null
      if (current) { current.removeAllListeners('notification'); current.removeAllListeners('error'); current.removeAllListeners('end'); await current.end().catch(() => undefined) }
    },
  }
}
