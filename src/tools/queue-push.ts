import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { parseQueueTarget, resolveQueueIdentity } from '../queue/identity.js'
import { requiresTaskMeta, validateTaskMeta } from '../queue/types.js'
import { deriveRepoFromCwd } from '../queue/git-origin.js'
import {
  extractWorkItemIds,
  mergeWorkItemInputs,
  resolveWorkItem,
} from '../queue/work-item.js'
import { emitQueueNotifyBestEffort, envelopeOf } from '../queue/notify.js'
import {
  QUEUE_JOB_SERVER,
  QUEUE_MODELS,
  QUEUE_REQUEST_TYPES,
  QUEUE_SERVERS,
  formatQueueAddress,
} from '@shared/queue-identity.js'

const inputSchema = z.object({
  to: z.string().min(1),
  // Afgeleid, net als `as` hieronder: dit is exact QUEUE_REQUEST_TYPES. De
  // overgetypte variant zou een nieuw verzoek-type stil weigeren terwijl de
  // handler (requiresTaskMeta/queueReplyTypeFor) er wél op gebouwd is.
  type: z.enum(QUEUE_REQUEST_TYPES),
  body: z.string().min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
  cwd: z.string().min(1).optional(),
  // Afgeleid van het gedeelde vocabulaire, niet overgetypt: een hardgecodeerde
  // lijst weigerde 'kimi' in Zod vóórdat identity.ts (die wél tegen
  // QUEUE_MODELS toetst) ooit draaide, en niets maakte die drift rood.
  as: z.enum(QUEUE_MODELS).optional(),
  // Spec 2026-08-20 (work-item-ids): optionele koppeling aan Scrum4Me-werk.
  // De tool leidt de hiërarchie af en valideert; zie src/queue/work-item.ts.
  sprint_id: z.string().min(1).optional(),
  story_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
})

export function registerQueuePushTool(server: McpServer) {
  server.registerTool(
    'queue_push',
    {
      title: 'Queue push',
      description:
        'Send a message to another agent or human via the s4m-queue. ' +
        `Target: '<server>:<model>' (servers: ${QUEUE_SERVERS.join(', ')}; ` +
        `models: ${QUEUE_MODELS.join(', ')}) or '${QUEUE_JOB_SERVER}:<jobid>' ` +
        '(M30 job namespace — opaque job id on the model position). ' +
        'Types: task (do something + report result), info (question/data — also for yes/no to jp), ' +
        'review_request (review a document). For task/review_request supply cwd plus meta.task ' +
        '{objective, verification, response_format}; the tool derives meta.task.repo via ' +
        '`git remote get-url origin` in that cwd (pass meta.task.repo explicitly when derivation fails). ' +
        'Optional sprint_id/story_id/task_id link the message to Scrum4Me work items: the tool derives the full hierarchy via the story (product_id included) and stores it as meta.work_item; inconsistent or unknown ids are rejected. ' +
        'Returns message_id — fetch the answer later with queue_wait_reply({ message_ids: [message_id] }).',
      inputSchema,
    },
    async ({ to, type, body, meta, cwd, as, sprint_id, story_id, task_id }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const from = resolveQueueIdentity(as)
        const target = parseQueueTarget(to)
        // The job id lives on the model position — the columns stay text (M30 §5).
        const dest =
          target.server === QUEUE_JOB_SERVER
            ? { server: target.server as string, model: target.jobId }
            : { server: target.server as string, model: target.model }

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

        // Work-item-canonicalisatie (spec §3-§4): parameters ∪ caller-blok →
        // resolver. Een caller-geleverd meta.work_item gaat nooit ongevalideerd
        // door; product_id wordt altijd afgeleid, nooit overgenomen.
        try {
          const workItem = await resolveWorkItem(
            mergeWorkItemInputs(
              { sprint_id, story_id, task_id },
              extractWorkItemIds(finalMeta.work_item),
            ),
          )
          if (workItem) finalMeta.work_item = workItem as unknown as Record<string, unknown>
          else delete finalMeta.work_item
        } catch (err) {
          return toolError(
            err instanceof Error && err.message.startsWith('VALIDATION_ERROR')
              ? err.message
              : `VALIDATION_ERROR: ${err instanceof Error ? err.message : String(err)}`,
          )
        }

        const row = await prisma.agentMessage.create({
          data: {
            type,
            from_server: from.server,
            from_model: from.model,
            to_server: dest.server,
            to_model: dest.model,
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
          to: formatQueueAddress(target),
          type,
          hint: `Fetch the reply with queue_wait_reply({ message_ids: ["${row.id}"] })`,
        })
      }),
  )
}
