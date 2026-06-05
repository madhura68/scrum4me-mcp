// M16 platform-split: dit bestand wordt een re-export shim van
// vendor/scrum4me-shared/lib/job-config.ts zodra de shared-lib is bijgewerkt
// met get_agent_guide (in TASK_TOOLS + de idea/plan-kinds) en Agent (in
// SPRINT_IMPLEMENTATION).
// Gebruik @shared/job-config voor directe imports nadat die update gemerged is.
//
// PBI-67: model + mode-selectie per ClaudeJob-kind.
//
// Override-cascade (eerste match wint):
//   1. task.requires_opus === true       → forceer Opus
//   2. job.requested_*  (snapshot bij enqueue, ingevuld door deze module)
//   3. product.preferred_*
//   4. KIND_DEFAULTS hieronder
//
// CLI-flag-mapping (Claude CLI 2.1.x):
//   - thinking_budget (number) → mapBudgetToEffort() → --effort {low,medium,high,xhigh,max}
//     (de CLI heeft geen --thinking-budget flag — alleen --effort)
//   - max_turns blijft audit-only: de CLI heeft géén --max-turns flag.
//     De waarde wordt gesnapshot voor cost-attribution maar niet doorgegeven.
//   - allowed_tools → --allowedTools (komma-gescheiden lijst)

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

// Tool-allowlists per kind. Bewust géén `wait_for_job`, `check_queue_empty`
// of `get_idea_context` — de runner (scrum4me-docker/bin/run-one-job.ts)
// claimt voor Claude. Vangrail tegen recursieve claims binnen één invocation.
const TASK_TOOLS = [
  'Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob',
  'mcp__scrum4me__get_claude_context',
  'mcp__scrum4me__get_agent_guide',
  'mcp__scrum4me__list_product_docs',
  'mcp__scrum4me__get_product_doc',
  'mcp__scrum4me__search_product_docs',
  'mcp__scrum4me__related_product_docs',
  'mcp__scrum4me__update_task_status',
  'mcp__scrum4me__update_task_plan',
  'mcp__scrum4me__log_implementation',
  'mcp__scrum4me__log_test_result',
  'mcp__scrum4me__log_commit',
  'mcp__scrum4me__verify_task_against_plan',
  'mcp__scrum4me__update_job_status',
  'mcp__scrum4me__ask_user_question',
  'mcp__scrum4me__get_question_answer',
  'mcp__scrum4me__list_open_questions',
  'mcp__scrum4me__cancel_question',
  'mcp__scrum4me__worker_heartbeat',
]

const KIND_DEFAULTS: Record<string, JobConfig> = {
  // Idea-kinds en PLAN_CHAT draaien in `acceptEdits` (niet `plan`):
  // `plan`-mode wacht op human-approval na elke planning-fase, wat in een
  // autonome runner-context betekent dat Claude geen `update_job_status`
  // aanroept en de job na lease-expiry FAILED'd. De `allowed_tools`-lijst
  // doet de echte sandboxing (geen Bash, geen Edit, alleen Read/Grep/etc).
  IDEA_GRILL: {
    model: 'claude-sonnet-4-6',
    thinking_budget: 12000,
    permission_mode: 'acceptEdits',
    max_turns: 15,
    allowed_tools: [
      'Read', 'Grep', 'Glob', 'WebSearch', 'AskUserQuestion',
      'mcp__scrum4me__get_agent_guide',
      'mcp__scrum4me__list_product_docs',
      'mcp__scrum4me__get_product_doc',
      'mcp__scrum4me__search_product_docs',
      'mcp__scrum4me__related_product_docs',
      'mcp__scrum4me__update_idea_grill_md',
      'mcp__scrum4me__log_idea_decision',
      'mcp__scrum4me__update_job_status',
      'mcp__scrum4me__ask_user_question',
      'mcp__scrum4me__get_question_answer',
      'mcp__scrum4me__cancel_question',
      'mcp__scrum4me__list_open_questions',
    ],
  },
  IDEA_MAKE_PLAN: {
    model: 'claude-opus-4-7',
    thinking_budget: 24000,
    permission_mode: 'acceptEdits',
    max_turns: 20,
    allowed_tools: [
      'Read', 'Grep', 'Glob', 'WebSearch', 'AskUserQuestion', 'Write',
      'mcp__scrum4me__get_agent_guide',
      'mcp__scrum4me__list_product_docs',
      'mcp__scrum4me__get_product_doc',
      'mcp__scrum4me__search_product_docs',
      'mcp__scrum4me__related_product_docs',
      'mcp__scrum4me__update_idea_plan_md',
      'mcp__scrum4me__log_idea_decision',
      'mcp__scrum4me__update_job_status',
    ],
  },
  IDEA_REVIEW_PLAN: {
    model: 'claude-opus-4-7',
    thinking_budget: 6000,
    permission_mode: 'acceptEdits',
    max_turns: 1,
    allowed_tools: [
      'Read', 'Write', 'Grep', 'Glob',
      'mcp__scrum4me__get_agent_guide',
      'mcp__scrum4me__list_product_docs',
      'mcp__scrum4me__get_product_doc',
      'mcp__scrum4me__search_product_docs',
      'mcp__scrum4me__related_product_docs',
      'mcp__scrum4me__update_idea_plan_md',
      'mcp__scrum4me__update_idea_plan_reviewed',
      'mcp__scrum4me__log_idea_decision',
      'mcp__scrum4me__update_job_status',
      'mcp__scrum4me__ask_user_question',
      'mcp__scrum4me__get_question_answer',
      'mcp__scrum4me__cancel_question',
      'mcp__scrum4me__list_open_questions',
    ],
  },
  PLAN_CHAT: {
    model: 'claude-sonnet-4-6',
    thinking_budget: 6000,
    permission_mode: 'acceptEdits',
    max_turns: 5,
    allowed_tools: [
      'Read', 'Grep', 'AskUserQuestion',
      'mcp__scrum4me__get_agent_guide',
      'mcp__scrum4me__list_product_docs',
      'mcp__scrum4me__get_product_doc',
      'mcp__scrum4me__search_product_docs',
      'mcp__scrum4me__related_product_docs',
      'mcp__scrum4me__update_job_status',
    ],
  },
  TASK_IMPLEMENTATION: {
    model: 'claude-sonnet-4-6',
    thinking_budget: 6000,
    permission_mode: 'bypassPermissions',
    max_turns: 50,
    allowed_tools: TASK_TOOLS,
  },
  SPRINT_IMPLEMENTATION: {
    model: 'claude-sonnet-4-6',
    thinking_budget: 6000,
    permission_mode: 'bypassPermissions',
    max_turns: null,
    // Geen `mcp__scrum4me__job_heartbeat` — de runner verlengt de lease
    // automatisch via setInterval (zie scrum4me-docker/bin/run-one-job.ts).
    allowed_tools: [
      ...TASK_TOOLS,
      'Agent',
      'mcp__scrum4me__update_task_execution',
      'mcp__scrum4me__verify_sprint_task',
    ],
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

// Map numeriek thinking_budget naar de Claude CLI 2.1.x --effort flag.
// Returns null als de flag niet meegegeven moet worden (budget = 0).
//
// Mapping (sync met Scrum4Me/lib/job-config.ts):
//   0           → null         (geen --effort flag)
//   1..6000     → "medium"
//   6001..12000 → "high"
//   12001..24000→ "xhigh"
//   >24000      → "max"
export function mapBudgetToEffort(budget: number): string | null {
  if (budget <= 0) return null
  if (budget <= 6000) return 'medium'
  if (budget <= 12000) return 'high'
  if (budget <= 24000) return 'xhigh'
  return 'max'
}

// Snapshot-velden voor ClaudeJob.requested_*. Bij elke enqueue laden we
// product (voor preferred_*) en optioneel task (voor requires_opus), draaien
// de resolver, en schrijven het resultaat als auditspoor in de job-rij.
// (Synced met vendor/scrum4me-shared/lib/job-config.ts)
export type ClaudeJobSnapshotFields = {
  requested_model: string
  requested_thinking_budget: number
  requested_permission_mode: string
}

export function snapshotFromConfig(cfg: JobConfig): ClaudeJobSnapshotFields {
  return {
    requested_model: cfg.model,
    requested_thinking_budget: cfg.thinking_budget,
    requested_permission_mode: cfg.permission_mode,
  }
}
