import { describe, it, expect } from 'vitest'
import { getKindDefault } from '../src/lib/job-config.js'

describe('idea kinds can manage questions', () => {
  it('IDEA_GRILL allows cancel_question + list_open_questions', () => {
    const tools = getKindDefault('IDEA_GRILL').allowed_tools ?? []
    expect(tools).toContain('mcp__scrum4me__cancel_question')
    expect(tools).toContain('mcp__scrum4me__list_open_questions')
  })
})
