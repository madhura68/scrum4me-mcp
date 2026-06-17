// codex-args.ts — builder for a non-interactive `codex exec` invocation.
// MCP, sandbox-default and approval policy come from ~/.codex/config.toml
// (installed by the container entrypoint); this builder sets the per-run flags
// + the prompt. Per-kind overrides (model/sandbox/thinking_budget) komen uit de
// live-geresolveerde JobKindConfig (zie getFullJobContext) en worden hier als
// optionele inputs doorgegeven. allowed_tools wordt NIET doorgegeven: codex
// heeft geen tool-allowlist-poort (zie spec).
//
// Flag-syntax (geverifieerd tegen /openai/codex docs):
//   --model <m>                         standaard `codex exec`-flag
//   --sandbox <s>                       read-only|workspace-write|danger-full-access
//   -c model_reasoning_effort=<effort>  config-override; bare string parst als TOML-literal

import { mapBudgetToCodexEffort } from '@shared/codex-config.js'

export interface CodexArgsInput {
  /** The fully-substituted kind prompt (same text the Claude runner passes via -p). */
  promptText: string
  /** Working root for the agent (PLAN_CHAT canary: /opt/agent). */
  cwd: string
  /** Per-kind codex-model override (--model). null/undefined → CLI/config-default. */
  model?: string | null
  /** Per-kind sandbox-mode override (--sandbox). null/undefined → config.toml-default. */
  sandboxMode?: string | null
  /** Per-kind thinking_budget; intern via mapBudgetToCodexEffort → -c model_reasoning_effort=…. 0/undefined → weggelaten. */
  thinkingBudget?: number | null
}

/** Build argv for `codex exec`. JSONL output (for the output classifier),
 *  --skip-git-repo-check because the worker cwd is not always a git repo,
 *  --ephemeral so no session files accumulate, --color never for clean logs.
 *  Optionele per-run overrides (model/sandbox/reasoning-effort) worden alleen
 *  toegevoegd als ze gezet zijn. De prompt blijft het laatste positionele argument. */
export function buildCodexArgs(input: CodexArgsInput): string[] {
  const args: string[] = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color',
    'never',
    '--cd',
    input.cwd,
  ]

  if (input.model) {
    args.push('--model', input.model)
  }
  if (input.sandboxMode) {
    args.push('--sandbox', input.sandboxMode)
  }
  const effort = mapBudgetToCodexEffort(input.thinkingBudget ?? 0)
  if (effort) {
    args.push('-c', `model_reasoning_effort=${effort}`)
  }

  // De prompt is ALTIJD het laatste positionele argument.
  args.push(input.promptText)
  return args
}
