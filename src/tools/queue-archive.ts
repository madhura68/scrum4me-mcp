import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { QUEUE_TERMINAL_STATUSES } from '@shared/queue-identity.js'

const inputSchema = z.object({ message_id: z.string().uuid() })

interface SubtreeRow { id: string; status: string; archived_at: Date | null; dispatch_request_id: string | null }

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
    SELECT id, status, archived_at, dispatch_request_id FROM agent_message
     WHERE id IN (SELECT id FROM subtree)
     FOR UPDATE`
}

const terminal = (r: SubtreeRow) => (QUEUE_TERMINAL_STATUSES as readonly string[]).includes(r.status)
/** IDEA-213: on a managed row an ordinary role may change archived_at only once that row is terminal. A thread
 * that holds a managed row is therefore archived or unarchived as a whole or not at all — refused here, before
 * any write, instead of failing halfway on the row guard. */
function managedBlock(rows: SubtreeRow[]): string | null {
  const active = rows.some((r) => r.dispatch_request_id != null) ? rows.find((r) => !terminal(r)) : undefined
  return active ? `QUEUE_MANAGED_NOT_TERMINAL: subtree row ${active.id} has status '${active.status}' — a managed dispatch thread changes its archive state only as a whole, once every message is terminal` : null
}

export async function archiveQueueSubtree(message_id: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await lockSubtree(tx, message_id)
    if (rows.length === 0) return toolError(`QUEUE_NOT_FOUND: message ${message_id} does not exist`)
    const managed = managedBlock(rows)
    if (managed) return toolError(managed)
    const blocking = rows.find((r) => !terminal(r))
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
}
export async function unarchiveQueueSubtree(message_id: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await lockSubtree(tx, message_id)
    if (rows.length === 0) return toolError(`QUEUE_NOT_FOUND: message ${message_id} does not exist`)
    const managed = managedBlock(rows)
    if (managed) return toolError(managed)
    const ids = rows.map((r) => r.id)
    const upd = await (tx as typeof prisma).agentMessage.updateMany({
      where: { id: { in: ids }, archived_at: { not: null } },
      data: { archived_at: null },
    })
    return toolJson({ message_id, total: ids.length, unarchived: upd.count })
  })
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
        return archiveQueueSubtree(message_id)
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
        return unarchiveQueueSubtree(message_id)
      }),
  )
}
