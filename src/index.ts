#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerSharedTools, registerWorktreeTools } from './register.js'
import { getAuth } from './auth.js'
import { INSTRUCTIONS } from './instructions.js'
import { registerWorker } from './presence/worker.js'
import { startHeartbeat } from './presence/heartbeat.js'
import { registerShutdownHandlers } from './presence/shutdown.js'
import { getInstanceId } from './presence/instance.js'
import { getWorkerRuntimeFromEnv } from './worker-runtime.js'
import { hostname as osHostname } from 'node:os'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Read version dynamically from package.json — voorheen hardcoded en
// veroorzaakte sync-issues bij deployment. Lees op module-load.
function readPkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkgPath = join(here, '..', 'package.json')
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
const VERSION = readPkgVersion()

async function main() {
  const server = new McpServer(
    { name: 'scrum4me-mcp', version: VERSION },
    { instructions: INSTRUCTIONS },
  )

  // stdio mode serves the full toolset: DB/network tools + the worktree-bound
  // tools (this process runs co-located with the agent's git worktree).
  registerSharedTools(server)
  registerWorktreeTools(server)

  // Presence bootstrap MUST run before server.connect — the stdio transport
  // can stall the await on incoming messages, so anything after server.connect
  // may never execute reliably. Registering the worker + starting the
  // heartbeat first guarantees the UI sees the agent as soon as the process
  // is up, regardless of when the MCP client sends its first request.
  const auth = await getAuth()
  const runtime = getWorkerRuntimeFromEnv()
  const instanceId = process.env.SCRUM4ME_WORKER_INSTANCE_ID?.trim() || getInstanceId()
  const capabilities = (process.env.SCRUM4ME_WORKER_CAPABILITIES ?? 'code_edit,planning,review')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const hostname = process.env.HOSTNAME ?? osHostname()
  await registerWorker({
    userId: auth.userId,
    tokenId: auth.tokenId,
    runtime,
    capabilities,
    instanceId,
    hostname,
    pid: process.pid,
  })
  const { stop: stopHeartbeat } = startHeartbeat({
    tokenId: auth.tokenId,
    instanceId,
    runtime,
    capabilities,
    hostname,
    pid: process.pid,
  })
  registerShutdownHandlers({
    userId: auth.userId,
    tokenId: auth.tokenId,
    instanceId,
    stopHeartbeat,
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error(`scrum4me-mcp ${VERSION} running on stdio`)
}

main().catch((err) => {
  console.error('Fatal error in scrum4me-mcp:', err)
  process.exit(1)
})
