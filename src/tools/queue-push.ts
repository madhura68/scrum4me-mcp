import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { formatZodError, toolError, toolJson, withToolErrors } from '../errors.js'
import { parseQueueTarget, resolveQueueIdentity } from '../queue/identity.js'
import { requiresTaskMeta, validateTaskMeta } from '../queue/types.js'
import { deriveRepoFromCwd } from '../queue/git-origin.js'
import { readPresenceBlockBestEffort } from '../queue/presence.js'
import {
  extractWorkItemIds,
  mergeWorkItemInputs,
  resolveWorkItem,
} from '../queue/work-item.js'
import { emitQueueNotifyBestEffort, envelopeOf } from '../queue/notify.js'
import {
  QUEUE_DISPATCH_SERVER,
  QUEUE_JOB_SERVER,
  QUEUE_MODELS,
  QUEUE_REQUEST_TYPES,
  QUEUE_SERVERS,
  formatQueueAddress,
} from '@shared/queue-identity.js'
import { reviewDocumentsSchema } from '@shared/queue-review-documents.js'

function objectHasOwn(value: unknown, key: string): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, key)
}

function validateReviewDocumentsMeta(meta: Record<string, unknown>) {
  if (objectHasOwn(meta.task, 'review_documents')) {
    return toolError(
      'VALIDATION_ERROR: meta.review_documents must be a sibling of meta.task, ' +
        'not nested inside meta.task',
    )
  }
  if (!Object.prototype.hasOwnProperty.call(meta, 'review_documents')) return null

  const parsed = reviewDocumentsSchema.safeParse(meta.review_documents)
  if (!parsed.success) {
    return toolError(`VALIDATION_ERROR: meta.review_documents: ${formatZodError(parsed.error)}`)
  }
  meta.review_documents = parsed.data
  return null
}

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
        'For pinned review material, pass immutable sources as meta.review_documents ' +
        '(sibling of meta.task, version 1, product_doc and/or git refs). ' +
        'When this message is about Scrum4Me work you are doing — almost always a task or review_request tied to a story — pass its id via sprint_id/story_id/task_id so it is traceable on the dashboard. ' +
        'The most specific id you have is enough: the tool derives the rest of the hierarchy (product_id included) via the story, stores it as meta.work_item, and rejects unknown/inconsistent ids. Start with get_context; get story/task IDs from get_sprint_context for the sprint within your assignment, or from the story/task you are working on. ' +
        'Returns message_id — fetch the answer later with queue_wait_reply({ message_ids: [message_id] }). ' +
        'This tool always sends to the one address you name; to have work routed and executed automatically instead, use dispatch_task or dispatch_review.',
      inputSchema,
    },
    async ({ to, type, body, meta, cwd, as, sprint_id, story_id, task_id }) =>
      withToolErrors(async () => {
        await requireWriteAccess()
        const from = resolveQueueIdentity(as)
        const target = parseQueueTarget(to)
        if (target.server === QUEUE_DISPATCH_SERVER) {
          return toolError(
            `VALIDATION_ERROR: ${QUEUE_DISPATCH_SERVER} is reserved for managed dispatch projection`,
          )
        }
        // The job id lives on the model position — the columns stay text (M30 §5).
        const dest =
          target.server === QUEUE_JOB_SERVER
            ? { server: target.server as string, model: target.jobId }
            : { server: target.server as string, model: target.model }

        const finalMeta: Record<string, unknown> = { ...(meta ?? {}) }
        const reviewDocumentsError = validateReviewDocumentsMeta(finalMeta)
        if (reviewDocumentsError) return reviewDocumentsError
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
        const workItem = await resolveWorkItem(
          mergeWorkItemInputs(
            { sprint_id, story_id, task_id },
            extractWorkItemIds(finalMeta.work_item),
          ),
        )
        if (workItem) finalMeta.work_item = workItem as unknown as Record<string, unknown>
        else delete finalMeta.work_item

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
            ppe_protocol: null,
            ppe_run_id: null,
            ppe_operation_key: null,
            ppe_payload_sha256: null,
            ppe_from_principal: null,
            ppe_to_principal: null,
            ppe_to_consumer_id: null,
            ppe_consumer_generation: null,
            ppe_lease_generation: null,
          },
        })
        // NOTIFY after commit, best-effort (§5.1) — CLI --wait and the
        // Messages-dashboard receive the same byte-compatible envelope.
        await emitQueueNotifyBestEffort(envelopeOf(row, null))
        // IDEA-194 §6.4: presence van de bestemming — informatie, nooit een
        // gate. Best-effort: elke fout ⇒ veld weglaten, de push is geslaagd.
        // Het job-namespace heeft geen (server, model)-adres.
        const presence =
          target.server === QUEUE_JOB_SERVER
            ? null
            : await readPresenceBlockBestEffort(dest.server, dest.model)
        return toolJson({
          message_id: row.id,
          to: formatQueueAddress(target),
          type,
          ...(presence ? { presence } : {}),
          hint: `Fetch the reply with queue_wait_reply({ message_ids: ["${row.id}"] })`,
        })
      }),
  )
}
