// PBI-67: model + mode-selectie per ClaudeJob-kind.
//
// Override-cascade (eerste match wint):
//   1. task.requires_opus === true       → forceer Opus
//   2. job.requested_*  (snapshot bij enqueue)
//   3. product.preferred_*
//   4. KIND_DEFAULTS hieronder

export type ClaudeModel =
  | 'claude-opus-4-7'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5-20251001'

export type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions'

export type JobConfig = {
  model: ClaudeModel
  thinking_budget: number // 0 = uit
  permission_mode: PermissionMode
  max_turns: number | null // null = onbegrensd
  allowed_tools: string[] | null // null = alle
}

export type JobInput = {
  kind: string
  requested_model?: string | null
  requested_thinking_budget?: number | null
  requested_permission_mode?: string | null
}

export type ProductInput = {
  preferred_model?: string | null
  thinking_budget_default?: number | null
  preferred_permission_mode?: string | null
}

export type TaskInput = {
  requires_opus?: boolean | null
}

const KIND_DEFAULTS: Record<string, JobConfig> = {
  IDEA_GRILL: {
    model: 'claude-sonnet-4-6',
    thinking_budget: 12000,
    permission_mode: 'plan',
    max_turns: 15,
    allowed_tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'AskUserQuestion'],
  },
  IDEA_MAKE_PLAN: {
    model: 'claude-opus-4-7',
    thinking_budget: 24000,
    permission_mode: 'plan',
    max_turns: 20,
    allowed_tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'AskUserQuestion', 'Write'],
  },
  PLAN_CHAT: {
    model: 'claude-sonnet-4-6',
    thinking_budget: 6000,
    permission_mode: 'plan',
    max_turns: 5,
    allowed_tools: ['Read', 'Grep', 'AskUserQuestion'],
  },
  TASK_IMPLEMENTATION: {
    model: 'claude-sonnet-4-6',
    thinking_budget: 6000,
    permission_mode: 'bypassPermissions',
    max_turns: 50,
    allowed_tools: null,
  },
  SPRINT_IMPLEMENTATION: {
    model: 'claude-sonnet-4-6',
    thinking_budget: 6000,
    permission_mode: 'bypassPermissions',
    max_turns: null,
    allowed_tools: null,
  },
}

const FALLBACK: JobConfig = {
  model: 'claude-sonnet-4-6',
  thinking_budget: 6000,
  permission_mode: 'default',
  max_turns: 50,
  allowed_tools: null,
}

export function getKindDefault(kind: string): JobConfig {
  return KIND_DEFAULTS[kind] ?? FALLBACK
}

// max_turns en allowed_tools blijven kind-default (geen product/task override
// in V1 — als de behoefte ontstaat, voeg analoge velden toe aan Product/Task).
export function resolveJobConfig(
  job: JobInput,
  product: ProductInput,
  task?: TaskInput,
): JobConfig {
  const base = getKindDefault(job.kind)

  const model = (
    task?.requires_opus
      ? 'claude-opus-4-7'
      : job.requested_model ?? product.preferred_model ?? base.model
  ) as ClaudeModel

  const thinking_budget =
    job.requested_thinking_budget ?? product.thinking_budget_default ?? base.thinking_budget

  const permission_mode = (job.requested_permission_mode ??
    product.preferred_permission_mode ??
    base.permission_mode) as PermissionMode

  return {
    model,
    thinking_budget,
    permission_mode,
    max_turns: base.max_turns,
    allowed_tools: base.allowed_tools,
  }
}
