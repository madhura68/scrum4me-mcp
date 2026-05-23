import { describe, it, expect } from 'vitest'
import { INSTRUCTIONS } from '../src/instructions.js'

describe('shared MCP INSTRUCTIONS', () => {
  it('keeps the existing get_claude_context guidance', () => {
    expect(INSTRUCTIONS).toContain('get_claude_context')
  })

  it('points workers at get_agent_guide before building/documenting', () => {
    expect(INSTRUCTIONS).toContain('get_agent_guide')
  })
})
