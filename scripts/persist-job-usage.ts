// PostToolUse hook for mcp__scrum4me__update_job_status.
//
// Reads the local Claude Code transcript (no Anthropic API needed) and writes
// per-job token usage + model_id to claude_jobs. The hook receives a JSON
// payload on stdin with { session_id, transcript_path, tool_name, tool_input }.
//
// Window detection: the most-recent assistant message before EOF that issued a
// `mcp__scrum4me__wait_for_job` tool_use marks the job's start. All assistant
// messages after that index, up to and including the one that just called
// update_job_status, are summed.
//
// Idempotent — running twice for the same job overwrites with the same values.
// Designed to never block the agent: any failure logs a warning and exits 0.

import { readFile } from 'node:fs/promises'
import { prisma } from '../src/prisma.js'

export type HookInput = {
  session_id?: string
  transcript_path?: string
  tool_name?: string
  tool_input?: { job_id?: string; status?: string }
}

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

type ContentBlock = { type?: string; name?: string }

type TranscriptLine = {
  type?: string
  uuid?: string
  isSidechain?: boolean
  message?: {
    role?: string
    model?: string
    content?: ContentBlock[]
    usage?: Usage
  }
}

export type ComputedUsage = {
  model_id: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
}

const WAIT_TOOL_NAME = 'mcp__scrum4me__wait_for_job'
const UPDATE_TOOL_NAME = 'mcp__scrum4me__update_job_status'

export function parseTranscript(raw: string): TranscriptLine[] {
  const lines = raw.split('\n')
  const out: TranscriptLine[] = []
  const seenUuids = new Set<string>()
  for (const line of lines) {
    if (!line) continue
    let parsed: TranscriptLine
    try {
      parsed = JSON.parse(line) as TranscriptLine
    } catch {
      continue // skip malformed lines — transcript may be partially written
    }
    // Dedup on uuid: branching/resumption can re-write the same message into
    // multiple JSONLs. Keep first occurrence.
    if (parsed.uuid) {
      if (seenUuids.has(parsed.uuid)) continue
      seenUuids.add(parsed.uuid)
    }
    out.push(parsed)
  }
  return out
}

function hasToolUse(line: TranscriptLine, toolName: string): boolean {
  const content = line.message?.content
  if (!Array.isArray(content)) return false
  return content.some((c) => c.type === 'tool_use' && c.name === toolName)
}

export function computeUsageFromTranscript(lines: TranscriptLine[]): ComputedUsage {
  // Skip subagent (sidechain) lines: token usage attributed to subagent work
  // is reported in the main transcript via assistant messages of the parent
  // agent. Counting sidechain lines as well risks double-attribution because
  // those same units of work also appear in `subagents/`-subdirectory files.
  const main = lines.filter((l) => !l.isSidechain)

  // Find the last main-agent assistant message that called wait_for_job.
  let startIdx = -1
  for (let i = main.length - 1; i >= 0; i--) {
    if (hasToolUse(main[i], WAIT_TOOL_NAME)) {
      startIdx = i
      break
    }
  }

  // Window = (startIdx, end]. If no wait_for_job found, sum the whole session.
  const from = startIdx + 1
  const window = main.slice(from)

  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let model: string | null = null
  const modelsSeen = new Set<string>()

  for (const line of window) {
    if (line.type !== 'assistant') continue
    const msg = line.message
    if (!msg || msg.role !== 'assistant') continue
    const u = msg.usage
    if (u) {
      input += u.input_tokens ?? 0
      output += u.output_tokens ?? 0
      cacheRead += u.cache_read_input_tokens ?? 0
      cacheWrite += u.cache_creation_input_tokens ?? 0
    }
    if (msg.model) {
      modelsSeen.add(msg.model)
      model = msg.model // keep last
    }
  }

  if (modelsSeen.size > 1) {
    console.warn(
      `[persist-job-usage] multiple models in window: ${[...modelsSeen].join(', ')} — using last (${model})`,
    )
  }

  return {
    model_id: model ? normalizeModelId(model) : null,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  }
}

// Strip wrapping brackets so [1m]-suffix maps cleanly to a model_prices row.
// Example: 'claude-opus-4-7[1m]' → 'claude-opus-4-7-1m'.
export function normalizeModelId(raw: string): string {
  return raw.replace(/\[(.*?)\]/g, '-$1')
}

export async function readHookInput(): Promise<HookInput> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as HookInput
  } catch {
    return {}
  }
}

export async function persistJobUsage(input: HookInput): Promise<'skipped' | 'written' | 'noop'> {
  if (input.tool_name !== UPDATE_TOOL_NAME) return 'skipped'
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

async function main(): Promise<void> {
  try {
    const input = await readHookInput()
    const result = await persistJobUsage(input)
    if (result === 'written') {
      console.log(`[persist-job-usage] persisted usage for job=${input.tool_input?.job_id}`)
    }
  } catch (err) {
    console.warn('[persist-job-usage] error:', err)
  } finally {
    // Ensure clean exit even if Prisma keeps a connection pool alive.
    process.exit(0)
  }
}

const isDirect =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('persist-job-usage.ts')
if (isDirect) {
  void main()
}
