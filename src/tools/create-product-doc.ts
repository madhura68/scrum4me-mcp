// PBI-102 (T-1128): MCP-tool om vanuit Claude-Code (plan-mode) of een
// agent een lokaal plan/grill-document als ProductDoc + immutable revision
// op te slaan. Geeft doc_id + revision_id terug die meteen aan
// `create_pbi.source_docs` of `link_pbi_doc` kunnen worden gevoed.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import {
  writeProductDoc,
  ProductDocWriteError,
} from '../lib/product-doc-write.js'
import { parseProductDocMd } from '../lib/product-doc-parser.js'

const FOLDER_VALUES = [
  'ADR',
  'ARCHITECTURE',
  'GRILLS',
  'PATTERNS',
  'PLANS',
  'RUNBOOKS',
  'SPECS',
  'MANUAL',
  'API',
] as const

const inputSchema = z.object({
  product_id: z.string().min(1),
  folder: z.enum(FOLDER_VALUES),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,79}$/, 'Slug mag alleen lowercase/cijfers/koppeltekens, 1-80 chars')
    .optional(),
  content_md: z.string().min(1).max(100_000),
})

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  )
}

export function registerCreateProductDocTool(server: McpServer) {
  server.registerTool(
    'create_product_doc',
    {
      title: 'Create or update a ProductDoc with a new immutable revision',
      description:
        'Write a ProductDoc (or new revision of an existing doc). Slug auto-derived from frontmatter title if omitted. Returns doc_id + revision_id so the caller can link via create_pbi or link_pbi_doc. Identical content produces a noop:true response without a new revision. Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ product_id, folder, slug, content_md }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        if (!(await userCanAccessProduct(product_id, auth.userId))) {
          return toolError(`Product ${product_id} not accessible`)
        }

        const parsed = parseProductDocMd(content_md)
        if (!parsed.ok) {
          return toolError(
            `Invalid frontmatter: ${parsed.errors.map((e) => e.message).join('; ')}`,
          )
        }
        const finalSlug = slug ?? slugify(parsed.frontmatter.title)

        try {
          const result = await prisma.$transaction((tx) =>
            writeProductDoc(tx, {
              product_id,
              folder,
              slug: finalSlug,
              content_md,
              actor_user_id: auth.userId,
            }),
          )
          return toolJson({
            doc_id: result.doc_id,
            revision_id: result.revision_id,
            revision: result.revision,
            content_hash: result.content_hash,
            noop: result.noop,
            created: result.created,
            folder,
            slug: finalSlug,
          })
        } catch (err) {
          if (err instanceof ProductDocWriteError) {
            return toolError(err.message)
          }
          throw err
        }
      }),
  )
}
