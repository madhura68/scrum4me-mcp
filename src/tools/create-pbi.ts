// MCP authoring tool: create een Product Backlog Item.
//
// Sort_order wordt automatisch op last+1 binnen het product gezet. Code wordt
// auto-gegenereerd als PBI-N (zelfde logica als de Scrum4Me-app). De max-reads
// en create delen één Serializable transactie met begrensde P2034-retry.
//
// PBI-102: optionele `source_docs` koppelt de PBI bij creatie aan
// ProductDoc-revisies via PbiDoc (junction). Zonder revision_id resolvet
// de server naar `doc.current_revision_id` op linkmoment en bevriest die,
// zodat de bron reproduceerbaar blijft als de doc later wordt aangepast.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { withSerializableRetry } from '../lib/serializable-transaction.js'
import { withCodeUniqueRetry } from '../lib/code-unique-retry.js'
import { assertCeremonyOperationKey, executePpeMutation, ppeInputSchema } from '../lib/ppe-operation.js'

const PBI_AUTO_RE = /^PBI-(\d+)$/
async function generateNextPbiCode(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<string> {
  const pbis = await tx.pbi.findMany({
    where: { product_id: productId },
    select: { code: true },
  })
  let max = 0
  for (const p of pbis) {
    const m = p.code?.match(PBI_AUTO_RE)
    if (m) {
      const n = Number.parseInt(m[1], 10)
      if (!Number.isNaN(n) && n > max) max = n
    }
  }
  return `PBI-${max + 1}`
}

const sourceDocSchema = z.object({
  doc_id: z.string().min(1),
  revision_id: z.string().optional(),
  role: z.enum(['PLAN', 'GRILL']),
})

const inputSchema = z.object({
  product_id: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  priority: z.number().int().min(1).max(4),
  source_docs: z.array(sourceDocSchema).max(10).optional(),
  ceremony_object_key: z.string().min(1).optional(),
  ppe: ppeInputSchema.optional(),
})

export async function handleCreatePbi({
  product_id, title, description, priority, source_docs, ceremony_object_key, ppe,
}: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    if (!(await userCanAccessProduct(product_id, auth.userId))) {
      return toolError(`Product ${product_id} not found or not accessible`)
    }
    if ((ppe === undefined) !== (ceremony_object_key === undefined)) throw new Error('PPE_INPUT_INCOMPLETE')
    if (ppe) assertCeremonyOperationKey(ppe, 'pbi', ceremony_object_key!)
    const request = {
      product_id, title, description: description ?? null, priority,
      source_docs: source_docs ?? null, ceremony_object_key: ceremony_object_key ?? null,
    }

        // PBI-102: resolve source_docs vooraf zodat we voor de tx-start weten
        // welke revision_id per link bevroren moet worden.
        const resolvedLinks: Array<{
          doc_id: string
          revision_id: string
          role: 'PLAN' | 'GRILL'
        }> = []
        if (source_docs?.length) {
          const docs = await prisma.productDoc.findMany({
            where: { id: { in: source_docs.map((s) => s.doc_id) } },
            select: { id: true, product_id: true, current_revision_id: true },
          })
          for (const s of source_docs) {
            const doc = docs.find((d) => d.id === s.doc_id)
            if (!doc) return toolError(`source doc ${s.doc_id} not found`)
            if (doc.product_id !== product_id) {
              return toolError(
                `source doc ${s.doc_id} belongs to different product`,
              )
            }
            const revisionId = s.revision_id ?? doc.current_revision_id
            if (!revisionId) {
              return toolError(`source doc ${s.doc_id} has no revision yet`)
            }
            // Als explicit revision_id meegegeven: valideer dat hij bij deze doc hoort.
            if (s.revision_id) {
              const rev = await prisma.productDocRevision.findUnique({
                where: { id: revisionId },
                select: { doc_id: true },
              })
              if (!rev || rev.doc_id !== s.doc_id) {
                return toolError(
                  `revision ${revisionId} does not belong to doc ${s.doc_id}`,
                )
              }
            }
            resolvedLinks.push({ doc_id: s.doc_id, revision_id: revisionId, role: s.role })
          }
        }

        return executePpeMutation({
          ppe,
          operationKind: 'CEREMONY_PBI',
          targetScope: `product:${product_id}`,
          request,
          authority: 'ceremony',
          mutate: async () => {
        const createPbi = () => withSerializableRetry(async (tx) => {
          const last = await tx.pbi.findFirst({
            where: { product_id },
            orderBy: [{ sort_order: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
            select: { sort_order: true },
          })
          const resolvedSortOrder = (last?.sort_order ?? 0) + 1.0
          const code = await generateNextPbiCode(tx, product_id)
          const pbi = await tx.pbi.create({
            data: {
              product_id,
              code,
              title,
              description: description ?? null,
              priority,
              sort_order: resolvedSortOrder,
            },
            select: {
              id: true,
              code: true,
              title: true,
              description: true,
              priority: true,
              sort_order: true,
              created_at: true,
            },
          })

          const links: Array<{
            doc_id: string
            revision_id: string
            revision: number
            role: 'PLAN' | 'GRILL'
          }> = []
          for (const l of resolvedLinks) {
            const link = await tx.pbiDoc.upsert({
              where: {
                pbi_id_doc_revision_id_role: {
                  pbi_id: pbi.id,
                  doc_revision_id: l.revision_id,
                  role: l.role,
                },
              },
              create: {
                pbi_id: pbi.id,
                doc_revision_id: l.revision_id,
                role: l.role,
                created_by: auth.userId,
              },
              update: {},
              include: {
                doc_revision: {
                  select: { revision: true, doc_id: true },
                },
              },
            })
            links.push({
              doc_id: link.doc_revision.doc_id,
              revision_id: link.doc_revision_id,
              revision: link.doc_revision.revision,
              role: link.role as 'PLAN' | 'GRILL',
            })
          }
          return { ...pbi, source_docs: links }
        })
        const created = await withCodeUniqueRetry('pbis_product_id_code_key', createPbi)
        return toolJson(created)
          },
        })
  })
}

export function registerCreatePbiTool(server: McpServer) {
  server.registerTool(
    'create_pbi',
    {
      title: 'Create PBI',
      description:
        'Add a Product Backlog Item to a product. Priority is team importance only; execution order appends within the parent and can be changed through backlog reorder. PBI-102: optional source_docs link the PBI to ProductDoc revisions (PLAN/GRILL); revision_id is frozen at link-time. Forbidden for demo accounts.',
      inputSchema,
    },
    handleCreatePbi,
  )
}
