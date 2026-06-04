// Shared helper: guarantees a markdown blob carries ProductDoc-required
// `title`/`status` frontmatter that passes productDocFrontmatterSchema, so the
// grill/plan write-tools never reject agent-authored content over a missing or
// out-of-enum status. Behaviour:
//   - no frontmatter at all          → inject `{ title, status: draft }`
//   - frontmatter present, valid      → leave unchanged
//   - frontmatter present, bad title  → replace with the provided title
//   - frontmatter present, bad status → coerce to `draft`
//   - non-object frontmatter (scalar/array) → inject fresh title+status block
// Other keys in the block (e.g. plan-yaml `pbi`/`stories`) are preserved.
//
// Used by update-idea-grill-md.ts and update-idea-plan-md.ts.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { PRODUCT_DOC_STATUSES } from './product-doc-schemas.js'

const FM_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function ensureProductDocFrontmatter(md: string, title: string): string {
  const safeTitle = title.slice(0, 200)
  const m = md.match(FM_BLOCK_RE)
  if (!m) {
    const fm = stringifyYaml({ title: safeTitle, status: 'draft' }).trimEnd()
    return `---\n${fm}\n---\n\n${md}`
  }
  let data: Record<string, unknown>
  try {
    const raw = parseYaml(m[1])
    data =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
  } catch {
    return md // malformed YAML — let the parser surface the precise error
  }
  let changed = false
  if (typeof data.title !== 'string' || data.title.trim() === '') {
    data.title = safeTitle
    changed = true
  }
  if (!PRODUCT_DOC_STATUSES.includes(data.status as (typeof PRODUCT_DOC_STATUSES)[number])) {
    data.status = 'draft'
    changed = true
  }
  if (!changed) return md
  const fm = stringifyYaml(data).trimEnd()
  return md.replace(FM_BLOCK_RE, `---\n${fm}\n---\n\n`)
}
