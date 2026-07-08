import { describe, it, expect } from 'vitest'
import { getKindDefault, resolveJobConfig, mapBudgetToEffort } from '../src/lib/job-config.js'

const KIND_EXPECTED = {
  IDEA_GRILL: { model: 'claude-sonnet-4-6', thinking_budget: 12000, permission_mode: 'acceptEdits', max_turns: 15 },
  IDEA_MAKE_PLAN: { model: 'claude-opus-4-8', thinking_budget: 24000, permission_mode: 'acceptEdits', max_turns: 20 },
  IDEA_REVIEW_PLAN: { model: 'claude-opus-4-8', thinking_budget: 6000, permission_mode: 'default', max_turns: 50 },
  PLAN_CHAT: { model: 'claude-sonnet-4-6', thinking_budget: 6000, permission_mode: 'acceptEdits', max_turns: 5 },
  TASK_IMPLEMENTATION: { model: 'claude-opus-4-8', thinking_budget: 6000, permission_mode: 'bypassPermissions', max_turns: 50 },
  SPRINT_IMPLEMENTATION: { model: 'claude-opus-4-8', thinking_budget: 6000, permission_mode: 'bypassPermissions', max_turns: null },
} as const

describe('getKindDefault', () => {
  for (const [kind, expected] of Object.entries(KIND_EXPECTED)) {
    it(`returnt de juiste defaults voor ${kind}`, () => {
      const cfg = getKindDefault(kind)
      expect(cfg.model).toBe(expected.model)
      expect(cfg.thinking_budget).toBe(expected.thinking_budget)
      expect(cfg.permission_mode).toBe(expected.permission_mode)
      expect(cfg.max_turns).toBe(expected.max_turns)
    })
  }

  it('valt terug op een veilige fallback voor onbekende kinds', () => {
    const cfg = getKindDefault('SOMETHING_NEW')
    expect(cfg.model).toBe('claude-sonnet-4-6')
    expect(cfg.permission_mode).toBe('default')
  })
})

describe('resolveJobConfig — geen overrides', () => {
  for (const kind of Object.keys(KIND_EXPECTED)) {
    it(`returnt kind-default voor ${kind} zonder overrides`, () => {
      const cfg = resolveJobConfig({ kind }, {})
      expect(cfg).toEqual(getKindDefault(kind))
    })
  }
})

describe('resolveJobConfig — cascade', () => {
  it('product.preferred_model overrult kind-default', () => {
    const cfg = resolveJobConfig({ kind: 'TASK_IMPLEMENTATION' }, { preferred_model: 'claude-haiku-4-5-20251001' })
    expect(cfg.model).toBe('claude-haiku-4-5-20251001')
  })

  it('job.requested_model overrult product.preferred_model', () => {
    const cfg = resolveJobConfig(
      { kind: 'TASK_IMPLEMENTATION', requested_model: 'claude-opus-4-8' },
      { preferred_model: 'claude-haiku-4-5-20251001' },
    )
    expect(cfg.model).toBe('claude-opus-4-8')
  })

  it('task.requires_opus overrult product.preferred_model', () => {
    const cfg = resolveJobConfig(
      { kind: 'TASK_IMPLEMENTATION' },
      { preferred_model: 'claude-sonnet-4-6' },
      { requires_opus: true },
    )
    expect(cfg.model).toBe('claude-opus-4-8')
  })

  it('task.requires_opus overrult ook job.requested_model = haiku', () => {
    const cfg = resolveJobConfig(
      { kind: 'TASK_IMPLEMENTATION', requested_model: 'claude-haiku-4-5-20251001' },
      {},
      { requires_opus: true },
    )
    expect(cfg.model).toBe('claude-opus-4-8')
  })

  it('job.requested_thinking_budget overrult kind-default', () => {
    const cfg = resolveJobConfig({ kind: 'PLAN_CHAT', requested_thinking_budget: 1024 }, {})
    expect(cfg.thinking_budget).toBe(1024)
  })

  it('product.thinking_budget_default overrult kind-default', () => {
    const cfg = resolveJobConfig({ kind: 'IDEA_GRILL' }, { thinking_budget_default: 0 })
    expect(cfg.thinking_budget).toBe(0)
  })

  it('product.preferred_permission_mode = acceptEdits overrult bypassPermissions voor TASK_IMPLEMENTATION', () => {
    const cfg = resolveJobConfig(
      { kind: 'TASK_IMPLEMENTATION' },
      { preferred_permission_mode: 'acceptEdits' },
    )
    expect(cfg.permission_mode).toBe('acceptEdits')
  })

  it('max_turns blijft kind-default ook met product- en job-overrides (geen V1-cascade)', () => {
    const cfg = resolveJobConfig(
      { kind: 'IDEA_GRILL', requested_model: 'claude-haiku-4-5-20251001' },
      { preferred_model: 'claude-sonnet-4-6' },
    )
    expect(cfg.max_turns).toBe(15)
  })
})

describe('KIND_DEFAULTS.allowed_tools', () => {
  it('TASK_IMPLEMENTATION bevat geen claim-tools', () => {
    const cfg = getKindDefault('TASK_IMPLEMENTATION')
    expect(cfg.allowed_tools).not.toContain('mcp__scrum4me__wait_for_job')
    expect(cfg.allowed_tools).not.toContain('mcp__scrum4me__check_queue_empty')
    expect(cfg.allowed_tools).not.toContain('mcp__scrum4me__get_idea_context')
  })

  it('TASK_IMPLEMENTATION bevat de essentiële task-tools', () => {
    const cfg = getKindDefault('TASK_IMPLEMENTATION')
    expect(cfg.allowed_tools).toContain('mcp__scrum4me__update_task_status')
    expect(cfg.allowed_tools).toContain('mcp__scrum4me__update_job_status')
    expect(cfg.allowed_tools).toContain('mcp__scrum4me__verify_task_against_plan')
    expect(cfg.allowed_tools).toContain('Bash')
    expect(cfg.allowed_tools).toContain('Edit')
    expect(cfg.allowed_tools).toContain('Write')
  })

  it('SPRINT_IMPLEMENTATION bevat sprint-specifieke tools maar GEEN job_heartbeat (runner doet die)', () => {
    const cfg = getKindDefault('SPRINT_IMPLEMENTATION')
    expect(cfg.allowed_tools).toContain('mcp__scrum4me__update_task_execution')
    expect(cfg.allowed_tools).toContain('mcp__scrum4me__verify_sprint_task')
    expect(cfg.allowed_tools).not.toContain('mcp__scrum4me__job_heartbeat')
  })

  it('IDEA_GRILL bevat update_idea_grill_md en geen wait_for_job', () => {
    const cfg = getKindDefault('IDEA_GRILL')
    expect(cfg.allowed_tools).toContain('mcp__scrum4me__update_idea_grill_md')
    expect(cfg.allowed_tools).toContain('mcp__scrum4me__log_idea_decision')
    expect(cfg.allowed_tools).toContain('mcp__scrum4me__update_job_status')
    expect(cfg.allowed_tools).not.toContain('mcp__scrum4me__wait_for_job')
  })

  it('IDEA_MAKE_PLAN bevat update_idea_plan_md en geen wait_for_job', () => {
    const cfg = getKindDefault('IDEA_MAKE_PLAN')
    expect(cfg.allowed_tools).toContain('mcp__scrum4me__update_idea_plan_md')
    expect(cfg.allowed_tools).toContain('mcp__scrum4me__log_idea_decision')
    expect(cfg.allowed_tools).not.toContain('mcp__scrum4me__wait_for_job')
  })

  it('alle kinds hebben non-null allowed_tools', () => {
    for (const kind of ['IDEA_GRILL', 'IDEA_MAKE_PLAN', 'PLAN_CHAT', 'TASK_IMPLEMENTATION', 'SPRINT_IMPLEMENTATION']) {
      const cfg = getKindDefault(kind)
      expect(cfg.allowed_tools).not.toBeNull()
      expect(Array.isArray(cfg.allowed_tools)).toBe(true)
    }
  })
})

describe('agent-guide tool allowlist', () => {
  it('TASK_IMPLEMENTATION may call get_agent_guide', () => {
    expect(getKindDefault('TASK_IMPLEMENTATION').allowed_tools).toContain(
      'mcp__scrum4me__get_agent_guide',
    )
  })

  it('SPRINT_IMPLEMENTATION may call get_agent_guide (inherits TASK_TOOLS)', () => {
    expect(getKindDefault('SPRINT_IMPLEMENTATION').allowed_tools).toContain(
      'mcp__scrum4me__get_agent_guide',
    )
  })
})

describe('sub-agent allowlist', () => {
  it('SPRINT_IMPLEMENTATION may dispatch sub-agents (Agent tool)', () => {
    expect(getKindDefault('SPRINT_IMPLEMENTATION').allowed_tools).toContain('Agent')
  })

  it('TASK_IMPLEMENTATION may NOT dispatch sub-agents', () => {
    expect(getKindDefault('TASK_IMPLEMENTATION').allowed_tools).not.toContain('Agent')
  })
})

describe('mapBudgetToEffort', () => {
  it.each([
    [0, null],
    [-1, null],
    [1, 'medium'],
    [3000, 'medium'],
    [6000, 'medium'],
    [6001, 'high'],
    [9000, 'high'],
    [12000, 'high'],
    [12001, 'xhigh'],
    [18000, 'xhigh'],
    [24000, 'xhigh'],
    [24001, 'max'],
    [50000, 'max'],
    [100000, 'max'],
  ])('budget %i → %s', (budget, expected) => {
    expect(mapBudgetToEffort(budget)).toBe(expected)
  })
})
