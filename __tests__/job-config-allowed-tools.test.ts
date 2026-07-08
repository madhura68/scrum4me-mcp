import { describe, it, expect } from 'vitest'
import { getKindDefault } from '../src/lib/job-config.js'

describe('idea kinds can manage questions', () => {
  it('IDEA_GRILL allows the full question-management triple', () => {
    const tools = getKindDefault('IDEA_GRILL').allowed_tools ?? []
    expect(tools).toContain('mcp__scrum4me__get_question_answer')
    expect(tools).toContain('mcp__scrum4me__cancel_question')
    expect(tools).toContain('mcp__scrum4me__list_open_questions')
  })

  it('IDEA_REVIEW_PLAN is pure review (M20): submit_review, geen question-management', () => {
    const tools = getKindDefault('IDEA_REVIEW_PLAN').allowed_tools ?? []
    expect(tools).toContain('mcp__scrum4me__submit_review')
    expect(tools).toContain('mcp__scrum4me__get_idea_context')
    expect(tools).not.toContain('mcp__scrum4me__ask_user_question')
    expect(tools).not.toContain('mcp__scrum4me__get_question_answer')
    expect(tools).not.toContain('mcp__scrum4me__update_idea_plan_md')
  })
})

describe('idea/plan kinds can fetch the agent guide', () => {
  // The worker follows the global Scrum4Me-methodiek (baked into its
  // environment, not the kind-prompt) and calls get_agent_guide to orient
  // itself. Without this grant the call is denied every run — non-fatal but
  // it burns a turn, emits an error-event → a triage insight, and the agent
  // proceeds without the guide. Also guards the planned shared-lib migration
  // (see job-config.ts header) from dropping the grant for idea-kinds.
  const KINDS = ['IDEA_GRILL', 'IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN', 'PLAN_CHAT'] as const
  for (const kind of KINDS) {
    it(`${kind} allows mcp__scrum4me__get_agent_guide`, () => {
      const tools = getKindDefault(kind).allowed_tools ?? []
      expect(tools).toContain('mcp__scrum4me__get_agent_guide')
    })
  }
})
