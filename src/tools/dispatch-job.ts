// src/tools/dispatch-job.ts
// IDEA-118 K12: canonieke kind/ref-matrix — geen legacy manual-validatie.
// PLAN_CHAT en IDEA_CHAT ontbreken bewust (de copilot-/idea-chat ís het
// interactieve kanaal, niet dispatchbaar via dit tool).
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors, formatZodError } from '../errors.js'
import { DispatchError } from '../lib/dispatch/errors.js'
import { dispatchIdeaJob } from '../lib/dispatch/idea-jobs.js'
import { dispatchSprintRun } from '../lib/dispatch/sprint-run.js'
import {
  dispatchPrReview,
  dispatchSpecReview,
  dispatchTaskReview,
} from '../lib/dispatch/review-jobs.js'
import { dispatchTaskImplementation } from '../lib/dispatch/task-implementation.js'
import { dispatchDeploy } from '../lib/dispatch/deploy-dispatch.js'

// Geëxporteerd t.b.v. de invariant-test (copilot idea-chat spec §3.7): IDEA_CHAT
// mag hier NOOIT bij — chat-beurten ontstaan uitsluitend via send_idea_chat_message.
export const KIND_VALUES = [
  'IDEA_GRILL', 'IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN',
  'TASK_IMPLEMENTATION', 'SPRINT_IMPLEMENTATION',
  'PR_REVIEW', 'SPEC_REVIEW', 'TASK_REVIEW', 'DEPLOY',
] as const

type DispatchKind = (typeof KIND_VALUES)[number]

const REF_KEYS = ['idea_id', 'task_id', 'sprint_id', 'doc_slug', 'doc_id', 'pr_url'] as const
type RefKey = (typeof REF_KEYS)[number]

// Per kind: welke refs verplicht zijn. SPEC_REVIEW: precies één van beide.
// DEPLOY (M17 v1): "deploy huidige main", géén refs — extra refs zoals
// pr_url worden door validateRefs geweigerd (niet in required/oneOf).
const REF_MATRIX: Record<DispatchKind, { required: RefKey[]; oneOf?: RefKey[] }> = {
  IDEA_GRILL: { required: ['idea_id'] },
  IDEA_MAKE_PLAN: { required: ['idea_id'] },
  IDEA_REVIEW_PLAN: { required: ['idea_id'] },
  TASK_IMPLEMENTATION: { required: ['task_id'] },
  SPRINT_IMPLEMENTATION: { required: ['sprint_id'] },
  PR_REVIEW: { required: ['pr_url'] },
  SPEC_REVIEW: { required: [], oneOf: ['doc_slug', 'doc_id'] },
  TASK_REVIEW: { required: ['task_id'] },
  DEPLOY: { required: [] },
}

const inputSchema = z.object({
  kind: z.enum(KIND_VALUES),
  product_id: z.string().min(1),
  idea_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  sprint_id: z.string().min(1).optional(),
  doc_slug: z.string().min(1).optional(),
  doc_id: z.string().min(1).optional(),
  pr_url: z.string().url().optional(),
})

type Input = z.infer<typeof inputSchema>

function validateRefs(input: Input): string | null {
  const rule = REF_MATRIX[input.kind]
  const present = REF_KEYS.filter((k) => input[k] !== undefined)
  const allowed = new Set<RefKey>([...rule.required, ...(rule.oneOf ?? [])])
  for (const k of rule.required) {
    if (input[k] === undefined) return `${input.kind} vereist ${k}.`
  }
  if (rule.oneOf) {
    const hits = rule.oneOf.filter((k) => input[k] !== undefined)
    if (hits.length !== 1) return `${input.kind} vereist precies één van: ${rule.oneOf.join(', ')}.`
  }
  const extra = present.filter((k) => !allowed.has(k))
  if (extra.length > 0) return `Niet toegestaan voor ${input.kind}: ${extra.join(', ')}.`
  return null
}

export async function handleDispatchJob(rawInput: Input) {
  // Input-validatie expliciet vóór de auth-/dispatch-fase: een ongeldig
  // verzoek is geen runtime-fout en geeft altijd een VALIDATION_ERROR-shape,
  // nog vóór er ook maar één DB- of auth-call gebeurt.
  const parseResult = inputSchema.safeParse(rawInput)
  if (!parseResult.success) {
    return toolError(`VALIDATION_ERROR: ${formatZodError(parseResult.error)}`)
  }
  const input = parseResult.data
  const refError = validateRefs(input)
  if (refError) return toolError(`VALIDATION_ERROR: ${refError}`)

  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    if (!(await userCanAccessProduct(input.product_id, auth.userId))) {
      return toolError(`Product ${input.product_id} not found or not accessible`)
    }

    try {
      switch (input.kind) {
        case 'IDEA_GRILL':
        case 'IDEA_MAKE_PLAN':
        case 'IDEA_REVIEW_PLAN':
          return toolJson(await dispatchIdeaJob({
            kind: input.kind, ideaId: input.idea_id!, productId: input.product_id, userId: auth.userId,
          }))
        case 'TASK_IMPLEMENTATION':
          return toolJson(await dispatchTaskImplementation({
            taskId: input.task_id!, productId: input.product_id, userId: auth.userId,
          }))
        case 'SPRINT_IMPLEMENTATION':
          return toolJson(await dispatchSprintRun({
            sprintId: input.sprint_id!, productId: input.product_id, userId: auth.userId,
          }))
        case 'PR_REVIEW':
          return toolJson(await dispatchPrReview({
            productId: input.product_id, prUrl: input.pr_url!, userId: auth.userId,
          }))
        case 'SPEC_REVIEW':
          return toolJson(await dispatchSpecReview({
            productId: input.product_id, docSlug: input.doc_slug, docId: input.doc_id, userId: auth.userId,
          }))
        case 'TASK_REVIEW':
          return toolJson(await dispatchTaskReview({
            productId: input.product_id, taskId: input.task_id!, userId: auth.userId,
          }))
        case 'DEPLOY':
          return toolJson(await dispatchDeploy({ productId: input.product_id, userId: auth.userId }))
        default: {
          const _exhaustive: never = input.kind
          return toolError(`Onbekend kind: ${_exhaustive}`)
        }
      }
    } catch (err) {
      if (err instanceof DispatchError) return toolError(err.message)
      throw err
    }
  })
}

export function registerDispatchJobTool(server: McpServer) {
  server.registerTool(
    'dispatch_job',
    {
      title: 'Dispatch job',
      description:
        'Queue a job for the existing runners (source COPILOT). Refs per kind: ' +
        'IDEA_* → idea_id; TASK_IMPLEMENTATION/TASK_REVIEW → task_id; ' +
        'SPRINT_IMPLEMENTATION → sprint_id; PR_REVIEW → pr_url (must belong to the product repo); ' +
        'SPEC_REVIEW → doc_slug or doc_id (SPECS folder of this product); ' +
        'DEPLOY → no refs (deploys current main; requires product.deploy_flow). ' +
        'PLAN_CHAT and IDEA_CHAT are not dispatchable. Forbidden for demo accounts.',
      inputSchema,
    },
    async (input) => handleDispatchJob(input),
  )
}
