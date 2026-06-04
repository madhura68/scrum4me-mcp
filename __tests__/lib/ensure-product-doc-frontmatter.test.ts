import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { ensureProductDocFrontmatter } from '../../src/lib/ensure-product-doc-frontmatter.js'
import { productDocFrontmatterSchema } from '../../src/lib/product-doc-schemas.js'

function frontmatterOf(md: string) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return m ? parseYaml(m[1]) : null
}

describe('ensureProductDocFrontmatter', () => {
  it('injects title+status when no frontmatter exists', () => {
    const out = ensureProductDocFrontmatter('# Body', 'My Idea')
    expect(productDocFrontmatterSchema.safeParse(frontmatterOf(out)).success).toBe(true)
    expect(out).toContain('# Body') // body preserved
  })

  it('coerces a grill-style status:grilled to draft and keeps other keys', () => {
    // Reproduces the production failure: the grill agent wrote the lifecycle word
    // `grilled` (not a ProductDoc status) → update_idea_grill_md previously rejected
    // it as "content_md is niet parseerbaar" and burned a retry turn.
    const md = '---\ntitle: "worker id"\nstatus: grilled\nlast_updated: 2026-06-04\n---\n\n# Idee'
    const out = ensureProductDocFrontmatter(md, 'worker id')
    const fm = frontmatterOf(out) as Record<string, unknown>
    expect(productDocFrontmatterSchema.safeParse(fm).success).toBe(true)
    expect(fm.status).toBe('draft')
    expect(fm.title).toBe('worker id')
    expect(fm.last_updated).toBe('2026-06-04') // unrelated keys preserved
    expect(out).toContain('# Idee') // body preserved
  })

  it('leaves already-valid frontmatter byte-for-byte untouched', () => {
    const md = '---\ntitle: Keep\nstatus: active\n---\n\nbody'
    expect(ensureProductDocFrontmatter(md, 'Other')).toBe(md)
  })

  it('replaces a whitespace-only title with the provided title', () => {
    const md = '---\ntitle: "   "\nstatus: draft\n---\n\nbody'
    const fm = frontmatterOf(ensureProductDocFrontmatter(md, 'Injected')) as Record<string, unknown>
    expect(fm.title).toBe('Injected')
  })

  it('injects title+status for scalar and array frontmatter blocks', () => {
    for (const md of ['---\njust a string\n---\n\nbody', '---\n- a\n- b\n---\n\nbody']) {
      const out = ensureProductDocFrontmatter(md, 'Injected')
      expect(productDocFrontmatterSchema.safeParse(frontmatterOf(out)).success).toBe(true)
    }
  })

  it('returns malformed-YAML frontmatter unchanged so the parser surfaces the error', () => {
    const md = '---\ntitle: "unterminated\n---\n\nbody'
    expect(ensureProductDocFrontmatter(md, 'X')).toBe(md)
  })

  it('is idempotent on its own output', () => {
    const out1 = ensureProductDocFrontmatter('# Body', 'My Idea')
    expect(ensureProductDocFrontmatter(out1, 'My Idea')).toBe(out1)
  })
})
