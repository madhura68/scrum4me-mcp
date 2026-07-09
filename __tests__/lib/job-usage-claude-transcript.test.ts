import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  computeUsageFromTranscript,
  normalizeModelId,
  parseTranscript,
  sumSubagentUsage,
} from '../../src/lib/job-usage/claude-transcript.js'

function assistantLine(opts: {
  model?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  toolUseName?: string
  isSidechain?: boolean
  uuid?: string
}) {
  const content: Array<{ type: string; name?: string }> = []
  if (opts.toolUseName) content.push({ type: 'tool_use', name: opts.toolUseName })
  return JSON.stringify({
    type: 'assistant',
    uuid: opts.uuid,
    isSidechain: opts.isSidechain ?? false,
    message: {
      role: 'assistant',
      model: opts.model ?? 'claude-sonnet-4-6',
      content,
      usage: opts.usage,
    },
  })
}

describe('job-usage Claude transcript parsing', () => {
  it('keeps the existing wait_for_job windowing and token mapping', () => {
    const lines = parseTranscript(
      [
        assistantLine({
          toolUseName: 'mcp__scrum4me__wait_for_job',
          usage: { input_tokens: 999, output_tokens: 999 },
        }),
        assistantLine({
          model: 'claude-opus-4-8[1m]',
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 40,
          },
        }),
        assistantLine({
          isSidechain: true,
          uuid: 'sidechain-1',
          usage: { input_tokens: 1000, output_tokens: 1000 },
        }),
        assistantLine({
          model: 'claude-opus-4-8[1m]',
          toolUseName: 'mcp__scrum4me__update_job_status',
        }),
      ].join('\n'),
    )

    expect(computeUsageFromTranscript(lines)).toEqual({
      model_id: 'claude-opus-4-8-1m',
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 40,
      cache_write_tokens: 30,
    })
  })

  it('deduplicates transcript lines by uuid and skips malformed lines', () => {
    const first = assistantLine({ uuid: 'u1', usage: { input_tokens: 1 } })
    const duplicate = assistantLine({ uuid: 'u1', usage: { input_tokens: 99 } })
    const second = assistantLine({ uuid: 'u2', usage: { input_tokens: 2 } })

    expect(parseTranscript([first, 'not-json', duplicate, second].join('\n'))).toHaveLength(2)
  })

  it('normalizes bracket suffixes for model price lookup', () => {
    expect(normalizeModelId('claude-opus-4-8[1m]')).toBe('claude-opus-4-8-1m')
  })

  it('sums subagent transcript usage for the same session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-module-subagents-'))
    const mainPath = join(dir, 'session-1.jsonl')
    writeFileSync(mainPath, '')
    const subDir = join(dir, 'session-1', 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, 'agent-1.jsonl'),
      [
        assistantLine({
          isSidechain: true,
          uuid: 'sub-1',
          usage: {
            input_tokens: 3,
            output_tokens: 4,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 6,
          },
        }),
      ].join('\n'),
    )

    await expect(sumSubagentUsage(mainPath)).resolves.toEqual({
      input: 3,
      output: 4,
      cacheRead: 6,
      cacheWrite: 5,
    })
    rmSync(dir, { recursive: true, force: true })
  })
})
