// MCP read-tool: lees de worker-instellingen van de geauthenticeerde user.
//
// Worker roept dit aan vóór elke wait_for_job iteratie zodat hij weet
// wanneer hij stand-by moet (pre-flight quota-gate).
//
// Auth: api-token; user_id afgeleid uit token. Demo mag.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

export function registerGetWorkerSettingsTool(server: McpServer) {
  server.registerTool(
    'get_worker_settings',
    {
      title: 'Get worker settings',
      description:
        'Read the authenticated user\'s worker settings (min_quota_pct). Worker should call this each iteration before doing the pre-flight quota probe.',
      inputSchema: {},
    },
    async () =>
      withToolErrors(async () => {
        const auth = await getAuth()
        const user = await prisma.user.findUnique({
          where: { id: auth.userId },
          select: { min_quota_pct: true },
        })
        if (!user) return toolError('User not found')
        return toolJson({ min_quota_pct: user.min_quota_pct })
      }),
  )
}
