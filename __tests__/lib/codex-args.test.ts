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
    for (const claudeFlag of ['--mcp-config', '--permission-mode', '--allowedTools', '-p']) {
      expect(args).not.toContain(claudeFlag)
    }
  })

  it('adds --model when model is set', () => {
    const args = buildCodexArgs({ promptText: 'p', cwd: '/opt/agent', model: 'gpt-5.1-codex' })
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.1-codex')
    expect(args[args.length - 1]).toBe('p')
  })

  it('adds --sandbox when sandboxMode is set', () => {
    const args = buildCodexArgs({ promptText: 'p', cwd: '/opt/agent', sandboxMode: 'read-only' })
    expect(args).toContain('--sandbox')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
    expect(args[args.length - 1]).toBe('p')
  })

  it('adds -c model_reasoning_effort=<effort> when thinkingBudget maps to an effort', () => {
    const args = buildCodexArgs({ promptText: 'p', cwd: '/opt/agent', thinkingBudget: 24000 })
    expect(args).toContain('-c')
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort=high')
    expect(args[args.length - 1]).toBe('p')
  })

  it('combines all overrides and keeps the prompt as the final positional arg', () => {
    const args = buildCodexArgs({
      promptText: 'DO IT',
      cwd: '/home/agent/wt/y',
      model: 'gpt-5.1-codex',
      sandboxMode: 'workspace-write',
      thinkingBudget: 9000,
    })
    expect(args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color',
      'never',
      '--cd',
      '/home/agent/wt/y',
      '--model',
      'gpt-5.1-codex',
      '--sandbox',
      'workspace-write',
      '-c',
      'model_reasoning_effort=medium',
      'DO IT',
    ])
  })

  it('omits override flags when the corresponding inputs are null/undefined', () => {
    const args = buildCodexArgs({
      promptText: 'p',
      cwd: '/opt/agent',
      model: null,
      sandboxMode: null,
      thinkingBudget: 0,
    })
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--sandbox')
    expect(args).not.toContain('-c')
    expect(args[args.length - 1]).toBe('p')
  })
})
