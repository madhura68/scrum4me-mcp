import { describe, it, expect } from 'vitest'
import { INSTRUCTIONS } from '../src/instructions.js'

describe('shared MCP INSTRUCTIONS', () => {
  it('points interactive callers at get_context', () => {
    expect(INSTRUCTIONS).toContain('get_context')
  })

  it('references get_agent_guide for jobs or a missing startup guide', () => {
    expect(INSTRUCTIONS).toContain('get_agent_guide')
  })
})
