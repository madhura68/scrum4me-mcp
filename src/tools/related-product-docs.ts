// related_product_docs — markdown-link graph (forward + backward).
//
// Voor een gegeven (folder, slug):
//   - forward: docs die deze doc noemt via markdown-link
//   - backward: docs die naar deze doc verwijzen
//   - broken_links: link-paden die niet resolven
//
// Implementatie via lib/product-doc-links.ts (dirname()-based resolve,
// 10 edge-cases gedekt door spiegel-tests in Scrum4Me-repo).
//
// Plan: docs/plans/product-docs-mcp-retrieval.md (Deel B2 #4).

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { findRelated } from '../lib/product-doc-links.js'
import {
  PRODUCT_DOC_FOLDERS_API,
  productDocFolderFromApi,
  productDocFolderToApi,
  type ProductDocFolderApi,
} from '../lib/product-doc-folders.js'

const inputSchema = z.object({
  product_id: z.string().min(1),
  folder: z.enum(PRODUCT_DOC_FOLDERS_API),
  slug: z.string().min(1).max(80),
})

function uriFor(productId: string, folder: ProductDocFolderApi, slug: string): string {
  return `scrum4me-doc://product/${productId}/${folder}/${slug}`
}

export function registerRelatedProductDocsTool(server: McpServer) {
  server.registerTool(
    'related_product_docs',
    {
      title: 'Find related ProductDocs via markdown link graph',
      description:
        'For a given doc, returns forward links (docs it mentions) and backward links ' +
        '(docs that reference it). Parses markdown `[text](path.md)` links and resolves ' +
        'them within the product\'s doc-tree. Broken links are reported separately.',
      inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (rawInput) =>
      withToolErrors(async () => {
        const auth = await getAuth()
        const input = inputSchema.parse(rawInput)

        if (!(await userCanAccessProduct(input.product_id, auth.userId))) {
          return toolError(`Product '${input.product_id}' not found or not accessible`)
        }

        const folderDb = productDocFolderFromApi(input.folder)
        if (!folderDb) return toolError(`Invalid folder '${input.folder}'`)

        const slugLc = input.slug.toLowerCase()
        const source = await prisma.productDoc.findFirst({
          where: { product_id: input.product_id, folder: folderDb, slug: slugLc },
          select: { id: true },
        })
        if (!source) {
          return toolError(
            `Doc '${input.folder}/${input.slug}' not found in product '${input.product_id}'`,
          )
        }

        const related = await findRelated(prisma, input.product_id, folderDb, slugLc)

        const toRef = (
          r: { folder: ReturnType<typeof productDocFolderFromApi>; slug: string; title: string; anchor?: string },
        ) => {
          // folder is non-null hier (komt uit findRelated waar enum gegarandeerd is)
          const folderEnum = r.folder!
          const folderApi = productDocFolderToApi(folderEnum)
          return {
            uri: uriFor(input.product_id, folderApi, r.slug),
            folder: folderApi,
            slug: r.slug,
            title: r.title,
            ...(r.anchor ? { anchor: r.anchor } : {}),
          }
        }

        return toolJson({
          source_uri: uriFor(input.product_id, input.folder, slugLc),
          forward: related.forward.map(toRef),
          backward: related.backward.map(toRef),
          broken_links: related.broken_links,
          counts: {
            forward: related.forward.length,
            backward: related.backward.length,
            broken: related.broken_links.length,
          },
        })
      }),
  )
}
