import { describe, it, expect } from 'vitest'
import { getKindDefault } from '../src/lib/job-config.js'

describe('idea kinds can manage questions', () => {
  it('IDEA_GRILL allows the full question-management triple', () => {
    const tools = getKindDefault('IDEA_GRILL').allowed_tools ?? []
    expect(tools).toContain('mcp__scrum4me__get_question_answer')
    expect(tools).toContain('mcp__scrum4me__cancel_question')
    expect(tools).toContain('mcp__scrum4me__list_open_questions')
  })

  it('IDEA_REVIEW_PLAN allows the full question-management triple', () => {
    const tools = getKindDefault('IDEA_REVIEW_PLAN').allowed_tools ?? []
    expect(tools).toContain('mcp__scrum4me__get_question_answer')
    expect(tools).toContain('mcp__scrum4me__cancel_question')
    expect(tools).toContain('mcp__scrum4me__list_open_questions')
  })
})
