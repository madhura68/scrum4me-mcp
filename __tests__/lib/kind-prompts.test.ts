import { describe, it, expect } from 'vitest'
import { getKindPromptText, getIdeaPromptText } from '../../src/lib/kind-prompts.js'

describe('getKindPromptText runtime-awareness', () => {
  it('returns the codex variant for (IDEA_REVIEW_PLAN, CODEX)', () => {
    const text = getKindPromptText('IDEA_REVIEW_PLAN', 'CODEX')
    expect(text).toContain('Runtime: CODEX')
    expect(text).not.toContain('ask_user_question')
  })

  it('returns the pure-review Claude prompt for (IDEA_REVIEW_PLAN, CLAUDE) (M20)', () => {
    const text = getKindPromptText('IDEA_REVIEW_PLAN', 'CLAUDE')
    expect(text).toContain('submit_review')
    expect(text).toContain('pure')
    expect(text).not.toContain('ask_user_question')
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

describe('getKindPromptText — PR_REVIEW', () => {
  it('(PR_REVIEW, CODEX) → codex-portable prompt zonder Claude-toolnamen', () => {
    const text = getKindPromptText('PR_REVIEW', 'CODEX')
    expect(text).toContain('post_pr_review')
    expect(text).not.toContain('ask_user_question')
    expect(text).not.toMatch(/\bGlob\b|\bGrep\b/)
  })
  it('(PR_REVIEW, CLAUDE) → niet-leeg Claude-fallback-pad', () => {
    const text = getKindPromptText('PR_REVIEW', 'CLAUDE')
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toEqual(getKindPromptText('PR_REVIEW', 'CODEX'))
  })
  it('default-runtime = CLAUDE', () => {
    expect(getKindPromptText('PR_REVIEW')).toEqual(getKindPromptText('PR_REVIEW', 'CLAUDE'))
  })
})

describe('getKindPromptText — SPEC_REVIEW', () => {
  it('SPEC_REVIEW: CODEX-override en Claude-fallback bestaan en verschillen', () => {
    const codex = getKindPromptText('SPEC_REVIEW', 'CODEX')
    const claude = getKindPromptText('SPEC_REVIEW', 'CLAUDE')
    expect(codex).toContain('submit_review')
    expect(codex).toContain('judge-only')
    expect(claude).toContain('submit_review')
    expect(codex).not.toBe(claude)
  })
})

describe('getKindPromptText — TASK_REVIEW', () => {
  it('TASK_REVIEW: CODEX-override en Claude-fallback bestaan en verschillen', () => {
    const codex = getKindPromptText('TASK_REVIEW', 'CODEX')
    const claude = getKindPromptText('TASK_REVIEW', 'CLAUDE')
    expect(codex).toContain('submit_review')
    expect(codex).toContain('task_diff')
    expect(claude).toContain('submit_review')
    expect(codex).not.toBe(claude)
  })
})
