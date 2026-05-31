import type { ProductDocFolder } from '@prisma/client'

import { prisma } from '../prisma.js'
import {
  PRODUCT_DOC_FOLDER_DESCRIPTIONS,
  productDocFolderToApi,
  type ProductDocFolderApi,
} from './product-doc-folders.js'

export const DOC_INDEX_FOLDER_CAP = 40

const HINT =
  'Active docs only. Lees er één met get_product_doc({product_id, folder, slug}); ' +
  'full-text via search_product_docs; volledige index via list_product_docs.'

export interface DocIndexDoc {
  title: string
  slug: string
}
export interface DocIndexFolder {
  folder: ProductDocFolderApi
  description: string
  doc_count: number
  docs: DocIndexDoc[]
  truncated: boolean
}
export interface DocIndex {
  product_id: string
  folders: DocIndexFolder[]
  hint: string
}

// Compacte index van de active ProductDocs van een product, gegroepeerd per
// folder. Gepusht in de job-payload door getFullJobContext zodat de worker
// weet welke docs bestaan zonder te raden. Active-only + enabled-folders =
// consistent met search/list. Cap per folder houdt de payload begrensd.
export async function buildDocIndex(productId: string): Promise<DocIndex | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { enabled_doc_folders: true },
  })
  if (!product || product.enabled_doc_folders.length === 0) return null

  const rows = await prisma.productDoc.findMany({
    where: {
      product_id: productId,
      status: 'active',
      folder: { in: product.enabled_doc_folders },
    },
    select: { folder: true, slug: true, title: true },
    orderBy: [{ folder: 'asc' }, { updated_at: 'desc' }],
  })
  if (rows.length === 0) return null

  // Map preserves insertion order: folders in folder-asc, docs in updated_at-desc.
  const byFolder = new Map<ProductDocFolder, DocIndexDoc[]>()
  for (const r of rows) {
    const list = byFolder.get(r.folder) ?? []
    list.push({ title: r.title, slug: r.slug })
    byFolder.set(r.folder, list)
  }

  const folders: DocIndexFolder[] = []
  for (const [folderDb, docs] of byFolder) {
    const folder = productDocFolderToApi(folderDb)
    folders.push({
      folder,
      description: PRODUCT_DOC_FOLDER_DESCRIPTIONS[folder],
      doc_count: docs.length,
      docs: docs.slice(0, DOC_INDEX_FOLDER_CAP),
      truncated: docs.length > DOC_INDEX_FOLDER_CAP,
    })
  }
  if (folders.length === 0) return null

  return { product_id: productId, folders, hint: HINT }
}
