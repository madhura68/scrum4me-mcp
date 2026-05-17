// PBI-102 (T-1123): DRY-mirror van ~/Development/Scrum4Me/lib/product-doc-write.ts.
// Wijzig BEIDE bestanden bij elke aanpassing — patroon zoals lib/job-config.ts.
//
// Invariant per call (zelfde als Scrum4Me-versie):
//   1. Parse frontmatter + last_updated-normalize.
//   2. SHA-256 hash van genormaliseerde content.
//   3. No-op skip als hash == current_revision.content_hash.
//   4. Anders: nieuwe revision (max+1), ProductDoc + Revision + Log binnen tx.

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

export type WriteProductDocTx = PrismaClient | Prisma.TransactionClient

export interface WriteProductDocInput {
  product_id: string
  folder: ProductDocFolder
  slug: string
  content_md: string
  actor_user_id: string
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

  return {
    doc_id: docId,
    revision_id: revision.id,
    revision: nextRevisionNr,
    content_hash,
    noop: false,
    created: !existing,
  }
}
