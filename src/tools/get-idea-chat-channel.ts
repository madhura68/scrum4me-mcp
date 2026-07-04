// Copilot idea-chat (spec 2026-07-04 §5.1): kanaal-fetch voor de copilot-service.
// Query-laag spiegelt Scrum4Me web lib/idea-chat-server.ts; merge/cursor komen
// uit de canonieke shared-lib. question_states = verse snapshot (spec §3.4b / §5.1
// Overlay-dekking): álle open+niet-verlopen vragen ∪ recentste 50.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { itemIsAfter, itemIsBefore, mergeChannelItems, type MergeInput } from '@shared/idea-chat.js'

const PAGE_SIZE = 50
const cursorRe = /^[^|]+\|.+$/

const inputSchema = z.object({
  product_id: z.string().min(1),
  idea_id: z.string().min(1),
  after: z.string().regex(cursorRe).optional(),
  before: z.string().regex(cursorRe).optional(),
})

export function registerGetIdeaChatChannelTool(server: McpServer) {
  server.registerTool(
    'get_idea_chat_channel',
    {
      title: 'Get idea chat channel',
      description:
        'Kanaal-items (berichten/logs/vragen) van een idee, met composiet-cursor, active_job en question_states (copilot idea-chat).',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) =>
      withToolErrors(async () => {
        const parsed = inputSchema.parse(input)
        if (parsed.after && parsed.before) return toolError('after en before sluiten elkaar uit')
        const auth = await getAuth()
        if (!(await userCanAccessProduct(parsed.product_id, auth.userId))) {
          return toolError(`Product ${parsed.product_id} not found or not accessible`)
        }
        const idea = await prisma.idea.findUnique({
          where: { id: parsed.idea_id },
          select: { user_id: true, product_id: true },
        })
        if (!idea || idea.user_id !== auth.userId || idea.product_id !== parsed.product_id) {
          // anti-enum: grens-mismatch is niet te onderscheiden van niet-bestaan
          return toolError('Idea not found')
        }

        const parseCursor = (c?: string) => (c ? { at: new Date(c.split('|')[0]), id: c.split('|')[1] } : null)
        const before = parseCursor(parsed.before)
        const after = parseCursor(parsed.after)
        const cursorWhere = before
          ? { OR: [{ created_at: { lt: before.at } }, { created_at: before.at, id: { lt: before.id } }] }
          : after
            ? { OR: [{ created_at: { gt: after.at } }, { created_at: after.at, id: { gt: after.id } }] }
            : {}

        const [messages, logs, claudeQuestions, userQuestions, activeJob, openStates, recentStates] =
          await Promise.all([
            prisma.ideaChatMessage.findMany({
              where: { idea_id: parsed.idea_id, ...cursorWhere },
              orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
              take: PAGE_SIZE,
              select: { id: true, role: true, kind: true, content: true, metadata: true, job_id: true, created_at: true },
            }),
            prisma.ideaLog.findMany({
              where: { idea_id: parsed.idea_id, ...cursorWhere },
              orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
              take: PAGE_SIZE,
              select: { id: true, type: true, content: true, metadata: true, created_at: true },
            }),
            prisma.claudeQuestion.findMany({
              where: { idea_id: parsed.idea_id, ...cursorWhere },
              orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
              take: PAGE_SIZE,
              select: { id: true, question: true, options: true, status: true, answer: true, expires_at: true, created_at: true },
            }),
            prisma.userQuestion.findMany({
              where: { idea_id: parsed.idea_id, ...cursorWhere },
              orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
              take: PAGE_SIZE,
              select: { id: true, question: true, answer: true, status: true, created_at: true },
            }),
            prisma.claudeJob.findFirst({
              where: { idea_id: parsed.idea_id, kind: 'IDEA_CHAT', status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] } },
              select: { id: true, kind: true, status: true },
            }),
            // Overlay-snapshot (spec §5.1, normatief): álle open én niet-verlopen
            // vragen — bewust ZONDER take; de 24u-expiry begrenst deze set van nature.
            prisma.claudeQuestion.findMany({
              where: { idea_id: parsed.idea_id, status: 'open', expires_at: { gt: new Date() } },
              orderBy: { created_at: 'desc' },
              select: { id: true, status: true, answer: true, expires_at: true },
            }),
            // ∪ recentste 50 (ongeacht status) — vangt open→answered/expired-mutaties op.
            prisma.claudeQuestion.findMany({
              where: { idea_id: parsed.idea_id },
              orderBy: { created_at: 'desc' },
              take: 50,
              select: { id: true, status: true, answer: true, expires_at: true },
            }),
          ])

        let items = mergeChannelItems({
          messages: messages.map((m) => ({ ...m, created_at: m.created_at.toISOString() })),
          logs: logs.map((l) => ({ ...l, created_at: l.created_at.toISOString() })),
          claudeQuestions: claudeQuestions.map((q) => ({
            ...q,
            created_at: q.created_at.toISOString(),
            expires_at: q.expires_at ? q.expires_at.toISOString() : null,
          })),
          userQuestions: userQuestions.map((u) => ({ ...u, created_at: u.created_at.toISOString() })),
        } satisfies MergeInput)
        if (parsed.after) items = items.filter((i) => itemIsAfter(i, parsed.after!))
        else if (parsed.before) items = items.filter((i) => itemIsBefore(i, parsed.before!)).slice(0, PAGE_SIZE)
        else items = items.slice(0, PAGE_SIZE)

        // open ∪ recent, dedup op id (open wint — is per definitie de verse status)
        const stateById = new Map([...recentStates, ...openStates].map((q) => [q.id, q]))
        return toolJson({
          items,
          active_job: activeJob,
          question_states: [...stateById.values()].map((q) => ({
            id: q.id,
            status: q.status,
            answer: q.answer,
            expires_at: q.expires_at ? q.expires_at.toISOString() : null,
          })),
        })
      }),
  )
}
