import { describe, it, expect } from 'vitest'
import { INSTRUCTIONS } from '../src/instructions.js'

describe('shared MCP INSTRUCTIONS', () => {
  it('points interactive callers at get_context', () => {
    expect(INSTRUCTIONS).toContain('get_context')
  })

  it('points workers at get_agent_guide before building/documenting', () => {
    expect(INSTRUCTIONS).toContain('get_agent_guide')
  })
})
