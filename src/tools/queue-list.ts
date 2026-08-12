import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'
import { resolveQueueIdentity } from '../queue/identity.js'
import { messageView } from '../queue/view.js'
import { QUEUE_MODELS, QUEUE_STATUSES, QUEUE_TERMINAL_STATUSES } from '@shared/queue-identity.js'

// 'Niet-terminaal' is het complement van QUEUE_TERMINAL_STATUSES, dus afgeleid
// in plaats van overgetypt. Vandaag exact ['pending', 'claimed']; komt er ooit
// een zesde, niet-terminale status bij, dan valt die niet stil buiten de
// default-lijst. `direction` hieronder blijft wél een eigen literal-lijst: dat
// is MCP-eigen tool-vocabulaire, het staat niet in de gedeelde module.
const NON_TERMINAL_STATUSES: readonly string[] = QUEUE_STATUSES.filter(
  (status) => !(QUEUE_TERMINAL_STATUSES as readonly string[]).includes(status),
)

const inputSchema = z.object({
  direction: z.enum(['sent', 'received', 'both']).default('both'),
  include_terminal: z.boolean().default(false),
  include_archived: z.boolean().default(false),
  // Zie queue-push.ts: afgeleid van QUEUE_MODELS, nooit overgetypt.
  as: z.enum(QUEUE_MODELS).optional(),
})

export function registerQueueListTool(server: McpServer) {
  server.registerTool(
    'queue_list',
    {
      title: 'Queue list',
      description:
        'Read-only, non-claiming: queue messages where your own address is sender or addressee. ' +
        'Default: non-terminal only (pending/claimed) — outstanding own requests plus waiting work. ' +
        "Lost-handle recovery: after a session crash, queue_list({direction:'sent'}) returns the " +
        'outstanding request ids — feed them straight into queue_wait_reply; nothing is orphaned. ' +
        'Archived messages are hidden by default; pass include_archived: true to see them.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ direction, include_terminal, include_archived, as }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const self = resolveQueueIdentity(as)
        const dir = direction ?? 'both'
        const includeTerminal = include_terminal ?? false
        const sent = { from_server: self.server, from_model: self.model }
        const received = { to_server: self.server, to_model: self.model }
        const where: Record<string, unknown> =
          dir === 'sent' ? { ...sent } : dir === 'received' ? { ...received } : { OR: [sent, received] }
        if (!includeTerminal) where.status = { in: [...NON_TERMINAL_STATUSES] }
        if (!(include_archived ?? false)) where.archived_at = null
        const rows = await prisma.agentMessage.findMany({
          where,
          orderBy: { created_at: 'desc' },
          take: 50,
        })
        return toolJson({
          direction: dir,
          include_terminal: includeTerminal,
          count: rows.length,
          messages: rows.map(messageView),
        })
      }),
  )
}
