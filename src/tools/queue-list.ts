import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson, withToolErrors } from '../errors.js'
import { resolveQueueIdentity } from '../queue/identity.js'
import { messageView } from '../queue/view.js'

const inputSchema = z.object({
  direction: z.enum(['sent', 'received', 'both']).default('both'),
  include_terminal: z.boolean().default(false),
  as: z.enum(['claude', 'codex', 'jp']).optional(),
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
        'outstanding request ids — feed them straight into queue_wait_reply; nothing is orphaned.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ direction, include_terminal, as }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const self = resolveQueueIdentity(as)
        const dir = direction ?? 'both'
        const includeTerminal = include_terminal ?? false
        const sent = { from_server: self.server, from_model: self.model }
        const received = { to_server: self.server, to_model: self.model }
        const where: Record<string, unknown> =
          dir === 'sent' ? { ...sent } : dir === 'received' ? { ...received } : { OR: [sent, received] }
        if (!includeTerminal) where.status = { in: ['pending', 'claimed'] }
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
