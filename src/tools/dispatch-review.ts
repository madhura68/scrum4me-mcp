import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { buildInput, commonFields, submit, withDispatchErrors } from './dispatch-common.js'

const documentRef = z.object({}).passthrough()
const inputSchema = z.object({
  ...commonFields,
  review_documents: z.object({ version: z.literal(1), items: z.array(documentRef).min(1) })
    .describe('The exact documents to review, each pinned by revision or commit and sha256. The reviewer reads these versions, never the latest.'),
}).strict()

export function registerDispatchReviewTool(server: McpServer) {
  server.registerTool(
    'dispatch_review',
    {
      title: 'Dispatch review',
      description:
        'Hand a review of pinned documents to automatic dispatch. Always read-only and always answered with one ' +
        'verdict in a reviewed message to reply_to. Every document must be pinned; an unpinned reference is refused.',
      inputSchema,
    },
    async ({ idempotency_key, runtime, ...rest }) =>
      withDispatchErrors(async () => submit(buildInput({
        version: 1, ...rest, action: 'review',
        requirements: { ...(runtime ? { runtime } : {}), access: 'read', environment_keys: [] }, publish: 'artifact',
      }), idempotency_key)),
  )
}
