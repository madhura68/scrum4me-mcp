// get_product_doc — chunked read van één ProductDoc.
//
// Review-P1.4-fix: content_md kan tot 100K tekens zijn (>10K tokens
// MCP-warning); deze tool ondersteunt:
//   - `max_chars` (default 12_000) — slice content_md
//   - `offset` — voor pagination via next_offset
//   - `heading` — extraheer alleen sectie onder dit heading
//
// Plan: docs/plans/product-docs-mcp-retrieval.md (Deel B2 #2).

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

const inputSchema = z.object({
  product_id: z.string().min(1),
  folder: z.enum(PRODUCT_DOC_FOLDERS_API),
  slug: z.string().min(1).max(80),
  max_chars: z.number().int().min(500).max(40_000).default(12_000),
  offset: z.number().int().min(0).default(0),
  heading: z.string().optional(),
})

function uriFor(productId: string, folder: ProductDocFolderApi, slug: string): string {
  return `scrum4me-doc://product/${productId}/${folder}/${slug}`
}

/**
 * Extraheert de sectie onder een specifieke heading. Match is op
 * heading-tekst (na het `#`-prefix, getrimd). Eindigt bij volgende
 * heading van gelijke of hogere niveau.
 */
function extractHeadingSection(content: string, heading: string): string | null {
  const lines = content.split('\n')
  const target = heading.trim().toLowerCase()
  let startIdx = -1
  let startLevel = 0
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i])
    if (!m) continue
    const text = m[2].trim().toLowerCase()
    if (text === target) {
      startIdx = i
      startLevel = m[1].length
      break
    }
  }
  if (startIdx === -1) return null

  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i])
    if (m && m[1].length <= startLevel) {
      endIdx = i
      break
    }
  }
  return lines.slice(startIdx, endIdx).join('\n')
}

export function registerGetProductDocTool(server: McpServer) {
  server.registerTool(
    'get_product_doc',
    {
      title: 'Read a ProductDoc (chunked)',
      description:
        'Read the content of a ProductDoc. Use `heading` to extract a single section, ' +
        'or `offset`+`max_chars` to paginate large docs (content_md can be up to 100K chars). ' +
        'Default max_chars=12000 stays well under the MCP 10K-token warning.',
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

        const product = await prisma.product.findUnique({
          where: { id: input.product_id },
          select: { enabled_doc_folders: true },
        })
        if (!product) return toolError(`Product '${input.product_id}' not found`)

        const doc = await prisma.productDoc.findFirst({
          where: {
            product_id: input.product_id,
            folder: folderDb,
            slug: input.slug.toLowerCase(),
          },
          select: {
            id: true,
            folder: true,
            slug: true,
            title: true,
            status: true,
            content_md: true,
            updated_at: true,
          },
        })

        if (!doc) {
          return toolError(
            `Doc '${input.folder}/${input.slug}' not found in product '${input.product_id}'`,
          )
        }

        const folderApi = productDocFolderToApi(doc.folder)
        const byteSize = doc.content_md.length

        let body: string
        let truncated = false
        let nextOffset: number | null = null

        if (input.heading) {
          const section = extractHeadingSection(doc.content_md, input.heading)
          if (section === null) {
            return toolError(
              `Heading '${input.heading}' not found in doc '${input.folder}/${input.slug}'`,
            )
          }
          if (section.length > input.max_chars) {
            body = section.slice(0, input.max_chars)
            truncated = true
          } else {
            body = section
          }
        } else {
          const startAt = Math.min(input.offset, byteSize)
          const slice = doc.content_md.slice(startAt, startAt + input.max_chars)
          body = slice
          if (startAt + slice.length < byteSize) {
            truncated = true
            nextOffset = startAt + slice.length
          }
        }

        return toolJson({
          uri: uriFor(input.product_id, folderApi, doc.slug),
          folder: folderApi,
          slug: doc.slug,
          title: doc.title,
          status: doc.status,
          folder_enabled: product.enabled_doc_folders.includes(doc.folder),
          content_md: body,
          byte_size: byteSize,
          truncated,
          next_offset: nextOffset,
          updated_at: doc.updated_at,
        })
      }),
  )
}
