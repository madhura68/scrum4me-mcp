import { describe, it, expect } from 'vitest'
import { AGENT_GUIDE_DEFAULT } from '../../src/lib/agent-guide-default.js'

describe('AGENT_GUIDE_DEFAULT', () => {
  it('is non-empty and within a sane size bound', () => {
    expect(AGENT_GUIDE_DEFAULT.length).toBeGreaterThan(0)
    expect(AGENT_GUIDE_DEFAULT.length).toBeLessThan(8000)
  })

  it('is model-agnostic (no brand coupling)', () => {
    expect(AGENT_GUIDE_DEFAULT.toLowerCase()).not.toContain('claude')
  })

  it('references the MCP documenting tools', () => {
    expect(AGENT_GUIDE_DEFAULT).toContain('log_implementation')
    expect(AGENT_GUIDE_DEFAULT).toContain('log_commit')
    expect(AGENT_GUIDE_DEFAULT).toContain('create_product_doc')
  })

  it('has the operating-manual section headers', () => {
    expect(AGENT_GUIDE_DEFAULT).toContain('Build well')
    expect(AGENT_GUIDE_DEFAULT).toContain('Document as you go')
    expect(AGENT_GUIDE_DEFAULT).toContain('Verify and hand off')
  })
})
