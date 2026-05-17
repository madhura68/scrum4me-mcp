// search_product_docs — Postgres full-text search via tsvector.
//
// Vereist de search_vec GENERATED kolom + GIN-index uit Scrum4Me-migration
// 20260517005006_product_docs_fts. Query via websearch_to_tsquery (veilig
// voor user-input). Default filtert op status IN ('active','draft') en
// enabled folders (review-P2.1) — opt-out via include_archived/include_disabled.
//
// match_kind = 'fts' in V1; in V1.1 ook 'trigram'|'exact' bij pg_trgm-upgrade.
//
// Plan: docs/plans/product-docs-mcp-retrieval.md (Deel B2 #3).

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma } from '@prisma/client'

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
  query: z.string().min(2).max(200),
  product_id: z.string().min(1),
  folder: z.enum(PRODUCT_DOC_FOLDERS_API).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  include_archived: z.boolean().default(false),
  include_disabled: z.boolean().default(false),
})

interface SearchRow {
  folder: string
  slug: string
  title: string
  status: string
  score: number
  snippet: string
  updated_at: Date
}

function uriFor(productId: string, folder: ProductDocFolderApi, slug: string): string {
  return `scrum4me-doc://product/${productId}/${folder}/${slug}`
}

export function registerSearchProductDocsTool(server: McpServer) {
  server.registerTool(
    'search_product_docs',
    {
      title: 'Full-text search ProductDocs (Postgres tsvector)',
      description:
        'Ranked full-text search over title, slug and content_md using Postgres FTS. ' +
        'Returns snippets with ts_headline. Default excludes archived/deprecated docs ' +
        'and disabled folders — set include_archived/include_disabled to opt in. ' +
        'Use websearch syntax for queries: quoted phrases, OR, -negation.',
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
        if (!product) return toolError(`Product '${input.product_id}' not found`)

        const folderDb = input.folder ? productDocFolderFromApi(input.folder) : null
        if (input.folder && !folderDb) {
          return toolError(`Invalid folder '${input.folder}'`)
        }

        const enabledFolders = product.enabled_doc_folders
        if (!input.include_disabled && enabledFolders.length === 0) {
          return toolJson({ results: [], count: 0 })
        }

        // Build dynamic WHERE-fragments. tsvector queries via $queryRaw —
        // Prisma kent search_vec niet (kolom buiten schema).
        const folderFilter = folderDb
          ? Prisma.sql`AND folder = ${folderDb}::"ProductDocFolder"`
          : Prisma.empty
        const statusFilter = input.include_archived
          ? Prisma.empty
          : Prisma.sql`AND status IN ('active','draft')`
        const enabledFilter = input.include_disabled
          ? Prisma.empty
          : Prisma.sql`AND folder = ANY(${enabledFolders}::"ProductDocFolder"[])`

        const rows = await prisma.$queryRaw<SearchRow[]>`
          SELECT
            folder::text AS folder,
            slug,
            title,
            status,
            ts_rank(search_vec, q)::float AS score,
            ts_headline(
              'simple',
              content_md,
              q,
              'MaxFragments=2,MinWords=5,MaxWords=20,StartSel=<<,StopSel=>>'
            ) AS snippet,
            updated_at
          FROM product_docs, websearch_to_tsquery('simple', ${input.query}) q
          WHERE product_id = ${input.product_id}
            AND search_vec @@ q
            ${folderFilter}
            ${statusFilter}
            ${enabledFilter}
          ORDER BY score DESC, updated_at DESC
          LIMIT ${input.limit};
        `

        const enabled = new Set(enabledFolders as string[])
        const results = rows.map((r) => {
          const folderApi = productDocFolderToApi(r.folder as Parameters<typeof productDocFolderToApi>[0])
          return {
            uri: uriFor(input.product_id, folderApi, r.slug),
            folder: folderApi,
            slug: r.slug,
            title: r.title,
            status: r.status,
            folder_enabled: enabled.has(r.folder),
            snippet: r.snippet,
            score: r.score,
            match_kind: 'fts' as const,
            updated_at: r.updated_at,
          }
        })

        return toolJson({ results, count: results.length, query: input.query })
      }),
  )
}
