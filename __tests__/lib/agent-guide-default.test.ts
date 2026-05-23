import { describe, it, expect } from 'vitest'
import { AGENT_GUIDE_DEFAULT } from '../../src/lib/agent-guide-default.js'

describe('AGENT_GUIDE_DEFAULT', () => {
  it('is non-empty', () => {
    expect(AGENT_GUIDE_DEFAULT.length).toBeGreaterThan(0)
  })

  it('is model-agnostic (no brand coupling)', () => {
    expect(AGENT_GUIDE_DEFAULT.toLowerCase()).not.toContain('claude')
  })

  it('references the MCP logging tools and worktree discipline', () => {
    expect(AGENT_GUIDE_DEFAULT).toContain('log_implementation')
    expect(AGENT_GUIDE_DEFAULT).toContain('worktree')
  })
})
