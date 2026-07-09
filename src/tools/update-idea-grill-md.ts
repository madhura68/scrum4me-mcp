// MCP-tool: schrijft het grill_md-resultaat na een IDEA_GRILL-job en zet
// de idea-status op GRILLED. Schrijft het volledige resultaat als
// ASSISTANT/GRILL_RESULT-bericht in het idea-chat-kanaal (M17; voorheen
// een IdeaLog{GRILL_RESULT}-entry — pre-M17-rijen blijven zichtbaar via de
// kanaal-merge).
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
          select: { id: true, code: true, user_id: true, product_id: true, title: true, status: true },
        })
        if (!idea?.product_id) {
          return toolError('Idea has no product_id — assign product before GRILL')
        }
        // M23 chat-gate (fail-closed): een grill-write zet status onvoorwaardelijk
        // op GRILLED en mag dus nooit midden in de spec/plan-pipeline landen —
        // dat zou de statemachine corrumperen (bv. een IDEA_CHAT-beurt die
        // update_idea_grill_md aanroept tijdens SPEC_REVIEWING). Alleen de
        // grill-flow zelf en de vrije voorbereidingsfase zijn toegestaan.
        const GRILL_WRITE_ALLOWED_FROM = ['GRILLING', 'GRILLED', 'PLAN_READY'] as const
        if (!(GRILL_WRITE_ALLOWED_FROM as readonly string[]).includes(idea.status)) {
          return toolError(
            `Grill-write niet toegestaan vanuit status ${idea.status} — annuleer eerst de pipeline (terug naar GRILLED)`,
          )
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
            // M17 idea-chat (spec §3/besluit 3): het grill-resultaat landt
            // integraal als ASSISTANT-bericht in het kanaal — het kanaal is
            // het versie-archief. Géén IdeaLog GRILL_RESULT meer (dubbel-
            // render-preventie); pre-M17 IdeaLog-rijen blijven zichtbaar via
            // de kanaal-merge.
            await tx.ideaChatMessage.create({
              data: {
                idea_id,
                role: 'ASSISTANT',
                kind: 'GRILL_RESULT',
                content: markdown,
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
