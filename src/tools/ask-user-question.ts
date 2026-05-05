// ST-1102: ask_user_question — Claude vraagt aan de actieve gebruiker via een
// gestructureerde vraag in claude_questions. De Postgres-trigger emit op
// scrum4me_changes; de Scrum4Me-app toont een notificatie-badge en de gebruiker
// antwoordt in de UI. Met optionele `wait_seconds` polt deze tool intern op
// het antwoord; default async (returnt direct met question_id).

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessStory, userOwnsIdea } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const PENDING_TTL_HOURS = 24
const POLL_INTERVAL_MS = 2_000
const MAX_WAIT_SECONDS = 600

// M12: schema accepteert exact één van story_id of idea_id (xor refine).
const inputSchema = z
  .object({
    story_id: z.string().min(1).optional(),
    idea_id: z.string().min(1).optional(),
    question: z.string().min(1).max(4_000),
    options: z.array(z.string().min(1)).max(8).optional(),
    task_id: z.string().min(1).optional(),
    wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional(),
  })
  .refine((d) => Boolean(d.story_id) !== Boolean(d.idea_id), {
    message: 'Provide exactly one of story_id or idea_id',
  })

function summarize(q: {
  id: string
  status: string
  question: string
  options: unknown
  answer: string | null
  answered_by: string | null
  answered_at: Date | null
  expires_at: Date
}) {
  return {
    question_id: q.id,
    status: q.status,
    question: q.question,
    options: q.options,
    answer: q.answer,
    answered_by: q.answered_by,
    answered_at: q.answered_at?.toISOString() ?? null,
    expires_at: q.expires_at.toISOString(),
  }
}

export function registerAskUserQuestionTool(server: McpServer) {
  server.registerTool(
    'ask_user_question',
    {
      title: 'Ask user question',
      description:
        'Post a question to the active Scrum4Me user about a story Claude is implementing. ' +
        'Returns immediately with status="open" by default; pass `wait_seconds` (max 600) to ' +
        'poll internally and return the answer as soon as the user submits it. Forbidden for ' +
        'demo accounts.',
      inputSchema,
    },
    async ({ story_id, idea_id, question, options, task_id, wait_seconds }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()

        // M12: branch on which scope was provided. story_id en idea_id sluiten
        // elkaar uit (zod-refine in inputSchema).
        let productId: string
        if (idea_id) {
          if (!(await userOwnsIdea(idea_id, auth.userId))) {
            return toolError(`Idea ${idea_id} not found`)
          }
          const idea = await prisma.idea.findUnique({
            where: { id: idea_id },
            select: { product_id: true },
          })
          if (!idea?.product_id) {
            // Idee zonder product mag pas Q&A starten als product gekoppeld is
            // (M12 grill-keuze 3: product met repo verplicht voor grill).
            return toolError(`Idea ${idea_id} has no linked product`)
          }
          productId = idea.product_id
        } else if (story_id) {
          if (!(await userCanAccessStory(story_id, auth.userId))) {
            return toolError(`Story ${story_id} not found or not accessible`)
          }
          const story = await prisma.story.findUnique({
            where: { id: story_id },
            select: { product_id: true },
          })
          if (!story) {
            return toolError(`Story ${story_id} not found`)
          }
          productId = story.product_id

          if (task_id) {
            const task = await prisma.task.findFirst({
              where: { id: task_id, story_id },
              select: { id: true },
            })
            if (!task) {
              return toolError(`Task ${task_id} does not belong to story ${story_id}`)
            }
          }
        } else {
          // Mag niet voorkomen door de zod-refine, maar TS-narrow.
          return toolError('Provide exactly one of story_id or idea_id')
        }

        const created = await prisma.claudeQuestion.create({
          data: {
            story_id: story_id ?? null,
            idea_id: idea_id ?? null,
            task_id: task_id ?? null,
            product_id: productId,
            asked_by: auth.userId,
            question,
            // Prisma's `Json?`-veld accepteert geen `null`-literal in `data`;
            // door undefined fields uit te sluiten laten we DB-default kicken.
            ...(options !== undefined ? { options } : {}),
            status: 'open',
            expires_at: new Date(Date.now() + PENDING_TTL_HOURS * 60 * 60 * 1000),
          },
        })

        // Async-mode (default): return direct.
        if (!wait_seconds || wait_seconds === 0) {
          return toolJson(summarize(created))
        }

        // Sync-mode: poll tot status verandert of timeout.
        const deadline = Date.now() + wait_seconds * 1000
        let current = created
        while (current.status === 'open' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
          const refreshed = await prisma.claudeQuestion.findUnique({
            where: { id: created.id },
          })
          if (!refreshed) break
          current = refreshed
        }

        // Eindstatus: answered/cancelled/expired → return met antwoord; nog open → 'pending'
        if (current.status === 'open') {
          return toolJson({ ...summarize(current), status: 'pending' })
        }
        return toolJson(summarize(current))
      }),
  )
}
