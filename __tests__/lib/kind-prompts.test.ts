import { describe, it, expect } from 'vitest'
import { getKindPromptText, getIdeaPromptText } from '../../src/lib/kind-prompts.js'

describe('getKindPromptText runtime-awareness', () => {
  it('returns the codex variant for (IDEA_REVIEW_PLAN, CODEX)', () => {
    const text = getKindPromptText('IDEA_REVIEW_PLAN', 'CODEX')
    expect(text).toContain('Runtime: CODEX')
    expect(text).not.toContain('ask_user_question')
  })

  it('returns the existing Claude prompt for (IDEA_REVIEW_PLAN, CLAUDE)', () => {
    const text = getKindPromptText('IDEA_REVIEW_PLAN', 'CLAUDE')
    expect(text).toContain('ask_user_question')
  })

  it('defaults to CLAUDE when runtime is omitted (back-compat)', () => {
    expect(getKindPromptText('IDEA_REVIEW_PLAN')).toBe(getKindPromptText('IDEA_REVIEW_PLAN', 'CLAUDE'))
  })

  it('uses the shared prompt for non-overridden kinds regardless of runtime', () => {
    expect(getKindPromptText('PLAN_CHAT', 'CODEX')).toBe(getKindPromptText('PLAN_CHAT', 'CLAUDE'))
    expect(getKindPromptText('TASK_IMPLEMENTATION', 'CODEX')).toBe(getKindPromptText('TASK_IMPLEMENTATION', 'CLAUDE'))
  })

  it('getIdeaPromptText threads runtime through', () => {
    expect(getIdeaPromptText('IDEA_REVIEW_PLAN', 'CODEX')).toBe(getKindPromptText('IDEA_REVIEW_PLAN', 'CODEX'))
  })
})
