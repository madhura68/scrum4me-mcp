import { readFile } from 'node:fs/promises'
import { prisma } from '../../prisma.js'
import {
  CLAUDE_UPDATE_TOOL_NAME,
  computeUsageFromTranscript,
  parseTranscript,
  sumSubagentUsage,
} from './claude-transcript.js'
import type { HookInput, PersistJobUsageResult } from './types.js'

export async function persistJobUsage(input: HookInput): Promise<PersistJobUsageResult> {
  if (input.tool_name !== CLAUDE_UPDATE_TOOL_NAME) return 'skipped'
  const status = input.tool_input?.status
  if (status !== 'done' && status !== 'failed') return 'skipped'
  const jobId = input.tool_input?.job_id
  if (!jobId) return 'skipped'
  const transcriptPath = input.transcript_path
  if (!transcriptPath) return 'skipped'

  let raw: string
  try {
    raw = await readFile(transcriptPath, 'utf8')
  } catch (err) {
    console.warn(`[persist-job-usage] cannot read transcript ${transcriptPath}:`, err)
    return 'skipped'
  }

  const lines = parseTranscript(raw)
  const usage = computeUsageFromTranscript(lines)

  // Add this session's sub-agent token usage (separate transcript files).
  const sub = await sumSubagentUsage(transcriptPath)
  usage.input_tokens += sub.input
  usage.output_tokens += sub.output
  usage.cache_read_tokens += sub.cacheRead
  usage.cache_write_tokens += sub.cacheWrite

  // Skip pure no-op: no usage data and no model — nothing meaningful to persist.
  if (
    usage.model_id === null &&
    usage.input_tokens === 0 &&
    usage.output_tokens === 0 &&
    usage.cache_read_tokens === 0 &&
    usage.cache_write_tokens === 0
  ) {
    return 'noop'
  }

  await prisma.claudeJob.update({
    where: { id: jobId },
    data: {
      ...(usage.model_id !== null ? { model_id: usage.model_id } : {}),
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
    },
  })
  return 'written'
}
