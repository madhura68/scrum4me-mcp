import { getCodexPricingModelDefault, resolveCodexPricingModel } from './pricing.js'
import type { JobUsageSnapshot } from './types.js'

type CodexUsage = {
  input_tokens?: unknown
  cached_input_tokens?: unknown
  output_tokens?: unknown
  reasoning_output_tokens?: unknown
  model?: unknown
  model_id?: unknown
}

type CodexEvent = {
  type?: unknown
  model?: unknown
  model_id?: unknown
  usage?: CodexUsage
}

export type CodexJsonlUsageOptions = {
  cliModelId?: string | null
  pricingDefaultModelId?: string | null
}

function emptyCodexSnapshot(
  captureStatus: JobUsageSnapshot['captureStatus'],
): JobUsageSnapshot {
  return {
    runtime: 'CODEX',
    modelId: null,
    pricingModelId: null,
    pricingModelSource: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningOutputTokens: null,
    captureSource: 'codex_exec_jsonl',
    captureStatus,
  }
}

function nonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.trunc(value)
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function observedModelFromEvent(event: CodexEvent): string | null {
  return (
    stringValue(event.model) ??
    stringValue(event.model_id) ??
    stringValue(event.usage?.model) ??
    stringValue(event.usage?.model_id)
  )
}

export function parseCodexJsonlUsage(
  raw: string,
  options: CodexJsonlUsageOptions = {},
): JobUsageSnapshot {
  let usageEvents = 0
  let parseErrors = 0
  let billableInputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0
  let reasoningOutputTokens = 0
  let sawReasoningTokens = false
  let observedModelId: string | null = null

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let event: CodexEvent
    try {
      event = JSON.parse(trimmed) as CodexEvent
    } catch {
      parseErrors += 1
      continue
    }

    if (event.type !== 'turn.completed' || !event.usage) continue

    usageEvents += 1
    observedModelId = observedModelFromEvent(event) ?? observedModelId

    const totalInputTokens = nonNegativeNumber(event.usage.input_tokens)
    const cachedInputTokens = nonNegativeNumber(event.usage.cached_input_tokens)
    billableInputTokens += Math.max(0, totalInputTokens - cachedInputTokens)
    cacheReadTokens += cachedInputTokens
    outputTokens += nonNegativeNumber(event.usage.output_tokens)

    if (event.usage.reasoning_output_tokens !== undefined) {
      sawReasoningTokens = true
      reasoningOutputTokens += nonNegativeNumber(event.usage.reasoning_output_tokens)
    }
  }

  if (usageEvents === 0) {
    return emptyCodexSnapshot(parseErrors > 0 ? 'parse_error' : 'no_usage_events')
  }

  const resolved = resolveCodexPricingModel({
    observedModelId,
    cliModelId: options.cliModelId,
    pricingDefaultModelId:
      options.pricingDefaultModelId === undefined
        ? getCodexPricingModelDefault()
        : options.pricingDefaultModelId,
  })

  return {
    runtime: 'CODEX',
    modelId: resolved.modelId,
    pricingModelId: resolved.pricingModelId,
    pricingModelSource: resolved.pricingModelSource,
    inputTokens: billableInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    reasoningOutputTokens: sawReasoningTokens ? reasoningOutputTokens : null,
    captureSource: 'codex_exec_jsonl',
    captureStatus: resolved.pricingModelId ? 'captured' : 'missing_model',
  }
}
