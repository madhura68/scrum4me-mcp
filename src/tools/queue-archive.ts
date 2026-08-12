import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { QUEUE_TERMINAL_STATUSES } from '@shared/queue-identity.js'

const inputSchema = z.object({ message_id: z.string().uuid() })

interface SubtreeRow { id: string; status: string; archived_at: Date | null }

/**
 * Recursive subtree (rij + alle transitieve replies), FOR UPDATE gelockt
 * binnen de omringende $transaction. Zelfde semantiek als s4m-queue
 * archiveSubtree/unarchiveSubtree (spec §4.2): per rij idempotent, alleen
 * terminale rijen archiveerbaar, géén NOTIFY.
 */
async function lockSubtree(tx: unknown, messageId: string): Promise<SubtreeRow[]> {
  const t = tx as { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<SubtreeRow[]> }
  return t.$queryRaw`
    WITH RECURSIVE subtree AS (
      SELECT id FROM agent_message WHERE id = ${messageId}::uuid
      UNION
      SELECT child.id FROM agent_message child JOIN subtree parent ON child.in_reply_to = parent.id
    )
    SELECT id, status, archived_at FROM agent_message
     WHERE id IN (SELECT id FROM subtree)
     FOR UPDATE`
}

export function registerQueueArchiveTools(server: McpServer) {
  server.registerTool(
    'queue_archive',
    {
      title: 'Queue archive',
      description:
        'Archive a terminal queue message plus its full reply subtree (sets archived_at; ' +
        'reversible with queue_unarchive). Refuses when any row in the subtree is not terminal. ' +
        'Row-level idempotent: already-archived rows keep their original timestamp.',
      inputSchema,
      annotations: { idempotentHint: true },
    },
    async ({ message_id }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        return prisma.$transaction(async (tx) => {
          const rows = await lockSubtree(tx, message_id)
          if (rows.length === 0) return toolError(`QUEUE_NOT_FOUND: message ${message_id} does not exist`)
          const blocking = rows.find(
            (r) => !(QUEUE_TERMINAL_STATUSES as readonly string[]).includes(r.status),
          )
          if (blocking) {
            return toolError(
              `QUEUE_NOT_TERMINAL: subtree row ${blocking.id} has status '${blocking.status}' — only terminal messages can be archived`,
            )
          }
          const ids = rows.map((r) => r.id)
          const upd = await (tx as typeof prisma).agentMessage.updateMany({
            where: { id: { in: ids }, archived_at: null },
            data: { archived_at: new Date() },
          })
          return toolJson({ message_id, total: ids.length, archived: upd.count })
        })
      }),
  )

  server.registerTool(
    'queue_unarchive',
    {
      title: 'Queue unarchive',
      description:
        'Clear archived_at on a queue message plus its full reply subtree — also when the root ' +
        'itself is active (mixed trees). Row-level idempotent.',
      inputSchema,
      annotations: { idempotentHint: true },
    },
    async ({ message_id }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        return prisma.$transaction(async (tx) => {
          const rows = await lockSubtree(tx, message_id)
          if (rows.length === 0) return toolError(`QUEUE_NOT_FOUND: message ${message_id} does not exist`)
          const ids = rows.map((r) => r.id)
          const upd = await (tx as typeof prisma).agentMessage.updateMany({
            where: { id: { in: ids }, archived_at: { not: null } },
            data: { archived_at: null },
          })
          return toolJson({ message_id, total: ids.length, unarchived: upd.count })
        })
      }),
  )
}
