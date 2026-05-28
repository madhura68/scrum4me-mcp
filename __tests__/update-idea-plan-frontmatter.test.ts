import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { ensureProductDocFrontmatter } from '../src/tools/update-idea-plan-md.js'
import { productDocFrontmatterSchema } from '../src/lib/product-doc-schemas.js'

function frontmatterOf(md: string) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return m ? parseYaml(m[1]) : null
}

describe('ensureProductDocFrontmatter', () => {
  it('injects title+status when no frontmatter exists', () => {
    const out = ensureProductDocFrontmatter('# Plan body', 'My Idea')
    expect(productDocFrontmatterSchema.safeParse(frontmatterOf(out)).success).toBe(true)
  })

  it('merges title+status into existing plan frontmatter and keeps plan keys', () => {
    const plan = '---\npbi:\n  title: Build X\nstories: []\n---\n\n# Body'
    const out = ensureProductDocFrontmatter(plan, 'My Idea')
    const fm = frontmatterOf(out) as Record<string, unknown>
    expect(productDocFrontmatterSchema.safeParse(fm).success).toBe(true) // title+status now present
    expect(fm.pbi).toBeDefined() // original plan keys preserved
  })

  it('leaves already-valid frontmatter untouched in substance', () => {
    const md = '---\ntitle: Keep\nstatus: active\n---\n\nbody'
    const fm = frontmatterOf(ensureProductDocFrontmatter(md, 'Other')) as Record<string, unknown>
    expect(fm.title).toBe('Keep')
    expect(fm.status).toBe('active')
  })

  it('replaces a whitespace-only title with the provided title', () => {
    const md = '---\ntitle: "   "\nstatus: draft\n---\n\nbody'
    const out = ensureProductDocFrontmatter(md, 'Injected Title')
    const fm = frontmatterOf(out) as Record<string, unknown>
    expect(productDocFrontmatterSchema.safeParse(fm).success).toBe(true)
    expect(fm.title).toBe('Injected Title')
  })

  it('overwrites a present-but-invalid status with draft', () => {
    const md = '---\ntitle: My Plan\nstatus: published\n---\n\nbody'
    const out = ensureProductDocFrontmatter(md, 'My Idea')
    const fm = frontmatterOf(out) as Record<string, unknown>
    expect(productDocFrontmatterSchema.safeParse(fm).success).toBe(true)
    expect(fm.status).toBe('draft')
    expect(fm.title).toBe('My Plan') // existing valid title kept
  })

  it('injects title+status for a scalar (non-object) frontmatter block', () => {
    const md = '---\njust a string\n---\n\nbody'
    const out = ensureProductDocFrontmatter(md, 'Injected')
    expect(productDocFrontmatterSchema.safeParse(frontmatterOf(out)).success).toBe(true)
  })

  it('injects title+status for an array frontmatter block', () => {
    const md = '---\n- a\n- b\n---\n\nbody'
    const out = ensureProductDocFrontmatter(md, 'Injected')
    expect(productDocFrontmatterSchema.safeParse(frontmatterOf(out)).success).toBe(true)
  })

  it('is idempotent: feeding already-valid output back returns the same string', () => {
    const md = '# Plan body'
    const out1 = ensureProductDocFrontmatter(md, 'My Idea')
    const out2 = ensureProductDocFrontmatter(out1, 'My Idea')
    expect(out2).toBe(out1)
  })
})
