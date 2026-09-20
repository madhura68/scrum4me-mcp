import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { toolJson } from '../errors.js'
import { requestDispatchClient, withDispatchErrors } from './dispatch-common.js'

export function registerGetDispatchTool(server: McpServer) {
  server.registerTool(
    'get_dispatch',
    {
      title: 'Get dispatch',
      description: 'Read-only: the current state, route, reason and delivery of one dispatch request you may see.',
      inputSchema: z.object({ request_id: z.string().uuid() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ request_id }) => withDispatchErrors(async () => toolJson(await requestDispatchClient().getDispatch(request_id))),
  )
}
