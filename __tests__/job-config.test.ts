import { describe, it, expect } from 'vitest'
import { getKindDefault, resolveJobConfig } from '../src/lib/job-config.js'

const KIND_EXPECTED = {
  IDEA_GRILL: { model: 'claude-sonnet-4-6', thinking_budget: 12000, permission_mode: 'plan', max_turns: 15 },
  IDEA_MAKE_PLAN: { model: 'claude-opus-4-7', thinking_budget: 24000, permission_mode: 'plan', max_turns: 20 },
  PLAN_CHAT: { model: 'claude-sonnet-4-6', thinking_budget: 6000, permission_mode: 'plan', max_turns: 5 },
  TASK_IMPLEMENTATION: { model: 'claude-sonnet-4-6', thinking_budget: 6000, permission_mode: 'bypassPermissions', max_turns: 50 },
  SPRINT_IMPLEMENTATION: { model: 'claude-sonnet-4-6', thinking_budget: 6000, permission_mode: 'bypassPermissions', max_turns: null },
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
      { kind: 'TASK_IMPLEMENTATION', requested_model: 'claude-opus-4-7' },
      { preferred_model: 'claude-haiku-4-5-20251001' },
    )
    expect(cfg.model).toBe('claude-opus-4-7')
  })

  it('task.requires_opus overrult product.preferred_model', () => {
    const cfg = resolveJobConfig(
      { kind: 'TASK_IMPLEMENTATION' },
      { preferred_model: 'claude-sonnet-4-6' },
      { requires_opus: true },
    )
    expect(cfg.model).toBe('claude-opus-4-7')
  })

  it('task.requires_opus overrult ook job.requested_model = haiku', () => {
    const cfg = resolveJobConfig(
      { kind: 'TASK_IMPLEMENTATION', requested_model: 'claude-haiku-4-5-20251001' },
      {},
      { requires_opus: true },
    )
    expect(cfg.model).toBe('claude-opus-4-7')
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

  it('max_turns en allowed_tools blijven kind-default ook met product- en job-overrides (geen V1-cascade)', () => {
    const cfg = resolveJobConfig(
      { kind: 'IDEA_GRILL', requested_model: 'claude-haiku-4-5-20251001' },
      { preferred_model: 'claude-sonnet-4-6' },
    )
    expect(cfg.max_turns).toBe(15)
    expect(cfg.allowed_tools).toEqual(['Read', 'Grep', 'Glob', 'WebSearch', 'AskUserQuestion'])
  })
})
