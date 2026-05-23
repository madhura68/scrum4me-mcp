import { describe, it, expect } from 'vitest'
import type { ClaudeJobKind } from '@prisma/client'
import { getKindPromptText, getIdeaPromptText } from '../src/lib/kind-prompts.js'

const KINDS: ClaudeJobKind[] = [
  'IDEA_GRILL',
  'IDEA_MAKE_PLAN',
  'TASK_IMPLEMENTATION',
  'SPRINT_IMPLEMENTATION',
  'PLAN_CHAT',
]

describe('getKindPromptText', () => {
  it.each(KINDS)('returnt non-empty content voor %s', (kind) => {
    const text = getKindPromptText(kind)
    expect(text.length).toBeGreaterThan(0)
  })

  it('TASK_IMPLEMENTATION-prompt verbiedt wait_for_job', () => {
    const text = getKindPromptText('TASK_IMPLEMENTATION')
    expect(text).toMatch(/GEEN.*wait_for_job/)
  })

  it('SPRINT_IMPLEMENTATION-prompt verbiedt job_heartbeat', () => {
    const text = getKindPromptText('SPRINT_IMPLEMENTATION')
    expect(text).toMatch(/GEEN.*job_heartbeat/)
  })

  it.each(KINDS)(
    '%s-prompt noemt $PAYLOAD_PATH als variabele (alle kinds — runner doet substitution)',
    (kind) => {
      const text = getKindPromptText(kind)
      expect(text).toContain('$PAYLOAD_PATH')
    },
  )

  it.each(['IDEA_GRILL', 'IDEA_MAKE_PLAN'] as const)(
    '%s-prompt verwijst niet meer naar wait_for_job (refactor: runner claimt)',
    (kind) => {
      const text = getKindPromptText(kind)
      expect(text).not.toContain('wait_for_job')
    },
  )

  it.each(['IDEA_GRILL', 'IDEA_MAKE_PLAN'] as const)(
    '%s-prompt bevat geen onvervangen {idea_*} placeholders',
    (kind) => {
      const text = getKindPromptText(kind)
      expect(text).not.toMatch(/\{idea_code\}|\{idea_title\}/)
    },
  )
})

describe('agent-guide rule in implementation prompts', () => {
  it.each(['TASK_IMPLEMENTATION', 'SPRINT_IMPLEMENTATION'] as const)(
    '%s-prompt instructs calling get_agent_guide',
    (kind) => {
      expect(getKindPromptText(kind)).toContain('get_agent_guide')
    },
  )
})

describe('implementation prompts: invariants preserved after dedupe', () => {
  it('TASK keeps safety hardstops, worktree rule, guide pointer, logging tools', () => {
    const t = getKindPromptText('TASK_IMPLEMENTATION')
    expect(t).toMatch(/GEEN.*wait_for_job/)
    expect(t).toContain('worktree')
    expect(t).toContain('get_agent_guide')
    expect(t).toContain('log_implementation')
    expect(t).toContain('log_commit')
    expect(t).toContain('log_test_result')
  })

  it('SPRINT keeps safety hardstops, worktree rule, guide pointer, logging tools', () => {
    const s = getKindPromptText('SPRINT_IMPLEMENTATION')
    expect(s).toMatch(/GEEN.*job_heartbeat/)
    expect(s).toContain('worktree')
    expect(s).toContain('get_agent_guide')
    expect(s).toContain('log_implementation')
    expect(s).toContain('log_commit')
    expect(s).toContain('log_test_result')
  })
})

describe('sprint prompt orchestrates sub-agents', () => {
  it('SPRINT instructs Agent sub-agent dispatch and keeps the verify-gate in the main session', () => {
    const s = getKindPromptText('SPRINT_IMPLEMENTATION')
    expect(s).toContain('Agent')
    expect(s).toContain('sub-agent')
    expect(s).toContain('verify_sprint_task')
    expect(s).toMatch(/GEEN.*job_heartbeat/)
    expect(s).toContain('worktree')
    expect(s).toContain('get_agent_guide')
  })
})

describe('getIdeaPromptText (back-compat)', () => {
  it('returnt content voor IDEA_GRILL', () => {
    expect(getIdeaPromptText('IDEA_GRILL').length).toBeGreaterThan(0)
  })
  it('returnt content voor IDEA_MAKE_PLAN', () => {
    expect(getIdeaPromptText('IDEA_MAKE_PLAN').length).toBeGreaterThan(0)
  })
  it('returnt empty string voor non-idea kind', () => {
    expect(getIdeaPromptText('TASK_IMPLEMENTATION')).toBe('')
  })
})
