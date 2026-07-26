import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { parseQueueTarget, resolveQueueIdentity } from '../queue/identity.js'
import { requiresTaskMeta, validateTaskMeta } from '../queue/types.js'
import { deriveRepoFromCwd } from '../queue/git-origin.js'
import { emitQueueNotifyBestEffort, envelopeOf } from '../queue/notify.js'

const inputSchema = z.object({
  to: z.string().min(1),
  type: z.enum(['task', 'info', 'review_request']),
  body: z.string().min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
  cwd: z.string().min(1).optional(),
  as: z.enum(['claude', 'codex', 'jp']).optional(),
})

export function registerQueuePushTool(server: McpServer) {
  server.registerTool(
    'queue_push',
    {
      title: 'Queue push',
      description:
        'Send a message to another agent or human via the s4m-queue. ' +
        "Target: '<server>:<model>' (servers: mac, scrum4me-server, max2; models: claude, codex, jp). " +
        'Types: task (do something + report result), info (question/data — also for yes/no to jp), ' +
        'review_request (review a document). For task/review_request supply cwd plus meta.task ' +
        '{objective, verification, response_format}; the tool derives meta.task.repo via ' +
        '`git remote get-url origin` in that cwd (pass meta.task.repo explicitly when derivation fails). ' +
        'Returns message_id — fetch the answer later with queue_wait_reply({ message_ids: [message_id] }).',
      inputSchema,
    },
    async ({ to, type, body, meta, cwd, as }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const from = resolveQueueIdentity(as)
        const target = parseQueueTarget(to)

        const finalMeta: Record<string, unknown> = { ...(meta ?? {}) }
        if (requiresTaskMeta(type)) {
          const task: Record<string, unknown> = {
            ...((finalMeta.task as Record<string, unknown> | undefined) ?? {}),
          }
          // Explicit meta.task.cwd wins over the convenience parameter.
          if (cwd && typeof task.cwd !== 'string') task.cwd = cwd
          if (typeof task.repo !== 'string' && typeof task.cwd === 'string') {
            const derived = await deriveRepoFromCwd(task.cwd)
            if (derived) task.repo = derived
          }
          if (typeof task.repo !== 'string') {
            return toolError(
              'VALIDATION_ERROR: meta.task.repo is missing and could not be derived via ' +
                '`git remote get-url origin` in cwd — pass meta.task.repo explicitly',
            )
          }
          finalMeta.task = validateTaskMeta(task) as unknown as Record<string, unknown>
        }

        const row = await prisma.agentMessage.create({
          data: {
            type,
            from_server: from.server,
            from_model: from.model,
            to_server: target.server,
            to_model: target.model,
            body,
            meta: finalMeta as Prisma.InputJsonValue,
            source: 'mcp',
            status: 'pending',
          },
        })
        // NOTIFY after commit, best-effort (§5.1) — CLI --wait and the
        // Messages-dashboard receive the same byte-compatible envelope.
        await emitQueueNotifyBestEffort(envelopeOf(row, null))
        return toolJson({
          message_id: row.id,
          to: `${target.server}:${target.model}`,
          type,
          hint: `Fetch the reply with queue_wait_reply({ message_ids: ["${row.id}"] })`,
        })
      }),
  )
}
