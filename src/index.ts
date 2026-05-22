#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerSharedTools, registerWorktreeTools } from './register.js'
import { getAuth } from './auth.js'
import { registerWorker } from './presence/worker.js'
import { startHeartbeat } from './presence/heartbeat.js'
import { registerShutdownHandlers } from './presence/shutdown.js'

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
    {
      instructions:
        'Scrum4Me dev-flow tools: read product/sprint/story context, update tasks, log activity. ' +
        'Always call get_claude_context before starting work to fetch the next story. ' +
        'Use search_product_docs before implementing, reviewing, grilling, or chatting ' +
        'about work that touches architecture, patterns, auth, status mapping, demo policy, ' +
        'job flow, sprint flow, MD3/styling, or UI dialogs. Use Read/Grep on docs/ only as ' +
        'fallback when MCP tools return no useful result or a multi-file scan is required. ' +
        'Use related_product_docs to follow cross-references between docs. Use get_product_doc ' +
        'with `heading` parameter to focus on a section instead of loading the full doc.',
    },
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
  await registerWorker({ userId: auth.userId, tokenId: auth.tokenId })
  const { stop: stopHeartbeat } = startHeartbeat({ tokenId: auth.tokenId })
  registerShutdownHandlers({ userId: auth.userId, tokenId: auth.tokenId, stopHeartbeat })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error(`scrum4me-mcp ${VERSION} running on stdio`)
}

main().catch((err) => {
  console.error('Fatal error in scrum4me-mcp:', err)
  process.exit(1)
})
