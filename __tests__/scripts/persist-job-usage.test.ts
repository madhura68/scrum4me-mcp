import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: { update: vi.fn() },
  },
}))

import { prisma } from '../../src/prisma.js'
import {
  parseTranscript,
  computeUsageFromTranscript,
  normalizeModelId,
  persistJobUsage,
} from '../../scripts/persist-job-usage.js'

const mockUpdate = (prisma as unknown as { claudeJob: { update: ReturnType<typeof vi.fn> } })
  .claudeJob.update

beforeEach(() => {
  mockUpdate.mockReset()
})

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

describe('normalizeModelId', () => {
  it('strips bracket suffix', () => {
    expect(normalizeModelId('claude-opus-4-7[1m]')).toBe('claude-opus-4-7-1m')
  })

  it('passes through plain ids', () => {
    expect(normalizeModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })
})

describe('parseTranscript', () => {
  it('skips malformed lines', () => {
    const raw = `${assistantLine({})}\nnot-json\n${assistantLine({})}\n`
    expect(parseTranscript(raw)).toHaveLength(2)
  })

  it('handles trailing newline + empty lines', () => {
    expect(parseTranscript('\n\n')).toEqual([])
  })

  it('dedups on uuid (branching/resumption)', () => {
    const a = assistantLine({ uuid: 'u1', usage: { input_tokens: 5, output_tokens: 5 } })
    const b = assistantLine({ uuid: 'u1', usage: { input_tokens: 99, output_tokens: 99 } })
    const c = assistantLine({ uuid: 'u2', usage: { input_tokens: 1, output_tokens: 1 } })
    const lines = parseTranscript([a, b, c].join('\n'))
    expect(lines).toHaveLength(2)
    expect(lines[0].uuid).toBe('u1')
    expect(lines[1].uuid).toBe('u2')
  })
})

describe('computeUsageFromTranscript', () => {
  it('sums assistant usage after wait_for_job marker', () => {
    const lines = parseTranscript(
      [
        assistantLine({
          toolUseName: 'mcp__scrum4me__wait_for_job',
          usage: { input_tokens: 999, output_tokens: 999 },
        }),
        assistantLine({
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 40,
          },
        }),
        assistantLine({
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
          },
        }),
        assistantLine({ toolUseName: 'mcp__scrum4me__update_job_status' }),
      ].join('\n'),
    )

    const usage = computeUsageFromTranscript(lines)
    expect(usage.input_tokens).toBe(11)
    expect(usage.output_tokens).toBe(22)
    expect(usage.cache_write_tokens).toBe(33)
    expect(usage.cache_read_tokens).toBe(44)
    expect(usage.model_id).toBe('claude-sonnet-4-6')
  })

  it('sums whole session when no wait_for_job marker', () => {
    const lines = parseTranscript(
      [
        assistantLine({ usage: { input_tokens: 5, output_tokens: 6 } }),
        assistantLine({ usage: { input_tokens: 7, output_tokens: 8 } }),
      ].join('\n'),
    )

    const usage = computeUsageFromTranscript(lines)
    expect(usage.input_tokens).toBe(12)
    expect(usage.output_tokens).toBe(14)
  })

  it('ignores non-assistant lines', () => {
    const userLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [] },
    })
    const lines = parseTranscript(
      [
        assistantLine({ toolUseName: 'mcp__scrum4me__wait_for_job' }),
        userLine,
        assistantLine({ usage: { input_tokens: 100, output_tokens: 200 } }),
      ].join('\n'),
    )

    const usage = computeUsageFromTranscript(lines)
    expect(usage.input_tokens).toBe(100)
    expect(usage.output_tokens).toBe(200)
  })

  it('returns last model_id and normalizes [1m]-suffix', () => {
    const lines = parseTranscript(
      [
        assistantLine({ model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } }),
        assistantLine({ model: 'claude-opus-4-7[1m]', usage: { input_tokens: 1, output_tokens: 1 } }),
      ].join('\n'),
    )
    const usage = computeUsageFromTranscript(lines)
    expect(usage.model_id).toBe('claude-opus-4-7-1m')
  })

  it('returns null model_id when transcript is empty', () => {
    expect(computeUsageFromTranscript([]).model_id).toBe(null)
  })

  it('skips sidechain (subagent) lines to avoid double-counting', () => {
    const lines = parseTranscript(
      [
        assistantLine({
          toolUseName: 'mcp__scrum4me__wait_for_job',
          uuid: 'main-1',
        }),
        assistantLine({
          isSidechain: true,
          uuid: 'sub-1',
          usage: { input_tokens: 9999, output_tokens: 9999 },
        }),
        assistantLine({
          uuid: 'main-2',
          usage: { input_tokens: 50, output_tokens: 60 },
        }),
      ].join('\n'),
    )

    const usage = computeUsageFromTranscript(lines)
    expect(usage.input_tokens).toBe(50)
    expect(usage.output_tokens).toBe(60)
  })
})

describe('persistJobUsage', () => {
  let tmpDir: string
  let transcriptPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'persist-job-usage-test-'))
    transcriptPath = join(tmpDir, 'session.jsonl')
  })

  function cleanup() {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  it('skips when tool_name is not update_job_status', async () => {
    const result = await persistJobUsage({
      tool_name: 'mcp__scrum4me__create_task',
      tool_input: { job_id: 'j1', status: 'done' },
      transcript_path: transcriptPath,
    })
    expect(result).toBe('skipped')
    expect(mockUpdate).not.toHaveBeenCalled()
    cleanup()
  })

  it('skips on status=running', async () => {
    const result = await persistJobUsage({
      tool_name: 'mcp__scrum4me__update_job_status',
      tool_input: { job_id: 'j1', status: 'running' },
      transcript_path: transcriptPath,
    })
    expect(result).toBe('skipped')
    expect(mockUpdate).not.toHaveBeenCalled()
    cleanup()
  })

  it('skips when transcript missing', async () => {
    const result = await persistJobUsage({
      tool_name: 'mcp__scrum4me__update_job_status',
      tool_input: { job_id: 'j1', status: 'done' },
      transcript_path: '/no/such/file.jsonl',
    })
    expect(result).toBe('skipped')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('writes computed usage on success', async () => {
    writeFileSync(
      transcriptPath,
      [
        assistantLine({ toolUseName: 'mcp__scrum4me__wait_for_job' }),
        assistantLine({
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 40,
          },
        }),
        assistantLine({ toolUseName: 'mcp__scrum4me__update_job_status' }),
      ].join('\n'),
    )

    mockUpdate.mockResolvedValue({})
    const result = await persistJobUsage({
      tool_name: 'mcp__scrum4me__update_job_status',
      tool_input: { job_id: 'job-123', status: 'done' },
      transcript_path: transcriptPath,
    })

    expect(result).toBe('written')
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'job-123' },
      data: {
        model_id: 'claude-sonnet-4-6',
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 40,
        cache_write_tokens: 30,
      },
    })
    cleanup()
  })

  it('returns noop when transcript has no usage', async () => {
    writeFileSync(transcriptPath, '')
    const result = await persistJobUsage({
      tool_name: 'mcp__scrum4me__update_job_status',
      tool_input: { job_id: 'job-123', status: 'failed' },
      transcript_path: transcriptPath,
    })
    expect(result).toBe('noop')
    expect(mockUpdate).not.toHaveBeenCalled()
    cleanup()
  })
})
