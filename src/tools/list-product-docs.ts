// list_product_docs — index-call die per product (eventueel gefilterd
// op folder/status) alle ProductDoc-rijen teruggeeft met metadata.
//
// product_id is VERPLICHT (review-P1.1: MCP auth-context heeft geen
// impliciete job-scope; agents moeten product_id expliciet meegeven).
//
// Output bevat:
//   - `uri`: stabiele scrum4me-doc:// URI (review-P3)
//   - `folder_enabled`: of de folder in product.enabled_doc_folders staat
//   - `byte_size`: lengte van content_md
//
// Plan: docs/plans/product-docs-mcp-retrieval.md (Deel B2 #1).

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import {
  PRODUCT_DOC_FOLDERS_API,
  productDocFolderFromApi,
  productDocFolderToApi,
  type ProductDocFolderApi,
} from '../lib/product-doc-folders.js'

const STATUS_VALUES = ['draft', 'active', 'deprecated', 'archived'] as const

const inputSchema = z.object({
  product_id: z.string().min(1),
  folder: z.enum(PRODUCT_DOC_FOLDERS_API).optional(),
  status: z.enum(STATUS_VALUES).optional(),
  include_disabled: z.boolean().default(false),
})

function uriFor(productId: string, folder: ProductDocFolderApi, slug: string): string {
  return `scrum4me-doc://product/${productId}/${folder}/${slug}`
}

export function registerListProductDocsTool(server: McpServer) {
  server.registerTool(
    'list_product_docs',
    {
      title: 'List ProductDocs for a product',
      description:
        'List all ProductDocs in a product, optionally filtered by folder and status. ' +
        'Returns metadata only (no content_md) so agents can browse the index cheaply. ' +
        'Use search_product_docs for full-text queries or get_product_doc to read a doc.',
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

        const product = await prisma.product.findUnique({
          where: { id: input.product_id },
          select: { enabled_doc_folders: true },
        })
        if (!product) {
          return toolError(`Product '${input.product_id}' not found`)
        }

        const folderDb = input.folder ? productDocFolderFromApi(input.folder) : null
        if (input.folder && !folderDb) {
          return toolError(`Invalid folder '${input.folder}'`)
        }

        const docs = await prisma.productDoc.findMany({
          where: {
            product_id: input.product_id,
            ...(folderDb ? { folder: folderDb } : {}),
            ...(input.status ? { status: input.status } : {}),
          },
          select: {
            folder: true,
            slug: true,
            title: true,
            status: true,
            updated_at: true,
            content_md: true,
          },
          orderBy: [{ folder: 'asc' }, { slug: 'asc' }],
          take: 500,
        })

        const enabled = new Set(product.enabled_doc_folders)
        const result = docs
          .filter((d) => input.include_disabled || enabled.has(d.folder))
          .map((d) => {
            const folderApi = productDocFolderToApi(d.folder)
            return {
              uri: uriFor(input.product_id, folderApi, d.slug),
              folder: folderApi,
              slug: d.slug,
              title: d.title,
              status: d.status,
              folder_enabled: enabled.has(d.folder),
              updated_at: d.updated_at,
              byte_size: d.content_md.length,
            }
          })

        return toolJson({ docs: result, count: result.length })
      }),
  )
}
