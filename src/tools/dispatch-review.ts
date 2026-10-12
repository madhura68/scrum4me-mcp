import { z } from 'zod'
import { UsageIdeaPhase } from '@prisma/client'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolJson } from '../errors.js'
import { DispatchError } from '../dispatch/errors.js'
import { buildInput, commonFields, submit, submitRaw, withDispatchErrors } from './dispatch-common.js'

const documentRef = z.object({}).passthrough()
const inputSchema = z.object({
  ...commonFields,
  review_documents: z.object({ version: z.literal(1), items: z.array(documentRef).min(1) })
    .describe('The exact documents to review, each pinned by revision or commit and sha256. The reviewer reads these versions, never the latest.'),
  repository: z.object({ product_id: z.string().min(1), base_sha: z.string().regex(/^[a-f0-9]{40}$/) }).strict().optional()
    .describe('Optional read-only checkout of this commit in /work so the reviewer can check claims against the code.'),
  idea_link: z.object({ idea_id: z.string().min(1), idea_phase: z.enum(UsageIdeaPhase) }).strict().optional()
    .describe('Link this review to your own idea in this product, in this phase. The idea can then no longer be deleted, only archived.'),
}).strict()

type IdeaLinkInput = { idea_id: string; idea_phase: UsageIdeaPhase }
type IdeaLinkResult =
  | { status: 'linked' | 'conflict'; idea_id: string; idea_phase: UsageIdeaPhase }
  | { status: 'failed'; reason: 'IDEA_GONE' | 'LINK_ERROR' }

/** The ownership boundary: the idea must be the caller's own and belong to the product being dispatched. */
const findOwnedIdea = (idea_id: string, userId: string, product_id: string) =>
  prisma.idea.findFirst({ where: { id: idea_id, user_id: userId, product_id }, select: { id: true } })

/** Runs after a successful submit: nothing in here may throw, the dispatch result must always reach the caller. */
async function writeIdeaLink(requestId: string, link: IdeaLinkInput, userId: string, productId: string): Promise<IdeaLinkResult> {
  try {
    await prisma.$executeRaw`INSERT INTO dispatch_idea_links (request_id, idea_id, idea_phase) VALUES (${requestId}::uuid, ${link.idea_id}, ${link.idea_phase}::"UsageIdeaPhase") ON CONFLICT (request_id) DO NOTHING`
    const stored = await prisma.dispatchIdeaLink.findUnique({ where: { request_id: requestId } })
    if (!stored) throw new Error('LINK_READBACK_EMPTY')
    const status = stored.idea_id === link.idea_id && stored.idea_phase === link.idea_phase ? 'linked' : 'conflict'
    return { status, idea_id: stored.idea_id, idea_phase: stored.idea_phase }
  } catch (error) {
    console.error('dispatch_idea_link_write_failed', error instanceof Error ? error.message : 'unknown')
    try {
      const idea = await findOwnedIdea(link.idea_id, userId, productId)
      return { status: 'failed', reason: idea ? 'LINK_ERROR' : 'IDEA_GONE' }
    } catch {
      return { status: 'failed', reason: 'LINK_ERROR' }
    }
  }
}

export function registerDispatchReviewTool(server: McpServer) {
  server.registerTool(
    'dispatch_review',
    {
      title: 'Dispatch review',
      description:
        'Hand a review of pinned documents to automatic dispatch. Always read-only and always answered with one ' +
        'verdict in a reviewed message to reply_to. Every document must be pinned; an unpinned reference is refused. ' +
        'Wait for the answer with queue_wait_reply({ message_ids: [dispatch.root_message_id] }). ' +
        'Optionally pass idea_link to link the review to your own idea and phase; the dispatch result is returned even if the link fails.',
      inputSchema,
    },
    async ({ idempotency_key, runtime, repository, idea_link, ...rest }) =>
      withDispatchErrors(async () => {
        const input = buildInput({
          version: 1, ...rest, action: 'review',
          requirements: { ...(runtime ? { runtime } : {}), access: 'read', environment_keys: [], ...(repository ? { repository } : {}) }, publish: 'artifact',
        })
        if (!idea_link) return submit(input, idempotency_key)
        const auth = await requireWriteAccess()
        if (!(await findOwnedIdea(idea_link.idea_id, auth.userId, rest.product_id))) throw new DispatchError('DISPATCH_FORBIDDEN')
        const raw = await submitRaw(input, idempotency_key)
        return toolJson({ ...raw, idea_link: await writeIdeaLink(raw.dispatch.id, idea_link, auth.userId, rest.product_id) })
      }),
  )
}
