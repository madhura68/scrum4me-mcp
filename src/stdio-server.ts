// stdio entrypoint construction, split into a side-effect-free constructor and
// a runtime lifecycle that is the *only* place auth/presence/heartbeat/queue
// maintenance run.
//
//  - createStdioServer() builds an McpServer and registers the full tool
//    surface. It touches no credentials, database, network, Git or presence —
//    both the runtime worker and the release canary construct through it, so
//    the two surfaces cannot drift.
//  - startStdioServer() picks the mode from the environment. In canary mode it
//    connects the transport and stops; the credentialless surface is up and no
//    lifecycle ever fires. In runtime mode it runs the presence bootstrap
//    (unchanged from the historical index.ts) before connecting the transport.
//
// The lifecycle boundary is injectable so tests can prove the negative — that
// merely constructing and listing the canary surface invokes none of it —
// without monkey-patching module globals.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { hostname as osHostname } from 'node:os'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerFullStdioSurface } from './register.js'
import { INSTRUCTIONS } from './instructions.js'
import { stdioMode, type StdioMode } from './canary-mode.js'
import { getAuth } from './auth.js'
import { registerWorker } from './presence/worker.js'
import { startHeartbeat } from './presence/heartbeat.js'
import { registerShutdownHandlers } from './presence/shutdown.js'
import { getInstanceId } from './presence/instance.js'
import { startQueueLeaseRefresh } from './queue/lease-refresh.js'
import { startQueueStaleSweep } from './queue/sweep.js'
import { getWorkerRuntimeFromEnv, type WorkerRuntime } from './worker-runtime.js'

function readPkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(here, '..', 'package.json')
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
export const VERSION = readPkgVersion()

export const SERVER_NAME = 'scrum4me-mcp' as const

/**
 * The four side-effecting subsystems a runtime worker starts. Injectable so a
 * test can poison them and assert construction never touches them; the default
 * implementation ({@link createRuntimeLifecycle}) wires the real functions.
 */
export interface StdioLifecycle {
  authenticate(): Promise<Awaited<ReturnType<typeof getAuth>>>
  registerWorker(): Promise<void>
  startHeartbeat(): () => void
  startQueueMaintenance(): readonly (() => void)[]
}

export interface StdioServerOptions {
  mode: StdioMode
  /** Only consumed by {@link startStdioServer}; construction never reads it. */
  lifecycle?: StdioLifecycle
}

/**
 * Build the stdio McpServer. Chooses one registration path and changes only
 * handler execution: runtime handlers run, canary handlers throw
 * CANARY_MODE_TOOL_CALL_FORBIDDEN. No lifecycle effect happens here.
 */
export function createStdioServer(options: StdioServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: INSTRUCTIONS })
  registerFullStdioSurface(server, {
    execution: options.mode === 'canary' ? 'forbidden' : 'enabled',
  })
  return server
}

interface RuntimeContext {
  runtime: WorkerRuntime
  instanceId: string
  capabilities: string[]
  hostname: string
  pid: number
}

function resolveRuntimeContext(env: NodeJS.ProcessEnv): RuntimeContext {
  return {
    runtime: getWorkerRuntimeFromEnv(env),
    instanceId: env.SCRUM4ME_WORKER_INSTANCE_ID?.trim() || getInstanceId(),
    capabilities: (env.SCRUM4ME_WORKER_CAPABILITIES ?? 'code_edit,planning,review')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    hostname: env.HOSTNAME ?? osHostname(),
    pid: process.pid,
  }
}

function createRuntimeLifecycle(ctx: RuntimeContext): StdioLifecycle {
  let auth: Awaited<ReturnType<typeof getAuth>> | undefined
  const requireAuth = (): Awaited<ReturnType<typeof getAuth>> => {
    if (!auth) throw new Error('lifecycle.authenticate() must run before this step')
    return auth
  }
  return {
    async authenticate() {
      auth = await getAuth()
      return auth
    },
    async registerWorker() {
      const { userId, tokenId } = requireAuth()
      await registerWorker({
        userId,
        tokenId,
        runtime: ctx.runtime,
        capabilities: ctx.capabilities,
        instanceId: ctx.instanceId,
        hostname: ctx.hostname,
        pid: ctx.pid,
      })
    },
    startHeartbeat() {
      const { tokenId } = requireAuth()
      const { stop } = startHeartbeat({
        tokenId,
        instanceId: ctx.instanceId,
        runtime: ctx.runtime,
        capabilities: ctx.capabilities,
        hostname: ctx.hostname,
        pid: ctx.pid,
      })
      return stop
    },
    startQueueMaintenance() {
      const { stop: stopLeaseRefresh } = startQueueLeaseRefresh()
      const { stop: stopStaleSweep } = startQueueStaleSweep()
      return [stopLeaseRefresh, stopStaleSweep]
    },
  }
}

/**
 * Boot the stdio process. Canary mode: construct + connect, nothing else.
 * Runtime mode: run the presence bootstrap before connecting — the order is
 * load-bearing (see the historical index.ts note: the stdio transport can stall
 * the await on incoming messages, so presence must be up before connect).
 */
export async function startStdioServer(
  options: { env?: NodeJS.ProcessEnv; lifecycle?: StdioLifecycle } = {},
): Promise<void> {
  const env = options.env ?? process.env
  const mode = stdioMode(env)

  if (mode === 'canary') {
    const server = createStdioServer({ mode })
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error(`scrum4me-mcp ${VERSION} running on stdio (canary — tool execution forbidden)`)
    return
  }

  const ctx = resolveRuntimeContext(env)
  const lifecycle = options.lifecycle ?? createRuntimeLifecycle(ctx)
  const server = createStdioServer({ mode, lifecycle })

  // Presence bootstrap MUST run before server.connect.
  const auth = await lifecycle.authenticate()
  await lifecycle.registerWorker()
  const stopHeartbeat = lifecycle.startHeartbeat()
  const maintenanceStops = lifecycle.startQueueMaintenance()
  const { shutdown } = registerShutdownHandlers({
    userId: auth.userId,
    tokenId: auth.tokenId,
    instanceId: ctx.instanceId,
    stopHeartbeat,
    stopQueueMaintenance: () => {
      for (const stop of maintenanceStops) stop()
    },
  })

  const transport = new StdioServerTransport()
  // Canonical SDK signal for "the client is gone"; stdin handlers in
  // registerShutdownHandlers are the fallback if the transport never reaches
  // onclose itself.
  transport.onclose = () => void shutdown()
  await server.connect(transport)

  console.error(`scrum4me-mcp ${VERSION} running on stdio`)
}
