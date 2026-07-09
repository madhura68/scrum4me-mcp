import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ComputedUsage, TranscriptLine, UsageTotals } from './types.js'

export const CLAUDE_WAIT_TOOL_NAME = 'mcp__scrum4me__wait_for_job'
export const CLAUDE_UPDATE_TOOL_NAME = 'mcp__scrum4me__update_job_status'

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
    if (hasToolUse(main[i], CLAUDE_WAIT_TOOL_NAME)) {
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
// Example: 'claude-opus-4-7[1m]' -> 'claude-opus-4-7-1m'.
export function normalizeModelId(raw: string): string {
  return raw.replace(/\[(.*?)\]/g, '-$1')
}

// Sum assistant-message usage across this session's sub-agent transcripts.
// Layout (verified): <dir>/<session-id>/subagents/agent-*.jsonl, where <session-id>
// is the main transcript filename without .jsonl. The per-session subdir scopes this
// to ONE job. Sub-agent lines are sidechain=true and live ONLY in these files (not
// inlined in the main transcript), so summing them adds no double-count with
// computeUsageFromTranscript, which skips isSidechain lines in the main transcript.
export async function sumSubagentUsage(mainTranscriptPath: string): Promise<UsageTotals> {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const sessionId = basename(mainTranscriptPath, '.jsonl')
  const subDir = join(dirname(mainTranscriptPath), sessionId, 'subagents')
  let files: string[]
  try {
    files = (await readdir(subDir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return totals // no sub-agents for this session
  }
  for (const f of files) {
    let raw: string
    try {
      raw = await readFile(join(subDir, f), 'utf8')
    } catch {
      continue
    }
    for (const line of parseTranscript(raw)) {
      if (line.type !== 'assistant') continue
      const u = line.message?.usage
      if (!u) continue
      totals.input += u.input_tokens ?? 0
      totals.output += u.output_tokens ?? 0
      totals.cacheRead += u.cache_read_input_tokens ?? 0
      totals.cacheWrite += u.cache_creation_input_tokens ?? 0
    }
  }
  return totals
}
