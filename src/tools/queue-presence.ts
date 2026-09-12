import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'
import { readPresenceViews } from '../queue/presence.js'
import { PRESENCE_FRESH_SECONDS, QUEUE_MODELS, QUEUE_SERVERS } from '@shared/queue-identity.js'

const inputSchema = z.object({
  // Afgeleid van het gedeelde vocabulaire, nooit overgetypt (pariteitsgate).
  server: z.enum(QUEUE_SERVERS).optional(),
  model: z.enum(QUEUE_MODELS).optional(),
})

export function registerQueuePresenceTool(server: McpServer) {
  server.registerTool(
    'queue_presence',
    {
      title: 'Queue presence',
      description:
        'Read-only: presence per queue address — status (weg/bezig/beschikbaar/onbemand), ' +
        `watcher heartbeat age (fresh = ≤${PRESENCE_FRESH_SECONDS}s, or a self-declared session.expected_by in the future for poll-loop sessions), session signals and open claims. ` +
        'Presence is cached information, never a gate: a stale or missing row only means nobody ' +
        'proved liveness recently — keep pushing and keep the claim watchdog. ' +
        'Optional {server, model} filter; a full filter without a row returns one synthetic "weg" entry.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ server: srv, model }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const presence = await readPresenceViews({ server: srv, model })
        return toolJson({ presence })
      }),
  )
}
