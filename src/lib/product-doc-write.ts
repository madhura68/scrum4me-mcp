// PBI-102 (T-1119): shared write-laag voor ProductDoc create/update met
// immutable revision-historie. Gebruikt door:
//   - actions/product-docs.ts (server-action voor Idea-UI / Docs-UI)
//   - scrum4me-mcp/src/lib/product-doc-write.ts (gespiegelde MCP-mirror)
//
// Geen Next-deps in deze module zodat dezelfde code-pad draait in
// MCP-context. Patroon zoals lib/job-config.ts ↔ MCP-mirror.
//
// Invariant per call:
//   1. Frontmatter parse + last_updated-normalize.
//   2. SHA-256 hash van genormaliseerde content.
//   3. Bij update én hash == current_revision.content_hash → no-op skip
//      (geen nieuwe revision, geen log-rij).
//   4. Anders: revision-nr = max(revision)+1, schrijf ProductDoc +
//      ProductDocRevision + update current_revision_id + ProductDocLog,
//      alles binnen één tx.

import { createHash } from 'node:crypto'

import type { Prisma, PrismaClient, ProductDocFolder } from '@prisma/client'

import {
  parseProductDocMd,
  type ProductDocParseError,
} from './product-doc-parser.js'
import {
  setProductDocFrontmatterFields,
  todayIsoDate,
} from './product-doc-frontmatter.js'
import { buildProductDocSectionIndex } from './product-doc-section-index.js'

export type WriteProductDocTx =
  | PrismaClient
  | Prisma.TransactionClient

export interface WriteProductDocInput {
  product_id: string
  folder: ProductDocFolder
  slug: string
  content_md: string
  actor_user_id: string
  expected_revision_id?: string | null
}

export interface WriteProductDocResult {
  doc_id: string
  revision_id: string
  revision: number
  content_hash: string
  noop: boolean
  created: boolean
}

export class ProductDocWriteError extends Error {
  readonly code: number
  readonly details?: unknown

  constructor(message: string, code: number, details?: unknown) {
    super(message)
    this.name = 'ProductDocWriteError'
    this.code = code
    this.details = details
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export async function rebuildProductDocSectionIndex(
  tx: WriteProductDocTx,
  input: {
    product_id: string
    doc_id: string
    revision_id: string
    folder: ProductDocFolder
    slug: string
    title: string
    status: string
    content_md: string
  },
): Promise<void> {
  const productDocs = await tx.productDoc.findMany({
    where: { product_id: input.product_id },
    select: { id: true, folder: true, slug: true, title: true },
  })
  const productSections = await tx.productDocSection.findMany({
    where: { product_id: input.product_id },
    select: { id: true, doc_id: true, anchor: true },
  })

  const index = buildProductDocSectionIndex(
    {
      product_id: input.product_id,
      doc_id: input.doc_id,
      revision_id: input.revision_id,
      folder: input.folder,
      slug: input.slug,
      title: input.title,
      status: input.status,
      content_md: input.content_md,
    },
    { productDocs, productSections },
  )

  await tx.productDocLink.deleteMany({
    where: { source_doc_id: input.doc_id },
  })

  const sectionIdsByAnchor = new Map<string, string>()
  for (const section of index.sections) {
    const saved = await tx.productDocSection.upsert({
      where: {
        doc_id_anchor: {
          doc_id: section.doc_id,
          anchor: section.anchor,
        },
      },
      create: {
        product_id: section.product_id,
        doc_id: section.doc_id,
        revision_id: section.revision_id,
        folder: section.folder,
        slug: section.slug,
        anchor: section.anchor,
        heading_path: section.heading_path,
        heading_level: section.heading_level,
        sort_order: section.sort_order,
        title: section.title,
        status: section.status,
        content_text: section.content_text,
        content_hash: section.content_hash,
      },
      update: {
        revision_id: section.revision_id,
        folder: section.folder,
        slug: section.slug,
        heading_path: section.heading_path,
        heading_level: section.heading_level,
        sort_order: section.sort_order,
        title: section.title,
        status: section.status,
        content_text: section.content_text,
        content_hash: section.content_hash,
      },
      select: { id: true, anchor: true },
    })
    sectionIdsByAnchor.set(saved.anchor, saved.id)
  }

  await tx.productDocSection.deleteMany({
    where: {
      doc_id: input.doc_id,
      anchor: { notIn: index.sections.map((section) => section.anchor) },
    },
  })

  if (index.links.length > 0) {
    await tx.productDocLink.createMany({
      data: index.links.map((link) => {
        const targetSectionId =
          link.target_doc_id === input.doc_id && link.target_anchor
            ? sectionIdsByAnchor.get(link.target_anchor) ?? null
            : link.target_section_id
        const linkType =
          link.target_doc_id && link.target_anchor && !targetSectionId
            ? 'broken'
            : link.link_type

        return {
          product_id: link.product_id,
          source_doc_id: link.source_doc_id,
          source_section_id: link.source_anchor
            ? sectionIdsByAnchor.get(link.source_anchor) ?? null
            : null,
          target_doc_id: link.target_doc_id,
          target_section_id: targetSectionId,
          raw_href: link.raw_href,
          normalized_href: link.normalized_href,
          target_folder: link.target_folder,
          target_slug: link.target_slug,
          target_anchor: link.target_anchor,
          link_type: linkType,
          anchor: link.source_anchor,
        }
      }),
    })
  }

  const affected = await tx.productDocLink.findMany({
    where: {
      product_id: input.product_id,
      OR: [
        { target_doc_id: input.doc_id },
        {
          target_folder: input.folder,
          target_slug: input.slug,
          link_type: { in: ['broken', 'ambiguous'] },
        },
      ],
    },
    select: { id: true, target_anchor: true },
  })

  for (const link of affected) {
    const targetSectionId = link.target_anchor
      ? sectionIdsByAnchor.get(link.target_anchor) ?? null
      : null

    await tx.productDocLink.update({
      where: { id: link.id },
      data: {
        target_doc_id: input.doc_id,
        target_section_id: targetSectionId,
        link_type: link.target_anchor && !targetSectionId ? 'broken' : 'resolved',
      },
    })
  }
}

export async function writeProductDoc(
  tx: WriteProductDocTx,
  input: WriteProductDocInput,
): Promise<WriteProductDocResult> {
  const parsed = parseProductDocMd(input.content_md)
  if (!parsed.ok) {
    throw new ProductDocWriteError(
      'content_md is niet parseerbaar',
      422,
      parsed.errors satisfies ProductDocParseError[],
    )
  }

  const normalized = setProductDocFrontmatterFields(input.content_md, {
    last_updated: todayIsoDate(),
  })
  const content_hash = sha256(normalized)

  const existing = await tx.productDoc.findUnique({
    where: {
      product_id_folder_slug: {
        product_id: input.product_id,
        folder: input.folder,
        slug: input.slug,
      },
    },
    select: {
      id: true,
      status: true,
      current_revision_id: true,
      current_revision: { select: { id: true, revision: true, content_hash: true } },
    },
  })

  if (
    input.expected_revision_id &&
    existing?.current_revision_id !== input.expected_revision_id
  ) {
    throw new ProductDocWriteError('Doc is gewijzigd sinds laden', 409, {
      expected_revision_id: input.expected_revision_id,
      current_revision_id: existing?.current_revision_id ?? null,
    })
  }

  if (existing && existing.current_revision?.content_hash === content_hash) {
    return {
      doc_id: existing.id,
      revision_id: existing.current_revision.id,
      revision: existing.current_revision.revision,
      content_hash,
      noop: true,
      created: false,
    }
  }

  const prevRevision = existing
    ? await tx.productDocRevision.aggregate({
        where: { doc_id: existing.id },
        _max: { revision: true },
      })
    : null
  const nextRevisionNr = (prevRevision?._max.revision ?? 0) + 1

  let docId: string
  if (!existing) {
    const created = await tx.productDoc.create({
      data: {
        product_id: input.product_id,
        folder: input.folder,
        slug: input.slug,
        title: parsed.frontmatter.title,
        status: parsed.frontmatter.status,
        content_md: normalized,
        created_by: input.actor_user_id,
      },
      select: { id: true },
    })
    docId = created.id
  } else {
    await tx.productDoc.update({
      where: { id: existing.id },
      data: {
        title: parsed.frontmatter.title,
        status: parsed.frontmatter.status,
        content_md: normalized,
      },
    })
    docId = existing.id
  }

  const revision = await tx.productDocRevision.create({
    data: {
      doc_id: docId,
      revision: nextRevisionNr,
      title: parsed.frontmatter.title,
      status: parsed.frontmatter.status,
      content_md: normalized,
      content_hash,
      created_by: input.actor_user_id,
    },
    select: { id: true },
  })

  await tx.productDoc.update({
    where: { id: docId },
    data: { current_revision_id: revision.id },
  })

  await tx.productDocLog.create({
    data: {
      product_id: input.product_id,
      doc_id: docId,
      actor_user_id: input.actor_user_id,
      type: existing ? 'UPDATED' : 'CREATED',
      metadata: {
        revision: nextRevisionNr,
        content_hash,
        length: normalized.length,
        prev_status: existing?.status ?? null,
        new_status: parsed.frontmatter.status,
      },
    },
  })

  await rebuildProductDocSectionIndex(tx, {
    product_id: input.product_id,
    doc_id: docId,
    revision_id: revision.id,
    folder: input.folder,
    slug: input.slug,
    title: parsed.frontmatter.title,
    status: parsed.frontmatter.status,
    content_md: normalized,
  })

  return {
    doc_id: docId,
    revision_id: revision.id,
    revision: nextRevisionNr,
    content_hash,
    noop: false,
    created: !existing,
  }
}
