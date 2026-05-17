// Markdown-link parser voor ProductDoc related-lookups.
//
// Gespiegeld van Scrum4Me's lib/product-doc-links.ts (geen npm-package
// gedeeld; bewuste duplicate per CLAUDE.md "Bewuste duplicaten"-hardstop).
// Aanpassingen voor scrum4me-mcp:
//  - 9 folders incl GRILLS (zie product-doc-folders.ts)
//  - Import-paden naar lokale modules
//
// Pure functies (parseDocLinks, resolveLink) zijn DB-vrij; findRelated
// doet één findMany over alle docs van het product en resolved
// forward + backward links in Node.

import path from 'node:path'

import type { PrismaClient, ProductDocFolder } from '@prisma/client'

import {
  PRODUCT_DOC_FOLDERS_API,
  productDocFolderToApi,
} from './product-doc-folders.js'

// --------------------------------------------------------------------------
// Types

export interface ParsedLink {
  raw: string
  text: string
  target_folder: ProductDocFolder | null
  target_slug: string | null
  anchor?: string
}

export interface RelatedDocRef {
  folder: ProductDocFolder
  slug: string
  title: string
  anchor?: string
}

export interface RelatedResult {
  forward: RelatedDocRef[]
  backward: RelatedDocRef[]
  broken_links: string[]
}

// --------------------------------------------------------------------------
// Constants

const LINK_RE = /(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g

const CODE_PATH_HINTS = [
  '/lib/',
  '/app/',
  '/components/',
  '/scripts/',
  '/prisma/',
  '/__tests__/',
  '/public/',
]

const CODE_EXTENSIONS = /\.(?:tsx?|jsx?|mjs|cjs|json|sql|yml|yaml|css|html?|png|jpg|svg)(?:[#?]|$)/i

const EXTERNAL_PROTOCOL = /^(?:[a-z]+:\/\/|mailto:|tel:)/i

// --------------------------------------------------------------------------
// Helpers

function isMarkdownLink(href: string): boolean {
  if (EXTERNAL_PROTOCOL.test(href)) return false
  if (CODE_EXTENSIONS.test(href)) return false
  for (const hint of CODE_PATH_HINTS) {
    if (href.includes(hint)) return false
  }
  const pathPart = href.split(/[#?]/)[0]
  return /\.md$/i.test(pathPart)
}

function splitAnchor(href: string): { pathPart: string; anchor?: string } {
  const hashIdx = href.indexOf('#')
  const qIdx = href.indexOf('?')
  const sep = [hashIdx, qIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0]
  if (sep === undefined) return { pathPart: href }
  const pathPart = href.slice(0, sep)
  if (href[sep] === '#') return { pathPart, anchor: href.slice(sep + 1) }
  return { pathPart }
}

function apiToFolderEnum(api: string): ProductDocFolder | null {
  const lower = api.toLowerCase()
  if (!(PRODUCT_DOC_FOLDERS_API as readonly string[]).includes(lower)) return null
  return lower.toUpperCase() as ProductDocFolder
}

// --------------------------------------------------------------------------
// resolveLink — pure, no I/O. Bron-pad eindigt op .md zodat dirname()
// de FOLDER teruggeeft (P1.2-fix uit het plan).

export function resolveLink(
  sourceFolder: ProductDocFolder,
  sourceSlug: string,
  linkPath: string,
): { folder: ProductDocFolder; slug: string; anchor?: string } | null {
  if (!isMarkdownLink(linkPath)) return null

  const { pathPart: rawPath, anchor } = splitAnchor(linkPath)

  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return null
  }

  const sourceFolderApi = productDocFolderToApi(sourceFolder)
  const sourcePath = `/${sourceFolderApi}/${sourceSlug}.md`
  const baseDir = path.posix.dirname(sourcePath)
  const resolved = path.posix.resolve(baseDir, decoded)

  const trimmed = resolved.replace(/^\//, '').replace(/\.md$/i, '')
  const parts = trimmed.split('/')
  if (parts.length !== 2) return null

  const [folderApi, slugRaw] = parts
  const folderEnum = apiToFolderEnum(folderApi)
  if (!folderEnum) return null

  const slug = slugRaw.toLowerCase()
  if (!slug) return null

  if (folderEnum === sourceFolder && slug === sourceSlug.toLowerCase()) return null

  return anchor ? { folder: folderEnum, slug, anchor } : { folder: folderEnum, slug }
}

// --------------------------------------------------------------------------
// parseDocLinks — pure

export function parseDocLinks(content_md: string): ParsedLink[] {
  const out: ParsedLink[] = []
  let m: RegExpExecArray | null
  LINK_RE.lastIndex = 0
  while ((m = LINK_RE.exec(content_md)) !== null) {
    const [raw, text, href] = m
    if (!isMarkdownLink(href)) continue
    const { anchor } = splitAnchor(href)
    out.push({
      raw,
      text,
      target_folder: null,
      target_slug: null,
      ...(anchor ? { anchor } : {}),
    })
  }
  return out
}

// --------------------------------------------------------------------------
// findRelated — DB-backed (single findMany)

export async function findRelated(
  prisma: Pick<PrismaClient, 'productDoc'>,
  productId: string,
  sourceFolder: ProductDocFolder,
  sourceSlug: string,
): Promise<RelatedResult> {
  const allDocs = await prisma.productDoc.findMany({
    where: { product_id: productId },
    select: { folder: true, slug: true, title: true, content_md: true },
  })

  const sourceSlugLc = sourceSlug.toLowerCase()
  const source = allDocs.find(
    (d) => d.folder === sourceFolder && d.slug.toLowerCase() === sourceSlugLc,
  )

  const byKey = new Map<string, { folder: ProductDocFolder; slug: string; title: string }>()
  for (const d of allDocs) {
    byKey.set(`${d.folder}/${d.slug.toLowerCase()}`, {
      folder: d.folder,
      slug: d.slug,
      title: d.title,
    })
  }

  const forward: RelatedDocRef[] = []
  const broken_links: string[] = []
  const seenForward = new Set<string>()

  if (source) {
    for (const m of source.content_md.matchAll(LINK_RE)) {
      const href = m[2]
      if (!isMarkdownLink(href)) continue
      const resolved = resolveLink(sourceFolder, sourceSlug, href)
      if (!resolved) {
        broken_links.push(href)
        continue
      }
      const key = `${resolved.folder}/${resolved.slug}`
      const target = byKey.get(key)
      if (!target) {
        broken_links.push(href)
        continue
      }
      const dedupKey = resolved.anchor ? `${key}#${resolved.anchor}` : key
      if (seenForward.has(dedupKey)) continue
      seenForward.add(dedupKey)
      forward.push(resolved.anchor ? { ...target, anchor: resolved.anchor } : target)
    }
  }

  const backward: RelatedDocRef[] = []
  const seenBackward = new Set<string>()
  for (const d of allDocs) {
    if (d.folder === sourceFolder && d.slug.toLowerCase() === sourceSlugLc) continue
    for (const m of d.content_md.matchAll(LINK_RE)) {
      const href = m[2]
      if (!isMarkdownLink(href)) continue
      const resolved = resolveLink(d.folder, d.slug, href)
      if (!resolved) continue
      if (resolved.folder === sourceFolder && resolved.slug === sourceSlugLc) {
        const key = `${d.folder}/${d.slug.toLowerCase()}`
        if (seenBackward.has(key)) break
        seenBackward.add(key)
        backward.push({ folder: d.folder, slug: d.slug, title: d.title })
        break
      }
    }
  }

  return { forward, backward, broken_links }
}
