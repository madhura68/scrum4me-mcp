// IDEA-menu slice 1: titel/beschrijving van een bestaand idee bewerken vanuit
// de copilot. Gespiegeld op create-idea.ts (zelfde AVG-gate + error-helpers).
// Product-bound: laadt where:{ id, user_id, product_id } zodat een idee uit een
// ander product van dezelfde binding-user nooit muteerbaar is (cross-product).
import { z } from 'zod'
import type { ClaudeJobKind } from '@prisma/client'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { ideaDescriptionSchema } from '../lib/idea-description.js'
import { ACTIVE_JOB_STATUSES } from '../lib/dispatch/idea-jobs.js'
import { lockIdeaRow } from '../lib/idea-plan-loop.js'
import { parseContentPolicy, checkContentPolicy, ContentPolicyError } from '@shared/content-policy.js'

// Mirror van web's isIdeaEditable: titel/desc mag alleen muteren in een
// "settled" status — nooit tijdens een lopende job (GRILLING/PLANNING/
// REVIEWING_PLAN) of na materialisatie (PLANNED).
const EDITABLE_STATUSES = [
  'DRAFT',
  'GRILL_FAILED',
  'GRILLED',
  'PLAN_FAILED',
  'PLAN_READY',
  'PLAN_REVIEW_FAILED',
  'PLAN_REVIEWED',
] as const

// Afsluiten (status PLANNED) wordt geweigerd zolang een van deze jobs met
// idea_id actief is: een gelijktijdige pipeline-stap of chatbeurt mag niet door
// PLANNED worden overschreven. IDEA_CHAT telt mee, dus een chatbeurt kan haar
// eigen idee niet afsluiten (de eigen RUNNING-job blokkeert dat). Een losse
// SPEC_REVIEW zonder idea_id (dispatchSpecReview) ziet deze guard bewust niet.
const IDEA_CLOSE_BLOCKING_JOB_KINDS = [
  'IDEA_GRILL',
  'IDEA_MAKE_SPEC',
  'IDEA_REVISE_SPEC',
  'SPEC_REVIEW',
  'IDEA_MAKE_PLAN',
  'IDEA_REVIEW_PLAN',
  'IDEA_CHAT',
] as const satisfies readonly ClaudeJobKind[]

const inputSchema = z
  .object({
    idea_id: z.string().min(1),
    product_id: z.string().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    description: ideaDescriptionSchema.optional(),
    status: z.literal('PLANNED').optional(),
  })
  .refine((v) => v.title !== undefined || v.description !== undefined || v.status !== undefined, {
    message: 'minstens één van title, description of status is vereist',
  })

function notEditableMessage(status: string): string {
  return `Idee kan niet bewerkt worden vanuit status ${status} (toegestaan: ${EDITABLE_STATUSES.join(', ')})`
}

// Weigering binnen de afsluit-transactie: wordt na de rollback een toolError.
// Elke weigering valt vóór de eerste write in de callback.
class IdeaCloseRefused extends Error {}

// M17 idea-chat (spec §4.3): doc-updates uit een chat-beurt worden als
// SYSTEM-bericht zichtbaar in het kanaal. Best-effort (ook tegen sync
// fouten): een falende message-write mag de idea-update zelf niet
// terugdraaien of laten falen.
async function writeDocUpdateMessage(ideaId: string, changedFields: string[]): Promise<void> {
  await Promise.resolve()
    .then(() =>
      prisma.ideaChatMessage.create({
        data: {
          idea_id: ideaId,
          role: 'SYSTEM',
          kind: 'DOC_UPDATE',
          content: 'Beschrijving bijgewerkt door de agent',
          metadata: { fields: changedFields },
        },
      }),
    )
    .catch((err: unknown) => {
      console.warn('update_idea: DOC_UPDATE-kanaalbericht mislukt (idea-update is gecommit):', err)
    })
}

export async function handleUpdateIdea(input: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const parsed = inputSchema.parse(input)
    const auth = await requireWriteAccess()

    // Product-bound ownership: ander product óf andere user ⇒ 404-stijl.
    const idea = await prisma.idea.findFirst({
      where: { id: parsed.idea_id, user_id: auth.userId, product_id: parsed.product_id },
      select: { id: true, code: true, status: true },
    })
    if (!idea) {
      return toolError('Idea not found')
    }

    const hasContent = parsed.title !== undefined || parsed.description !== undefined
    // Herhaald afsluiten (retry na een transportfout) is een no-op met succes.
    if (parsed.status === 'PLANNED' && !hasContent && idea.status === 'PLANNED') {
      return toolJson({ id: idea.id, code: idea.code, status: idea.status })
    }

    // AVG content-policy gate (sub-project C): identiek aan create_idea —
    // fail-closed bij een malformed policy, check op de samengevoegde nieuwe tekst.
    // Alleen als er tekst wijzigt: een kale afsluiting voegt geen inhoud toe.
    if (hasContent) {
      const product = await prisma.product.findUnique({
        where: { id: parsed.product_id },
        select: { content_policy: true },
      })
      let policy
      try {
        policy = parseContentPolicy(product?.content_policy)
      } catch (err) {
        if (err instanceof ContentPolicyError) {
          return toolError(`Product content_policy is ongeldig geconfigureerd: ${err.message}`)
        }
        throw err
      }
      const verdict = checkContentPolicy(
        policy,
        `${parsed.title ?? ''}\n${parsed.description ?? ''}`,
      )
      if (!verdict.allowed) {
        return toolError(verdict.reason)
      }
    }

    if (!(EDITABLE_STATUSES as readonly string[]).includes(idea.status)) {
      return toolError(notEditableMessage(idea.status))
    }

    const changedFields = [
      ...(parsed.title !== undefined ? ['title'] : []),
      ...(parsed.description !== undefined ? ['description'] : []),
    ]

    if (parsed.status === 'PLANNED') {
      // Afsluiten: idee-rij op slot, status en jobs herlezen en schrijven in één
      // transactie, zodat een gelijktijdige dispatch niet door PLANNED wordt
      // overschreven (Review Focus 1). Restvenster, bewust geaccepteerd: een
      // dispatch die de status vóór het slot las, schrijft na de commit zijn
      // eigen jobstatus over PLANNED.
      let closed: { id: string; code: string; status: string }
      try {
        closed = await prisma.$transaction(async (tx) => {
          await lockIdeaRow(tx, parsed.idea_id)
          const current = await tx.idea.findUnique({
            where: { id: parsed.idea_id },
            select: { status: true },
          })
          if (!current) {
            throw new IdeaCloseRefused('Idea not found')
          }
          if (!(EDITABLE_STATUSES as readonly string[]).includes(current.status)) {
            throw new IdeaCloseRefused(notEditableMessage(current.status))
          }
          const activeJob = await tx.claudeJob.findFirst({
            where: {
              idea_id: parsed.idea_id,
              kind: { in: [...IDEA_CLOSE_BLOCKING_JOB_KINDS] },
              status: { in: [...ACTIVE_JOB_STATUSES] },
            },
            select: { id: true, kind: true },
          })
          if (activeJob) {
            throw new IdeaCloseRefused(
              `Idee kan niet worden afgesloten: er loopt nog een ${activeJob.kind}-job (${activeJob.id}) — wacht tot die klaar is of annuleer hem`,
            )
          }
          const from = current.status
          const row = await tx.idea.update({
            where: { id: parsed.idea_id },
            data: {
              status: 'PLANNED',
              ...(parsed.title !== undefined ? { title: parsed.title } : {}),
              ...(parsed.description !== undefined ? { description: parsed.description } : {}),
            },
            select: { id: true, code: true, status: true },
          })
          await tx.ideaLog.create({
            data: {
              idea_id: parsed.idea_id,
              type: 'STATUS_CHANGE',
              content: `Status ${from} → PLANNED (update_idea)`,
              metadata: { from, to: 'PLANNED', via: 'update_idea' },
            },
          })
          return row
        })
      } catch (err) {
        if (err instanceof IdeaCloseRefused) {
          return toolError(err.message)
        }
        throw err
      }
      if (changedFields.length > 0) {
        await writeDocUpdateMessage(parsed.idea_id, changedFields)
      }
      return toolJson({ id: closed.id, code: closed.code, status: closed.status })
    }

    const updated = await prisma.idea.update({
      where: { id: parsed.idea_id },
      data: {
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      },
      select: { id: true, code: true, status: true },
    })
    await writeDocUpdateMessage(parsed.idea_id, changedFields)
    return toolJson({ id: updated.id, code: updated.code, status: updated.status })
  })
}

export function registerUpdateIdeaTool(server: McpServer) {
  server.registerTool(
    'update_idea',
    {
      title: 'Update idea',
      description:
        "Update the title and/or description of an existing idea (product-bound), or close it with status: 'PLANNED' once its last ceremony increment is built (sprint/PBI created interactively). At least one of title, description or status is required. Title/description changes are gated by the product content_policy (AVG). Only allowed while the idea is in an editable status. Closing is refused while an idea pipeline or chat job (grill/spec/plan/review/chat) is active. A PLANNED idea leaves get_ideas_context and is no longer editable. Forbidden for demo accounts.",
      inputSchema,
    },
    async (input) => handleUpdateIdea(input),
  )
}
