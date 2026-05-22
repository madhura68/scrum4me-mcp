import { createHash } from 'node:crypto'
import path from 'node:path'

import type { ProductDocFolder } from '@prisma/client'

import { parseProductDocMd } from './product-doc-parser.js'
import {
  PRODUCT_DOC_FOLDERS_API,
  productDocFolderToApi,
} from './product-doc-folders.js'

const RAW_LINK_RE = /(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g
const EXTERNAL_PROTOCOL = /^(?:[a-z]+:\/\/|mailto:|tel:)/i
const CODE_PATH_HINTS = [
  '/lib/',
  '/app/',
  '/components/',
  '/scripts/',
  '/prisma/',
  '/__tests__/',
  '/public/',
]
const CODE_EXTENSIONS = /\.(?:tsx?|jsx?|mjs|cjs|json|sql|yml|yaml|css|html?|png|jpg|jpeg|svg|gif|webp|pdf)(?:[#?]|$)/i

export interface ProductDocSectionSource {
  product_id: string
  doc_id: string
  revision_id: string
  folder: ProductDocFolder
  slug: string
  title: string
  status: string
  content_md: string
}

export interface ProductDocSectionRecord {
  product_id: string
  doc_id: string
  revision_id: string
  folder: ProductDocFolder
  slug: string
  anchor: string
  heading_path: string
  heading_level: number
  sort_order: number
  title: string
  status: string
  content_text: string
  content_hash: string
}

export interface RawMarkdownLink {
  raw: string
  text: string
  href: string
}

export interface KnownProductDoc {
  id: string
  folder: ProductDocFolder
  slug: string
  title: string
}

export interface KnownProductSection {
  id: string
  doc_id: string
  anchor: string
}

export interface ProductDocLinkRecord {
  product_id: string
  source_doc_id: string
  source_anchor: string | null
  raw_href: string
  normalized_href: string | null
  target_folder: ProductDocFolder | null
  target_slug: string | null
  target_anchor: string | null
  target_doc_id: string | null
  target_section_id: string | null
  link_type: 'resolved' | 'broken' | 'ambiguous' | 'external' | 'code'
}

export interface ProductDocSectionIndex {
  sections: ProductDocSectionRecord[]
  links: ProductDocLinkRecord[]
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
}

function bodyOf(contentMd: string): string {
  const parsed = parseProductDocMd(contentMd)
  return parsed.ok ? parsed.body : contentMd
}

function stripFencedCode(md: string): string {
  const out: string[] = []
  let fence: string | null = null
  for (const line of md.split('\n')) {
    const m = /^(\s*)(```|~~~)/.exec(line)
    if (m) {
      fence = fence === null ? m[2] : null
      out.push('')
      continue
    }
    out.push(fence === null ? line : '')
  }
  return out.join('\n')
}

function headingText(raw: string): string {
  return raw.replace(/\s+#+\s*$/, '').trim()
}

function uniqueAnchor(text: string, counts: Map<string, number>, fallback: string): string {
  const base = slugify(text) || fallback
  const next = (counts.get(base) ?? 0) + 1
  counts.set(base, next)
  return next === 1 ? base : `${base}-${next}`
}

export function extractProductDocSections(
  source: ProductDocSectionSource,
): ProductDocSectionRecord[] {
  const body = stripFencedCode(bodyOf(source.content_md))
  const lines = body.split('\n')
  const headings: Array<{ line: number; level: number; text: string; anchor: string; path: string }> = []
  const stack: Array<{ level: number; text: string }> = []
  const anchorCounts = new Map<string, number>()

  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i])
    if (!m) continue
    const level = m[1].length
    const text = headingText(m[2])
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
    stack.push({ level, text })
    headings.push({
      line: i,
      level,
      text,
      anchor: uniqueAnchor(text, anchorCounts, `section-${headings.length + 1}`),
      path: stack.map((h) => h.text).join(' > '),
    })
  }

  if (headings.length === 0) {
    const content = body.trim()
    return [{
      product_id: source.product_id,
      doc_id: source.doc_id,
      revision_id: source.revision_id,
      folder: source.folder,
      slug: source.slug,
      anchor: 'document',
      heading_path: source.title,
      heading_level: 0,
      sort_order: 0,
      title: source.title,
      status: source.status,
      content_text: content,
      content_hash: sha256(content),
    }]
  }

  return headings.map((h, idx) => {
    const next = headings[idx + 1]
    const content = lines.slice(h.line + 1, next ? next.line : lines.length).join('\n').trim()
    return {
      product_id: source.product_id,
      doc_id: source.doc_id,
      revision_id: source.revision_id,
      folder: source.folder,
      slug: source.slug,
      anchor: h.anchor,
      heading_path: h.path,
      heading_level: h.level,
      sort_order: idx,
      title: source.title,
      status: source.status,
      content_text: content,
      content_hash: sha256(content),
    }
  })
}

export function parseMarkdownLinksRaw(contentMd: string): RawMarkdownLink[] {
  const body = stripFencedCode(bodyOf(contentMd))
  const out: RawMarkdownLink[] = []
  RAW_LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RAW_LINK_RE.exec(body)) !== null) {
    out.push({ raw: m[0], text: m[1], href: m[2] })
  }
  return out
}

function isCodeHref(href: string): boolean {
  if (CODE_EXTENSIONS.test(href)) return true
  return CODE_PATH_HINTS.some((hint) => href.includes(hint))
}

function apiToFolderEnum(api: string): ProductDocFolder | null {
  const lower = api.toLowerCase()
  if (!(PRODUCT_DOC_FOLDERS_API as readonly string[]).includes(lower)) return null
  return lower.toUpperCase() as ProductDocFolder
}

function splitPathAnchor(href: string): { pathPart: string; anchor: string | null } {
  const hashIdx = href.indexOf('#')
  const queryIdx = href.indexOf('?')
  const splitIdx = [hashIdx, queryIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0]
  if (splitIdx === undefined) return { pathPart: href, anchor: null }
  return {
    pathPart: href.slice(0, splitIdx),
    anchor: href[splitIdx] === '#' ? href.slice(splitIdx + 1) : null,
  }
}

function resolveCandidate(
  source: Pick<ProductDocSectionSource, 'folder' | 'slug'>,
  href: string,
): { folder: ProductDocFolder; slug: string; anchor: string | null; normalized: string } | null {
  const { pathPart, anchor } = splitPathAnchor(href)
  if (!/\.md$/i.test(pathPart)) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    return null
  }

  const sourcePath = `/${productDocFolderToApi(source.folder)}/${source.slug}.md`
  const targetPath = path.posix.resolve(path.posix.dirname(sourcePath), decoded)
  const trimmed = targetPath.replace(/^\//, '').replace(/\.md$/i, '')
  const parts = trimmed.split('/')
  if (parts.length !== 2) return null
  const folder = apiToFolderEnum(parts[0])
  if (!folder) return null
  const slug = parts[1].toLowerCase()
  if (!slug) return null
  return { folder, slug, anchor, normalized: href }
}

export function classifyProductDocLink(
  link: RawMarkdownLink,
  source: ProductDocSectionSource,
  known: {
    productDocs: KnownProductDoc[]
    productSections: KnownProductSection[]
  },
): ProductDocLinkRecord {
  const base = {
    product_id: source.product_id,
    source_doc_id: source.doc_id,
    source_anchor: null,
    raw_href: link.href,
    normalized_href: link.href,
    target_folder: null,
    target_slug: null,
    target_anchor: null,
    target_doc_id: null,
    target_section_id: null,
  } satisfies Omit<ProductDocLinkRecord, 'link_type'>

  if (EXTERNAL_PROTOCOL.test(link.href)) {
    return { ...base, link_type: 'external' }
  }
  if (isCodeHref(link.href)) {
    return { ...base, link_type: 'code' }
  }

  const candidate = resolveCandidate(source, link.href)
  if (!candidate) return { ...base, normalized_href: link.href, link_type: 'broken' }

  const docs = known.productDocs.filter(
    (d) => d.folder === candidate.folder && d.slug.toLowerCase() === candidate.slug,
  )
  const targetDoc = docs.length === 1 ? docs[0] : null
  const targetSection = targetDoc && candidate.anchor
    ? known.productSections.find(
        (s) => s.doc_id === targetDoc.id && s.anchor === candidate.anchor,
      )
    : null
  const linkType =
    docs.length > 1
      ? 'ambiguous'
      : targetDoc && (!candidate.anchor || targetSection)
        ? 'resolved'
        : 'broken'

  return {
    ...base,
    normalized_href: candidate.normalized,
    target_folder: candidate.folder,
    target_slug: candidate.slug,
    target_anchor: candidate.anchor,
    target_doc_id: targetDoc?.id ?? null,
    target_section_id: targetSection?.id ?? null,
    link_type: linkType,
  }
}

export function buildProductDocSectionIndex(
  source: ProductDocSectionSource,
  known: {
    productDocs: KnownProductDoc[]
    productSections: KnownProductSection[]
  },
): ProductDocSectionIndex {
  const sections = extractProductDocSections(source)
  const links = sections.flatMap((section) =>
    parseMarkdownLinksRaw(section.content_text).map((link) => ({
      ...classifyProductDocLink(link, source, known),
      source_anchor: section.anchor,
    })),
  )
  return { sections, links }
}
