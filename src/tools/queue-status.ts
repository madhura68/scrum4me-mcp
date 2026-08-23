import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { messageView } from '../queue/view.js'
import { legacyMarkerWhere } from '../queue/marked.js'

const inputSchema = z.object({
  message_id: z.string().uuid(),
})

export function registerQueueStatusTool(server: McpServer) {
  server.registerTool(
    'queue_status',
    {
      title: 'Queue status',
      description:
        'Read-only, non-claiming: one queue message plus all replies to it ' +
        '(in_reply_to = message_id). Use for "is there an answer yet?" without mutating anything.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ message_id }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const row = await prisma.agentMessage.findFirst({
          where: { id: message_id, ...legacyMarkerWhere() },
        })
        if (!row) return toolError(`QUEUE_NOT_FOUND: message ${message_id} does not exist`)
        const replies = await prisma.agentMessage.findMany({
          where: { in_reply_to: message_id, ...legacyMarkerWhere() },
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        })
        return toolJson({ message: messageView(row), replies: replies.map(messageView) })
      }),
  )
}
