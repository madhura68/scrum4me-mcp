import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { toolJson, withToolErrors } from '../errors.js'
import { AGENT_RUNTIMES } from '@shared/agent-runtime.js'

// Read once at module-load. Health is hot-path enough that we don't want
// disk-IO per call, and the version string is fixed for the running process.
function readPkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // src/tools/health.ts → src/tools → src → repo-root
    const pkgPath = join(here, '..', '..', 'package.json')
    const raw = readFileSync(pkgPath, 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
const VERSION = readPkgVersion()

export function registerHealthTool(server: McpServer) {
  server.registerTool(
    'health',
    {
      title: 'Health probe',
      description:
        'Check that the MCP server and Scrum4Me database are reachable. Always safe to call.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      withToolErrors(async () => {
        let database: 'ok' | 'down' = 'ok'
        try {
          await prisma.$queryRaw`SELECT 1`
        } catch {
          database = 'down'
        }
        return toolJson({
          status: 'ok',
          version: VERSION,
          time: new Date().toISOString(),
          database,
          // The worker runtimes this MCP release knows (SCRUM4ME_WORKER_RUNTIME). A copy: toolJson
          // hands the object itself back as structuredContent, so a reader that mutates the list
          // would otherwise mutate the shared constant.
          runtimes: [...AGENT_RUNTIMES],
        })
      }),
  )
}
