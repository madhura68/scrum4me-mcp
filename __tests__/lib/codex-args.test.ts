import { describe, it, expect } from 'vitest'
import { buildCodexArgs } from '../../src/lib/codex-args.js'

describe('buildCodexArgs', () => {
  it('builds a non-interactive JSONL codex exec invocation with the prompt last', () => {
    const args = buildCodexArgs({ promptText: 'hello world', cwd: '/opt/agent' })
    expect(args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color',
      'never',
      '--cd',
      '/opt/agent',
      'hello world',
    ])
  })

  it('passes the cwd through and keeps the prompt as the final positional arg', () => {
    const args = buildCodexArgs({ promptText: 'PROMPT', cwd: '/home/agent/wt/x' })
    expect(args[args.length - 1]).toBe('PROMPT')
    expect(args).toContain('--cd')
    expect(args[args.indexOf('--cd') + 1]).toBe('/home/agent/wt/x')
  })

  it('does not include any Claude-CLI flags', () => {
    const args = buildCodexArgs({ promptText: 'p', cwd: '/opt/agent' })
    for (const claudeFlag of ['--mcp-config', '--permission-mode', '--allowedTools', '--model', '-p']) {
      expect(args).not.toContain(claudeFlag)
    }
  })
})
