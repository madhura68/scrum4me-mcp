// PostToolUse hook for mcp__scrum4me__update_job_status.
//
// Reads the local Claude Code transcript (no Anthropic API needed) and writes
// per-job token usage + model_id to claude_jobs. The hook receives a JSON
// payload on stdin with { session_id, transcript_path, tool_name, tool_input }.
//
// Window detection and parsing live in src/lib/job-usage so worker runtimes can
// share the same usage vocabulary.
//
// Idempotent — running twice for the same job overwrites with the same values.
// Designed to never block the agent: any failure logs a warning and exits 0.

import { persistJobUsage } from '../src/lib/job-usage/persist.js'
import type { HookInput } from '../src/lib/job-usage/types.js'

export {
  computeUsageFromTranscript,
  normalizeModelId,
  parseTranscript,
  sumSubagentUsage,
} from '../src/lib/job-usage/claude-transcript.js'
export { persistJobUsage }
export type { ComputedUsage, HookInput, UsageTotals } from '../src/lib/job-usage/types.js'

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
