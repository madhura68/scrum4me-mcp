// codex-args.ts — pure builder for a non-interactive `codex exec` invocation.
// MCP, sandbox and approval policy come from ~/.codex/config.toml (installed by
// the container entrypoint); this builder only sets per-run flags + the prompt.

export interface CodexArgsInput {
  /** The fully-substituted kind prompt (same text the Claude runner passes via -p). */
  promptText: string
  /** Working root for the agent (PLAN_CHAT canary: /opt/agent). */
  cwd: string
}

/** Build argv for `codex exec`. JSONL output (for the output classifier),
 *  --skip-git-repo-check because the worker cwd is not always a git repo,
 *  --ephemeral so no session files accumulate, --color never for clean logs.
 *  The prompt is the final positional argument. */
export function buildCodexArgs(input: CodexArgsInput): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color',
    'never',
    '--cd',
    input.cwd,
    input.promptText,
  ]
}
