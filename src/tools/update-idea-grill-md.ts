// MCP-tool: schrijft het grill_md-resultaat na een IDEA_GRILL-job en zet
// de idea-status op GRILLED. Logt een IdeaLog{GRILL_RESULT}-entry.
//
// Wordt aangeroepen door de worker als laatste stap van een grill-sessie.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userOwnsIdea } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import {
  writeProductDoc,
  ProductDocWriteError,
} from '../lib/product-doc-write.js'
import { ensureProductDocFrontmatter } from '../lib/ensure-product-doc-frontmatter.js'

const inputSchema = z.object({
  idea_id: z.string().min(1),
  markdown: z.string().min(1).max(64_000),
  // IDEA-menu slice 1: optioneel-maar-afgedwongen. De copilot-service geeft
  // 'm altijd mee zodat een grill_md-write product-bound is; de bestaande
  // worker-caller (zonder param) blijft backward-compatible.
  product_id: z.string().min(1).optional(),
})

export function registerUpdateIdeaGrillMdTool(server: McpServer) {
  server.registerTool(
    'update_idea_grill_md',
    {
      title: 'Update idea grill_md',
      description:
        'Save the grill-result markdown for an idea: writes a ProductDoc (folder=GRILLS) + immutable revision, sets Idea.grill_doc_id, and dual-writes Idea.grill_md for backward-compat (wait-for-job still reads it). Transitions status to GRILLED. Requires Idea.product_id. Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ idea_id, markdown, product_id }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        if (!(await userOwnsIdea(idea_id, auth.userId))) {
          return toolError('Idea not found')
        }

        const idea = await prisma.idea.findUnique({
          where: { id: idea_id },
          select: { id: true, code: true, user_id: true, product_id: true, title: true },
        })
        if (!idea?.product_id) {
          return toolError('Idea has no product_id — assign product before GRILL')
        }
        // Product-bound wanneer de caller een product_id meegeeft (copilot-service):
        // mismatch ⇒ 404-stijl, zodat een idee uit een ander product van dezelfde
        // binding-user niet via deze route te muteren is. Worker-caller (geen
        // product_id) ongewijzigd.
        if (product_id !== undefined && idea.product_id !== product_id) {
          return toolError('Idea not found')
        }

        const content = ensureProductDocFrontmatter(markdown, idea.title)
        const slug = `${idea.code.toLowerCase()}-grill`

        try {
          const result = await prisma.$transaction(async (tx) => {
            const wr = await writeProductDoc(tx, {
              product_id: idea.product_id!,
              folder: 'GRILLS',
              slug,
              content_md: content,
              actor_user_id: idea.user_id,
            })
            const updatedIdea = await tx.idea.update({
              where: { id: idea_id },
              data: {
                grill_md: markdown, // dual-write voor wait-for-job compat
                grill_doc_id: wr.doc_id,
                status: 'GRILLED',
              },
              select: { id: true, status: true, code: true },
            })
            await tx.ideaLog.create({
              data: {
                idea_id,
                type: 'GRILL_RESULT',
                content: `Grill result (${markdown.length} chars, rev ${wr.revision})`,
                metadata: {
                  length: markdown.length,
                  doc_id: wr.doc_id,
                  revision_id: wr.revision_id,
                  revision: wr.revision,
                  noop: wr.noop,
                },
              },
            })
            return { idea: updatedIdea, wr }
          })

          return toolJson({
            ok: true,
            idea: result.idea,
            doc: {
              id: result.wr.doc_id,
              revision_id: result.wr.revision_id,
              revision: result.wr.revision,
            },
          })
        } catch (err) {
          if (err instanceof ProductDocWriteError) {
            return toolError(`Cannot save grill: ${err.message}`)
          }
          throw err
        }
      }),
  )
}
