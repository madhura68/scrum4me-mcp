import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { toolJson } from '../errors.js'
import { requestDispatchClient, withDispatchErrors } from './dispatch-common.js'

export function registerCancelDispatchTool(server: McpServer) {
  server.registerTool(
    'cancel_dispatch',
    {
      title: 'Cancel dispatch',
      description:
        'Cancel a dispatch request. Before its first claim this completes at once; afterwards it requests a stop and ' +
        'the request finishes once termination is proven. expected_version is the version you last read, so a ' +
        'cancel never lands on a state you have not seen.',
      inputSchema: z.object({
        request_id: z.string().uuid(), expected_version: z.string().regex(/^[1-9][0-9]*$/),
        action_id: z.string().uuid().optional().describe('Reuse to retry the same cancel safely; omitted → generated and returned.'),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ request_id, expected_version, action_id }) => withDispatchErrors(async () => {
      const id = action_id ?? randomUUID()
      return toolJson({ action_id: id, dispatch: await requestDispatchClient().cancelDispatch(request_id, { action_id: id, expected_version }) })
    }),
  )
}
