import { readFile } from 'node:fs/promises'
import { prisma } from '../../prisma.js'
import {
  CLAUDE_UPDATE_TOOL_NAME,
  computeUsageFromTranscript,
  parseTranscript,
  sumSubagentUsage,
} from './claude-transcript.js'
import type {
  HookInput,
  JobUsageSnapshot,
  PersistJobUsageResult,
  PersistUsageSnapshotResult,
  UsageOwnerGuard,
} from './types.js'

export type PersistJobUsageSnapshotOptions = {
  ownerGuard?: UsageOwnerGuard
  captureError?: string | null
}

function defaultCaptureError(snapshot: JobUsageSnapshot): string | null {
  switch (snapshot.captureStatus) {
    case 'captured':
      return null
    case 'no_usage_events':
      return `${snapshot.captureSource}_no_usage_events`
    case 'parse_error':
      return `${snapshot.captureSource}_parse_error`
    case 'missing_model':
      return `${snapshot.captureSource}_missing_model`
  }
}

function usageSnapshotData(
  snapshot: JobUsageSnapshot,
  captureError: string | null | undefined,
) {
  return {
    ...(snapshot.modelId !== null ? { model_id: snapshot.modelId } : {}),
    ...(snapshot.pricingModelId !== null ? { pricing_model_id: snapshot.pricingModelId } : {}),
    ...(snapshot.pricingModelSource !== null
      ? { pricing_model_source: snapshot.pricingModelSource }
      : {}),
    input_tokens: snapshot.inputTokens,
    output_tokens: snapshot.outputTokens,
    cache_read_tokens: snapshot.cacheReadTokens,
    cache_write_tokens: snapshot.cacheWriteTokens,
    reasoning_output_tokens: snapshot.reasoningOutputTokens,
    usage_capture_source: snapshot.captureSource,
    usage_capture_status: snapshot.captureStatus,
    usage_capture_error: captureError === undefined ? defaultCaptureError(snapshot) : captureError,
  }
}

function hasCompleteOwnerGuard(ownerGuard: UsageOwnerGuard): ownerGuard is Required<UsageOwnerGuard> {
  return Boolean(ownerGuard.claimedByTokenId && ownerGuard.workerInstanceId)
}

export async function persistJobUsageSnapshot(
  jobId: string,
  snapshot: JobUsageSnapshot,
  options: PersistJobUsageSnapshotOptions = {},
): Promise<PersistUsageSnapshotResult> {
  if (!jobId) return 'skipped'
  const data = usageSnapshotData(snapshot, options.captureError)

  if (options.ownerGuard) {
    if (!hasCompleteOwnerGuard(options.ownerGuard)) return 'skipped'
    const result = await prisma.claudeJob.updateMany({
      where: {
        id: jobId,
        claimed_by_token_id: options.ownerGuard.claimedByTokenId,
        worker_instance_id: options.ownerGuard.workerInstanceId,
        status: { not: 'QUEUED' },
      },
      data,
    })
    return result.count > 0 ? 'written' : 'guard_mismatch'
  }

  await prisma.claudeJob.update({
    where: { id: jobId },
    data,
  })
  return 'written'
}

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

  await persistJobUsageSnapshot(jobId, {
    runtime: 'CLAUDE',
    modelId: usage.model_id,
    pricingModelId: usage.model_id,
    pricingModelSource: usage.model_id ? 'observed_event' : null,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_tokens,
    cacheWriteTokens: usage.cache_write_tokens,
    reasoningOutputTokens: null,
    captureSource: 'claude_post_tool_use',
    captureStatus: 'captured',
  })
  return 'written'
}
