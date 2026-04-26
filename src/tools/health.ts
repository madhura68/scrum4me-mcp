import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { toolJson, withToolErrors } from '../errors.js'

const VERSION = '0.1.0'

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
        })
      }),
  )
}
