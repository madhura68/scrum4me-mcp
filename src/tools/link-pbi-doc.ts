// PBI-102 (T-1129): idempotente koppeling tussen een bestaande PBI en een
// ProductDoc-revision. Bedoeld voor achteraf-koppelen wanneer de PBI al
// bestaat (bv. via UI-knop in vervolg-PBI of na een handmatige flow).
//
// Zonder revision_id resolvet de tool naar `doc.current_revision_id` op
// linkmoment en bevriest die. Met expliciete revision_id wordt die exact
// gebruikt, ook als de doc inmiddels nieuwere revisies heeft.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  pbi_id: z.string().min(1),
  doc_id: z.string().min(1),
  revision_id: z.string().optional(),
  role: z.enum(['PLAN', 'GRILL']),
})

export function registerLinkPbiDocTool(server: McpServer) {
  server.registerTool(
    'link_pbi_doc',
    {
      title: 'Link a ProductDoc-revision to a PBI',
      description:
        'Idempotently create or reuse a PbiDoc-junction row. Without revision_id resolves to the docs current revision at link-time. Validates that PBI and doc belong to the same product. Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ pbi_id, doc_id, revision_id, role }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()

        const [pbi, doc] = await Promise.all([
          prisma.pbi.findUnique({
            where: { id: pbi_id },
            select: { id: true, product_id: true },
          }),
          prisma.productDoc.findUnique({
            where: { id: doc_id },
            select: { id: true, product_id: true, current_revision_id: true },
          }),
        ])
        if (!pbi) return toolError(`PBI ${pbi_id} not found`)
        if (!doc) return toolError(`Doc ${doc_id} not found`)
        if (pbi.product_id !== doc.product_id) {
          return toolError('PBI and doc belong to different products')
        }
        if (!(await userCanAccessProduct(pbi.product_id, auth.userId))) {
          return toolError(`Product ${pbi.product_id} not accessible`)
        }

        const resolvedRevisionId = revision_id ?? doc.current_revision_id
        if (!resolvedRevisionId) {
          return toolError(`Doc ${doc_id} has no revision yet`)
        }

        // Wanneer een expliciete revision_id is meegegeven: valideer dat
        // hij bij deze doc hoort (anti-pasted-from-other-doc).
        if (revision_id) {
          const rev = await prisma.productDocRevision.findUnique({
            where: { id: revision_id },
            select: { doc_id: true, revision: true },
          })
          if (!rev || rev.doc_id !== doc_id) {
            return toolError(
              `Revision ${revision_id} does not belong to doc ${doc_id}`,
            )
          }
        }

        const link = await prisma.pbiDoc.upsert({
          where: {
            pbi_id_doc_revision_id_role: {
              pbi_id,
              doc_revision_id: resolvedRevisionId,
              role,
            },
          },
          create: {
            pbi_id,
            doc_revision_id: resolvedRevisionId,
            role,
            created_by: auth.userId,
          },
          update: {},
          include: { doc_revision: { select: { revision: true } } },
        })

        return toolJson({
          pbi_doc_id: link.id,
          pbi_id,
          doc_id,
          role,
          revision_id: resolvedRevisionId,
          revision: link.doc_revision.revision,
          created_at: link.created_at.toISOString(),
        })
      }),
  )
}
