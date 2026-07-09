import { describe, expect, it } from 'vitest'

import { buildCodexArgs } from '../../src/lib/codex-args.js'
import { parseCodexJsonlUsage } from '../../src/lib/job-usage/codex-jsonl.js'
import { resolveCodexPricingModel } from '../../src/lib/job-usage/pricing.js'

describe('parseCodexJsonlUsage', () => {
  it('maps the official turn.completed usage sample to billable input/cache/output tokens', () => {
    const raw =
      '{"type":"thread.started","thread_id":"t1"}\n' +
      '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}\n'

    expect(parseCodexJsonlUsage(raw, { pricingDefaultModelId: 'gpt-5.4' })).toEqual({
      runtime: 'CODEX',
      modelId: null,
      pricingModelId: 'gpt-5.4',
      pricingModelSource: 'pricing_default',
      inputTokens: 315,
      outputTokens: 122,
      cacheReadTokens: 24448,
      cacheWriteTokens: 0,
      reasoningOutputTokens: 0,
      captureSource: 'codex_exec_jsonl',
      captureStatus: 'captured',
    })
  })

  it('maps the empirical runner sample and keeps reasoning tokens diagnostic-only', () => {
    const raw =
      '{"type":"turn.completed","usage":{"input_tokens":83599,"cached_input_tokens":52608,"output_tokens":1476,"reasoning_output_tokens":175}}\n'

    expect(parseCodexJsonlUsage(raw, { cliModelId: 'gpt-5.5-codex' })).toEqual({
      runtime: 'CODEX',
      modelId: 'gpt-5.5-codex',
      pricingModelId: 'gpt-5.5-codex',
      pricingModelSource: 'cli_model',
      inputTokens: 30991,
      outputTokens: 1476,
      cacheReadTokens: 52608,
      cacheWriteTokens: 0,
      reasoningOutputTokens: 175,
      captureSource: 'codex_exec_jsonl',
      captureStatus: 'captured',
    })
  })

  it('sums multiple turn.completed events defensively', () => {
    const raw = [
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"reasoning_output_tokens":1}}',
      '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":20,"output_tokens":7,"reasoning_output_tokens":2}}',
    ].join('\n')

    const result = parseCodexJsonlUsage(raw, { pricingDefaultModelId: 'gpt-5.4-mini' })

    expect(result.inputTokens).toBe(90)
    expect(result.cacheReadTokens).toBe(60)
    expect(result.outputTokens).toBe(17)
    expect(result.reasoningOutputTokens).toBe(3)
  })

  it('uses an observed model on a future event shape before CLI/default pricing sources', () => {
    const raw =
      '{"type":"turn.completed","model":"gpt-5.6-codex","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}'

    expect(
      parseCodexJsonlUsage(raw, {
        cliModelId: 'gpt-5.5-codex',
        pricingDefaultModelId: 'gpt-5.4',
      }),
    ).toMatchObject({
      modelId: 'gpt-5.6-codex',
      pricingModelId: 'gpt-5.6-codex',
      pricingModelSource: 'observed_event',
      captureStatus: 'captured',
    })
  })

  it('returns parse_error when stdout contains malformed JSON and no usable events', () => {
    expect(parseCodexJsonlUsage('{"type":"turn.completed","usage":')).toMatchObject({
      captureStatus: 'parse_error',
      inputTokens: 0,
      outputTokens: 0,
    })
  })

  it('returns no_usage_events for valid JSONL without turn usage', () => {
    expect(parseCodexJsonlUsage('{"type":"turn.started"}\n')).toMatchObject({
      captureStatus: 'no_usage_events',
      inputTokens: 0,
      outputTokens: 0,
    })
  })

  it('returns missing_model when usage exists without observed, CLI, or pricing-default model', () => {
    expect(
      parseCodexJsonlUsage(
        '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}',
        { pricingDefaultModelId: null },
      ),
    ).toMatchObject({
      modelId: null,
      pricingModelId: null,
      pricingModelSource: null,
      inputTokens: 6,
      cacheReadTokens: 4,
      outputTokens: 2,
      captureStatus: 'missing_model',
    })
  })
})

describe('resolveCodexPricingModel', () => {
  it('keeps a pricing-only default out of the runtime model id', () => {
    expect(
      resolveCodexPricingModel({
        observedModelId: null,
        cliModelId: null,
        pricingDefaultModelId: 'gpt-5.4',
      }),
    ).toEqual({
      modelId: null,
      pricingModelId: 'gpt-5.4',
      pricingModelSource: 'pricing_default',
    })
  })

  it('does not let CODEX_PRICING_MODEL_ID affect codex exec --model arguments', () => {
    const previous = process.env.CODEX_PRICING_MODEL_ID
    process.env.CODEX_PRICING_MODEL_ID = 'gpt-5.4'
    try {
      expect(buildCodexArgs({ promptText: 'p', cwd: '/work' })).not.toContain('--model')
    } finally {
      if (previous === undefined) {
        delete process.env.CODEX_PRICING_MODEL_ID
      } else {
        process.env.CODEX_PRICING_MODEL_ID = previous
      }
    }
  })
})
