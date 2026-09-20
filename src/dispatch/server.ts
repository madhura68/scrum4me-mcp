import { createPrivateKey, type KeyObject } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createDispatchStore, type DispatchStore } from './db.js'
import { createDispatchApp, type DispatchExecutorKeys } from './routes.js'
import { createDispatchAuth } from './auth.js'
import { createDispatchSelection } from './selection.js'
import { createDispatchAttempts } from './attempts.js'
import { createDispatchSources, createPinnedGitFetcher } from './sources.js'
import { createDispatchDelivery } from './delivery.js'
import { createDispatchPublication, createGitPublicationPort } from './publication.js'
import { createDispatchTick, type DispatchTickResult } from './tick.js'
import { recoverForgottenReplyReads, retainTerminalDispatchThreads } from './projection.js'
export { createDispatchApp } from './routes.js'

export const DISPATCH_TICK_INTERVAL_MS = 5000
/** Queue maintenance is hourly-scale work; the selection tick is not its schedule. */
export const DISPATCH_MAINTENANCE_INTERVAL_MS = 900_000
/** The CLI inbox lease: only past it is a claimed reply certainly forgotten rather than being read. */
export const DISPATCH_REPLY_READ_LEASE = '4 hours'

/** Attempt/session credential keys as `<version>:<base64url>`, comma separated, so an old
 * incarnation keeps verifying against the key version it was issued under. */
export function parseDispatchCredentialKeys(raw: string | undefined, version: string | undefined): Omit<DispatchExecutorKeys, 'startPermitPrivateKey'> | null {
  if (!raw || !version) return null
  const keyVersion = Number(version)
  if (!Number.isInteger(keyVersion) || keyVersion < 1) return null
  const credentialKeys: Record<number, Uint8Array> = {}
  for (const entry of raw.split(',').map(value => value.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':')
    const parsed = Number(entry.slice(0, separator))
    const bytes = Buffer.from(entry.slice(separator + 1), 'base64url')
    if (separator < 1 || !Number.isInteger(parsed) || parsed < 1 || bytes.byteLength < 32) return null
    credentialKeys[parsed] = bytes
  }
  if (!credentialKeys[keyVersion]) return null
  return { credentialKeys, keyVersion }
}
function startPermitKey(pem: string | undefined): KeyObject | null {
  if (!pem) return null
  try {
    const key = createPrivateKey(pem.includes('\\n') ? pem.replaceAll('\\n', '\n') : pem)
    return key.asymmetricKeyType === 'ed25519' ? key : null
  } catch { return null }
}
function assertionKey(value: string | undefined) {
  return value ? Buffer.from(value, 'utf8') : undefined
}

/** The tick's own lifecycle, separate from the listener. At most one tick is in flight; a stopped
 * runner starts no new one and its `stop` resolves only once the tick in flight has finished its
 * own transactions. A failed tick is logged by error name — never by message — and never stops it. */
export function createDispatchTickRunner(deps: { tick: () => Promise<DispatchTickResult>; log: (event: Record<string, unknown>) => void }) {
  let running: Promise<DispatchTickResult> | null = null
  let stopped = false
  return {
    async run(): Promise<void> {
      if (stopped || running) return
      running = deps.tick().finally(() => { running = null })
      const result = await running.catch(error => { deps.log({ tick_failed: error instanceof Error ? error.name : 'unknown' }); return null })
      if (result) deps.log({ tick: result })
    },
    stop(): Promise<unknown> {
      stopped = true
      return running?.catch(() => undefined) ?? Promise.resolve()
    },
  }
}

export type DispatchRunningServer = {
  server: import('node:http').Server
  store: DispatchStore
  tick: (() => Promise<DispatchTickResult>) | null
  close: () => Promise<void>
}

/** The production entrypoint. Importing this module starts nothing: the timer, the listener and
 * the pools all come into existence here, and only here. */
export function startDispatchServer(env: NodeJS.ProcessEnv = process.env): DispatchRunningServer {
  const store = createDispatchStore(env.DISPATCH_DATABASE_URL ?? '')
  const queue = env.DISPATCH_QUEUE_DATABASE_URL ? createDispatchStore(env.DISPATCH_QUEUE_DATABASE_URL) : null
  const enabled = env.DISPATCH_ENABLED === '1'
  const productAllowlist = (env.DISPATCH_PRODUCT_ALLOWLIST ?? '').split(',').map(id => id.trim()).filter(Boolean)
  const permit = startPermitKey(env.DISPATCH_START_PERMIT_PRIVATE_KEY)
  const credentials = parseDispatchCredentialKeys(env.DISPATCH_CREDENTIAL_KEYS, env.DISPATCH_CREDENTIAL_KEY_VERSION)
  const executor = credentials && permit ? { ...credentials, startPermitPrivateKey: permit } : undefined
  const log = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`)
  const auth = createDispatchAuth({ store })
  const core = { store, auth, enabled, productAllowlist }
  // Publishing needs a writable working root and a registered forge host; without both, code
  // delivery simply stays an artefact and nothing is pushed anywhere.
  const gitHost = env.DISPATCH_GIT_HOST?.trim()
  const publisher = env.DISPATCH_PUBLICATION_ROOT && gitHost
    ? createDispatchPublication({
      ...core,
      port: createGitPublicationPort({
        root: env.DISPATCH_PUBLICATION_ROOT, allowedProtocols: ['https'], allowedHosts: [gitHost],
        gitAuthHeader: async () => env.DISPATCH_GIT_TOKEN ? `Authorization: token ${env.DISPATCH_GIT_TOKEN}` : null,
        ...(env.DISPATCH_GIT_TOKEN ? { forgejo: { apiOrigin: `https://${gitHost}/api/v1`, token: env.DISPATCH_GIT_TOKEN } } : {}),
      }),
      // IP-14 owns a per-product base branch; a single configured default is explicit here.
      loadBaseBranch: async () => env.DISPATCH_BASE_BRANCH ?? 'main',
    })
    : undefined

  const app = createDispatchApp({
    store, enabled, productAllowlist, executor,
    assertionKeys: { workers: assertionKey(env.DISPATCH_WORKERS_ASSERTION_KEY), web: assertionKey(env.DISPATCH_WEB_ASSERTION_KEY) },
    log: event => log(event), publisher,
  })
  // Queue maintenance needs the projector connection. Repair is always safe, so it runs wherever
  // delivery runs; retention deletes hot queue rows, so a deployment opts in by naming its period.
  const retentionDays = Number(env.DISPATCH_RETENTION_DAYS)
  const retention = Number.isInteger(retentionDays) && retentionDays > 0 ? `${retentionDays} days` : null
  const maintenance = queue
    ? {
      intervalMs: Number(env.DISPATCH_MAINTENANCE_INTERVAL_MS ?? DISPATCH_MAINTENANCE_INTERVAL_MS),
      recoverReplyReads: (limit: number) => recoverForgottenReplyReads(queue, DISPATCH_REPLY_READ_LEASE, limit),
      ...(retention ? { retainThreads: (limit: number) => retainTerminalDispatchThreads({ store, queue }, { olderThan: retention, limit }) } : {}),
    }
    : undefined
  const dispatchTick = createDispatchTick({
    store,
    selection: createDispatchSelection(core),
    attempts: executor ? createDispatchAttempts({ ...core, ...executor }) : undefined,
    sources: createDispatchSources({ ...core, fetchGit: createPinnedGitFetcher({ host: env.DISPATCH_GIT_HOST ?? '', token: env.DISPATCH_GIT_TOKEN }) }),
    delivery: queue ? createDispatchDelivery({ store, queue }) : undefined,
    publications: publisher,
    ...(maintenance ? { maintenance } : {}),
    onError: (stage, error) => log({ tick_stage: stage, error: error instanceof Error ? error.name : 'unknown' }),
  })

  const runner = createDispatchTickRunner({ tick: dispatchTick, log })
  const timer = setInterval(() => { void runner.run() }, Number(env.DISPATCH_TICK_INTERVAL_MS ?? DISPATCH_TICK_INTERVAL_MS))
  timer.unref()
  const server = app.listen(Number(env.DISPATCH_PORT ?? 4319), env.DISPATCH_HOST ?? '127.0.0.1')

  let closing: Promise<void> | null = null
  // Shutdown runs once. Both signals are wired, and a listener, a timer and two pools may each be
  // closed exactly once — a second SIGINT must not turn an orderly shutdown into an error.
  const close = () => closing ??= (async () => {
    // Order matters. Closing the listener first is what stops new intake, selection and start;
    // the timer stops next so no further selection begins, and the tick in flight is allowed to
    // finish its own transactions. Nothing here touches attempts or reservations: capacity is
    // released by stop evidence, never by a shutdown.
    const drained = runner.stop()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    clearInterval(timer)
    await drained
    try {
      const open = (await store.query<{ attempt_id: string; scope_id: string | null; state: string }>(
        `SELECT id AS attempt_id,scope_id,state FROM queue_dispatch_attempts
         WHERE state IN ('CLAIMED','RUNNING','UNCERTAIN','CANCEL_REQUESTED') ORDER BY id`)).rows
      log({ shutdown: 'complete', open_scopes: open })
    } catch { log({ shutdown: 'complete', open_scopes: null }) }
    await store.end()
    if (queue) await queue.end()
  })()
  return { server, store, tick: dispatchTick, close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const running = startDispatchServer()
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void running.close().catch(() => { process.exitCode = 1 }) })
  } catch { process.stderr.write('DISPATCH_START_FAILED\n'); process.exitCode = 1 }
}
