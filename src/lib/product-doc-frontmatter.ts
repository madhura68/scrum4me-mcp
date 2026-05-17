// PBI-102 (T-1123): DRY-mirror van Scrum4Me's setProductDocFrontmatterFields.
// Wijzig beide bestanden bij elke aanpassing.

import { parseDocument } from 'yaml'

const FRONTMATTER_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/

export function setProductDocFrontmatterFields(
  md: string,
  patch: Record<string, unknown>,
): string {
  const match = md.match(FRONTMATTER_RE)
  if (!match) {
    throw new Error(
      'setProductDocFrontmatterFields: input mist yaml-frontmatter (geen `---` opener gevonden)',
    )
  }

  const [, openMarker, frontmatterRaw, closeMarker, body] = match

  const doc = parseDocument(frontmatterRaw)
  if (doc.errors.length > 0) {
    throw new Error(
      `setProductDocFrontmatterFields: yaml parse-error op regel ${
        doc.errors[0].linePos?.[0]?.line ?? '?'
      }: ${doc.errors[0].message}`,
    )
  }

  for (const [key, value] of Object.entries(patch)) {
    doc.set(key, value)
  }

  const newFrontmatter = doc.toString().replace(/\r?\n$/, '')
  return `${openMarker}${newFrontmatter}${closeMarker}${body}`
}

export function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
