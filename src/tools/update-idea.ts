// IDEA-menu slice 1: titel/beschrijving van een bestaand idee bewerken vanuit
// de copilot. Gespiegeld op create-idea.ts (zelfde AVG-gate + error-helpers).
// Product-bound: laadt where:{ id, user_id, product_id } zodat een idee uit een
// ander product van dezelfde binding-user nooit muteerbaar is (cross-product).
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
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

const inputSchema = z
  .object({
    idea_id: z.string().min(1),
    product_id: z.string().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
  })
  .refine((v) => v.title !== undefined || v.description !== undefined, {
    message: 'minstens één van title/description is vereist',
  })

export async function handleUpdateIdea(input: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const parsed = inputSchema.parse(input)
    const auth = await requireWriteAccess()

    // Product-bound ownership: ander product óf andere user ⇒ 404-stijl.
    const idea = await prisma.idea.findFirst({
      where: { id: parsed.idea_id, user_id: auth.userId, product_id: parsed.product_id },
      select: { id: true, status: true },
    })
    if (!idea) {
      return toolError('Idea not found')
    }

    // AVG content-policy gate (sub-project C): identiek aan create_idea —
    // fail-closed bij een malformed policy, check op de samengevoegde nieuwe tekst.
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

    if (!(EDITABLE_STATUSES as readonly string[]).includes(idea.status)) {
      return toolError(
        `Idee kan niet bewerkt worden vanuit status ${idea.status} (toegestaan: ${EDITABLE_STATUSES.join(', ')})`,
      )
    }

    const updated = await prisma.idea.update({
      where: { id: parsed.idea_id },
      data: {
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      },
      select: { id: true, code: true, status: true },
    })
    return toolJson({ id: updated.id, code: updated.code, status: updated.status })
  })
}

export function registerUpdateIdeaTool(server: McpServer) {
  server.registerTool(
    'update_idea',
    {
      title: 'Update idea',
      description:
        'Update the title and/or description of an existing idea (product-bound). At least one of title/description is required. Gated by the product content_policy (AVG). Only allowed while the idea is in an editable status. Forbidden for demo accounts.',
      inputSchema,
    },
    async (input) => handleUpdateIdea(input),
  )
}
