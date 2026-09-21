import { createPrivateKey, type KeyObject } from 'node:crypto'
import { dispatchKeyIdSchema } from '@shared/queue-dispatch-start-permit.js'
import { pathToFileURL } from 'node:url'
import { Client } from 'pg'
import { createDispatchStore, type DispatchStore } from './db.js'
import { createDispatchTickListener } from './notify.js'
import { createDispatchApp, type DispatchExecutorKeys } from './routes.js'
import { createDispatchAuth } from './auth.js'
import { createDispatchSelection } from './selection.js'
import { createDispatchAttempts } from './attempts.js'
import { createDispatchSources, createPinnedGitFetcher } from './sources.js'
import { createDispatchWorkspace } from './workspace.js'
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
export function parseDispatchCredentialKeys(raw: string | undefined, version: string | undefined): Pick<DispatchExecutorKeys, 'credentialKeys' | 'keyVersion'> | null {
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
/** A signing key id from the operator env: bounded ASCII with no `:`/`,` so it survives the
 * verifier's comma/colon-delimited keyset. Read exactly as the private key is read today. */
function keyId(value: string | undefined): string | null {
  return value && dispatchKeyIdSchema.safeParse(value).success ? value : null
}
function assertionKey(value: string | undefined) {
  return value ? Buffer.from(value, 'utf8') : undefined
}

/** The tick's own lifecycle, separate from the listener. At most one tick is in flight; a stopped
 * runner starts no new one and its `stop` resolves only once the tick in flight has finished its
 * own transactions. A failed tick is logged by error name — never by message — and never stops it.
 *
 * `run` is the interval's entry: if a tick is already in flight this interval is simply skipped.
 * `wake` is the notification's: it asks for a tick that reflects what was just committed, so a
 * wake that lands during a tick is remembered and becomes exactly one follow-up — however many
 * wakes arrived, and never a second concurrent tick. */
export function createDispatchTickRunner(deps: { tick: () => Promise<DispatchTickResult>; log: (event: Record<string, unknown>) => void }) {
  let running: Promise<DispatchTickResult> | null = null
  let pending = false
  let stopped = false
  async function drive(): Promise<void> {
    if (stopped || running) return
    do {
      pending = false
      running = deps.tick().finally(() => { running = null })
      const result = await running.catch(error => { deps.log({ tick_failed: error instanceof Error ? error.name : 'unknown' }); return null })
      if (result) deps.log({ tick: result })
    } while (pending && !stopped)
  }
  return {
    run(): Promise<void> { return drive() },
    wake(): void { if (stopped) return; pending = true; void drive() },
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
  const permitKid = keyId(env.DISPATCH_START_PERMIT_KEY_ID)
  const credentials = parseDispatchCredentialKeys(env.DISPATCH_CREDENTIAL_KEYS, env.DISPATCH_CREDENTIAL_KEY_VERSION)
  // The manifest signs under its OWN key + kid, distinct from the permit. Both present or the
  // manifest route stays unavailable; there is no silent fallback to the permit key.
  const manifestKey = startPermitKey(env.DISPATCH_SOURCE_MANIFEST_PRIVATE_KEY)
  const manifestKid = keyId(env.DISPATCH_SOURCE_MANIFEST_KEY_ID)
  const manifest = manifestKey && manifestKid ? { sourceManifestPrivateKey: manifestKey, sourceManifestKeyId: manifestKid } : undefined
  // The permit routes exist only where the permit key AND its kid are configured together; the kid
  // is now part of every issued permit, so a key without a kid is an unconfigured signer.
  const executor = credentials && permit && permitKid
    ? { ...credentials, startPermitPrivateKey: permit, startPermitKeyId: permitKid, ...manifest }
    : undefined
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

  // A repo_write request needs its pinned base prepared before anything can be reserved, and
  // that producer needs a writable workspace root plus a reachable repository. It reuses the
  // one central forge host and token the publisher already reads — there is no second
  // credential path — and every checkout it makes is removed again at the end of the request.
  const gitProtocols = (env.DISPATCH_GIT_PROTOCOLS ?? 'https').split(',').map(value => value.trim()).filter(Boolean)
  const workspaceRoot = env.DISPATCH_WORKSPACE_ROOT?.trim()
  const workspace = workspaceRoot && (gitHost || !gitProtocols.includes('https'))
    ? createDispatchWorkspace({
      root: workspaceRoot, allowedProtocols: gitProtocols, allowedHosts: gitHost ? [gitHost] : [],
      loadRepository: async productId => (await store.query<{ repo_url: string | null }>(
        'SELECT repo_url FROM products WHERE id=$1', [productId])).rows[0]?.repo_url ?? null,
      gitAuthHeader: async () => env.DISPATCH_GIT_TOKEN ? `Authorization: token ${env.DISPATCH_GIT_TOKEN}` : null,
    })
    : null

  // The child gateway exists only where an operator configured its own HMAC key. Without one
  // no capability is ever minted and the two `/agent` routes are simply not there.
  const agentOutputKey = env.DISPATCH_AGENT_OUTPUT_KEY && Buffer.from(env.DISPATCH_AGENT_OUTPUT_KEY, 'base64url').byteLength >= 32
    ? Buffer.from(env.DISPATCH_AGENT_OUTPUT_KEY, 'base64url')
    : undefined
  const app = createDispatchApp({
    store, enabled, productAllowlist, executor, repositorySources: Boolean(workspace),
    ...(agentOutputKey ? { agentOutputKey } : {}),
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
    sources: createDispatchSources({
      ...core, fetchGit: createPinnedGitFetcher({ host: env.DISPATCH_GIT_HOST ?? '', token: env.DISPATCH_GIT_TOKEN }),
      ...(workspace ? { prepareRepository: workspace.prepareRepositorySource } : {}),
    }),
    delivery: queue ? createDispatchDelivery({ store, queue }) : undefined,
    publications: publisher,
    ...(maintenance ? { maintenance } : {}),
    onError: (stage, error) => log({ tick_stage: stage, error: error instanceof Error ? error.name : 'unknown' }),
  })

  const runner = createDispatchTickRunner({ tick: dispatchTick, log })
  const timer = setInterval(() => { void runner.run() }, Number(env.DISPATCH_TICK_INTERVAL_MS ?? DISPATCH_TICK_INTERVAL_MS))
  timer.unref()
  // The notification half of §2.1's "NOTIFY and a tick every five seconds". It pulls the next
  // tick forward and can do nothing else: the interval above remains the safety net, so a lost
  // notification or a dropped session costs latency only. The URL was already validated by
  // createDispatchStore; this is deliberately a Client and not a pool member, because a LISTEN
  // session holds its backend for as long as it lives.
  const listener = createDispatchTickListener({
    connect: async () => {
      const client = new Client({ connectionString: env.DISPATCH_DATABASE_URL, application_name: 'scrum4me-dispatch-listener' })
      await client.connect()
      return client
    },
    wake: () => runner.wake(), log,
  })
  void listener.start()
  const server = app.listen(Number(env.DISPATCH_PORT ?? 4319), env.DISPATCH_HOST ?? '127.0.0.1')

  let closing: Promise<void> | null = null
  // Shutdown runs once. Both signals are wired, and a listener, a timer and two pools may each be
  // closed exactly once — a second SIGINT must not turn an orderly shutdown into an error.
  const close = () => closing ??= (async () => {
    // Order matters. The notification listener goes first, so nothing can ask for another tick
    // and its own connection is closed while the database is still reachable. Closing the HTTP
    // listener is what stops new intake, selection and start; the timer stops next so no further
    // selection begins, and the tick in flight is allowed to finish its own transactions. Nothing
    // here touches attempts or reservations: capacity is released by stop evidence, never by a
    // shutdown.
    await listener.stop()
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
