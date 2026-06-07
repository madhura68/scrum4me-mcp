// Guards that mcp's local product-doc closure stays behaviorally equal to the
// canonical @shared copy, and that the dep-clean ProductDocDb interface remains
// structurally assignable to the real Prisma client types + the folder enum
// mirrors the Prisma enum without drift.
//
// Run with: npx vitest run __tests__/product-doc-shared-parity.test.ts

import { describe, it, expect } from 'vitest'

// --- mcp-local imports -------------------------------------------------------
import { parseProductDocMd }            from '../src/lib/product-doc-parser.js'
import {
  setProductDocFrontmatterFields,
  todayIsoDate,
}                                        from '../src/lib/product-doc-frontmatter.js'
import {
  productDocFolderToApi,
  productDocFolderFromApi,
}                                        from '../src/lib/product-doc-folders.js'
import { buildProductDocSectionIndex }  from '../src/lib/product-doc-section-index.js'
import {
  writeProductDoc      as mcpWriteProductDoc,
  ProductDocWriteError as McpProductDocWriteError,
  type WriteProductDocTx,
}                                        from '../src/lib/product-doc-write.js'

// --- @shared imports ---------------------------------------------------------
import { parseProductDocMd             as sharedParseProductDocMd }       from '@shared/product-doc-parser.js'
import {
  setProductDocFrontmatterFields       as sharedSetProductDocFrontmatterFields,
  todayIsoDate                         as sharedTodayIsoDate,
}                                        from '@shared/product-doc-frontmatter.js'
import {
  productDocFolderToApi                as sharedProductDocFolderToApi,
  productDocFolderFromApi              as sharedProductDocFolderFromApi,
}                                        from '@shared/product-doc-folders.js'
import { buildProductDocSectionIndex   as sharedBuildProductDocSectionIndex } from '@shared/product-doc-section-index.js'
import {
  writeProductDoc                      as sharedWriteProductDoc,
  ProductDocWriteError                 as SharedProductDocWriteError,
  type WriteProductDocInput,
}                                        from '@shared/product-doc-write.js'
import type { ProductDocDb }            from '@shared/product-doc-db.js'

// Enum + PRODUCT_DOC_FOLDERS guard
import { ProductDocFolder as PrismaFolder } from '@prisma/client'
import { PRODUCT_DOC_FOLDERS }          from '@shared/product-doc-folder.js'
import type { ProductDocFolder as SharedFolder } from '@shared/product-doc-folder.js'

// Assignability guard (compile-time only — these lines must typecheck)
import type { PrismaClient, Prisma }    from '@prisma/client'
const _full: ProductDocDb = null as unknown as PrismaClient
const _tx:   ProductDocDb = null as unknown as Prisma.TransactionClient
void _full; void _tx

// Enum mutual-assignability guard (compile-time)
const _af: SharedFolder = 'ADR' as PrismaFolder
const _bf: PrismaFolder = 'ADR' as SharedFolder
void _af; void _bf

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_DOC = `---
title: "Worker configuration guide"
status: draft
last_updated: "2026-06-07"
---

# Overview

This doc explains how workers are configured.

## Details

See [other doc](../specs/worker-spec.md) for more.
Also: [external link](https://example.com) and [code ref](../src/lib/job-config.ts).
`

const MISSING_FRONTMATTER_DOC = `No frontmatter here. Just plain text.`

const MALFORMED_YAML_DOC = `---
title: valid title
status: : broken yaml here
---

body text
`

const SCHEMA_VIOLATION_DOC = `---
title: "valid title"
status: grilled
---

body text
`

// Section-index source fixture (folder must be a valid ProductDocFolder)
const SECTION_SOURCE = {
  product_id: 'prod-parity-test',
  doc_id:     'doc-parity-test',
  revision_id: 'rev-parity-test',
  folder:     'SPECS' as const,
  slug:       'worker-spec',
  title:      'Worker Spec',
  status:     'draft',
  content_md: VALID_DOC,
}

const KNOWN_DOCS = [
  { id: 'doc-worker-spec-id', folder: 'SPECS' as const, slug: 'worker-spec', title: 'Worker Spec' },
]
const KNOWN_SECTIONS = [
  { id: 'sec-1', doc_id: 'doc-worker-spec-id', anchor: 'overview' },
]

// ---------------------------------------------------------------------------
// 1. parseProductDocMd parity
// ---------------------------------------------------------------------------

describe('parseProductDocMd parity: mcp == @shared', () => {
  it('valid doc with frontmatter + body', () => {
    expect(parseProductDocMd(VALID_DOC)).toEqual(sharedParseProductDocMd(VALID_DOC))
  })

  it('missing --- delimiters', () => {
    expect(parseProductDocMd(MISSING_FRONTMATTER_DOC)).toEqual(
      sharedParseProductDocMd(MISSING_FRONTMATTER_DOC),
    )
  })

  it('malformed yaml inside frontmatter', () => {
    expect(parseProductDocMd(MALFORMED_YAML_DOC)).toEqual(
      sharedParseProductDocMd(MALFORMED_YAML_DOC),
    )
  })

  it('schema violation (invalid status value)', () => {
    expect(parseProductDocMd(SCHEMA_VIOLATION_DOC)).toEqual(
      sharedParseProductDocMd(SCHEMA_VIOLATION_DOC),
    )
  })
})

// ---------------------------------------------------------------------------
// 2. setProductDocFrontmatterFields + todayIsoDate parity
// ---------------------------------------------------------------------------

describe('setProductDocFrontmatterFields + todayIsoDate parity', () => {
  const fixedDate = new Date('2026-06-07T12:00:00.000Z')

  it('todayIsoDate returns identical string', () => {
    expect(todayIsoDate(fixedDate)).toEqual(sharedTodayIsoDate(fixedDate))
  })

  it('patches a single field identically', () => {
    const patch = { last_updated: todayIsoDate(fixedDate) }
    expect(setProductDocFrontmatterFields(VALID_DOC, patch)).toEqual(
      sharedSetProductDocFrontmatterFields(VALID_DOC, patch),
    )
  })

  it('adds a new field identically', () => {
    const patch = { audience: 'admin' }
    expect(setProductDocFrontmatterFields(VALID_DOC, patch)).toEqual(
      sharedSetProductDocFrontmatterFields(VALID_DOC, patch),
    )
  })
})

// ---------------------------------------------------------------------------
// 3. productDocFolderToApi / productDocFolderFromApi parity — all 9 folders
// ---------------------------------------------------------------------------

const ALL_FOLDERS = [
  'ADR', 'ARCHITECTURE', 'GRILLS', 'PATTERNS', 'PLANS',
  'RUNBOOKS', 'SPECS', 'MANUAL', 'API',
] as const

describe('productDocFolderToApi parity', () => {
  it.each(ALL_FOLDERS)('%s → api string is identical', (folder) => {
    expect(productDocFolderToApi(folder)).toEqual(sharedProductDocFolderToApi(folder))
  })
})

describe('productDocFolderFromApi parity', () => {
  it.each(ALL_FOLDERS)('%s lowercase → DB enum is identical', (folder) => {
    const api = folder.toLowerCase()
    expect(productDocFolderFromApi(api)).toEqual(sharedProductDocFolderFromApi(api))
  })

  it('unknown string → null (identical)', () => {
    expect(productDocFolderFromApi('nonexistent')).toEqual(
      sharedProductDocFolderFromApi('nonexistent'),
    )
  })
})

// ---------------------------------------------------------------------------
// 4. buildProductDocSectionIndex parity
// ---------------------------------------------------------------------------

describe('buildProductDocSectionIndex parity', () => {
  it('produces identical sections + links for a doc with ≥2 headings, internal + external links', () => {
    const known = { productDocs: KNOWN_DOCS, productSections: KNOWN_SECTIONS }
    expect(buildProductDocSectionIndex(SECTION_SOURCE, known)).toEqual(
      sharedBuildProductDocSectionIndex(SECTION_SOURCE, known),
    )
  })
})

// ---------------------------------------------------------------------------
// 5. writeProductDoc parse-error parity
// ---------------------------------------------------------------------------

describe('writeProductDoc parse-error parity: mcp == @shared', () => {
  const baseInput: WriteProductDocInput = {
    product_id:    'p-parity',
    folder:        'GRILLS',
    slug:          'parity-test',
    content_md:    MISSING_FRONTMATTER_DOC,
    actor_user_id: 'u-parity',
  }

  // mcp takes WriteProductDocTx (PrismaClient | Prisma.TransactionClient),
  // @shared takes ProductDocDb. Neither DB is ever reached on a parse failure.
  const mcpDummy  = {} as unknown as WriteProductDocTx
  const sharedDummy = {} as unknown as ProductDocDb

  async function captureError(fn: () => Promise<unknown>): Promise<Error> {
    const result = await fn().then(() => null, (e) => e as unknown)
    expect(result).toBeInstanceOf(Error)
    return result as Error
  }

  it('both throw on missing frontmatter and messages are equal', async () => {
    const [mcpErr, sharedErr] = await Promise.all([
      captureError(() => mcpWriteProductDoc(mcpDummy, { ...baseInput, content_md: MISSING_FRONTMATTER_DOC })),
      captureError(() => sharedWriteProductDoc(sharedDummy, { ...baseInput, content_md: MISSING_FRONTMATTER_DOC })),
    ])
    expect(mcpErr.message).toEqual(sharedErr.message)
  })

  it('both throw on schema-violation frontmatter and messages are equal', async () => {
    const [mcpErr, sharedErr] = await Promise.all([
      captureError(() => mcpWriteProductDoc(mcpDummy, { ...baseInput, content_md: SCHEMA_VIOLATION_DOC })),
      captureError(() => sharedWriteProductDoc(sharedDummy, { ...baseInput, content_md: SCHEMA_VIOLATION_DOC })),
    ])
    expect(mcpErr.message).toEqual(sharedErr.message)
  })

  it('mcp error is instanceof McpProductDocWriteError', async () => {
    const err = await captureError(() =>
      mcpWriteProductDoc(mcpDummy, { ...baseInput, content_md: MISSING_FRONTMATTER_DOC }),
    )
    expect(err).toBeInstanceOf(McpProductDocWriteError)
    expect((err as McpProductDocWriteError).code).toBe(422)
  })

  it('@shared error is instanceof SharedProductDocWriteError', async () => {
    const err = await captureError(() =>
      sharedWriteProductDoc(sharedDummy, { ...baseInput, content_md: MISSING_FRONTMATTER_DOC }),
    )
    expect(err).toBeInstanceOf(SharedProductDocWriteError)
    expect((err as SharedProductDocWriteError).code).toBe(422)
  })
})

// ---------------------------------------------------------------------------
// 6. Enum-drift guard: PRODUCT_DOC_FOLDERS must mirror the Prisma enum exactly
// ---------------------------------------------------------------------------

describe('shared ProductDocFolder mirrors the Prisma enum', () => {
  it('PRODUCT_DOC_FOLDERS values match Object.values(PrismaFolder)', () => {
    expect([...PRODUCT_DOC_FOLDERS].sort()).toEqual(Object.values(PrismaFolder).sort())
  })
})
