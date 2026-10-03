import { describe, expect, it } from 'vitest'
import { dispatchUsageColumns } from '../../src/dispatch/usage.js'

const captured = {
  version: 1, runtime: 'CODEX', status: 'captured', model: null,
  input_tokens: 98311, output_tokens: 13835, cache_read_tokens: 1552680, cache_write_tokens: 0, reasoning_output_tokens: 5699,
}

describe('dispatchUsageColumns (T-1972)', () => {
  it('prices a run without an observed model on the configured model', () => {
    expect(dispatchUsageColumns(captured, 'gpt-6.1-sol')).toEqual({
      model_id: 'gpt-6.1-sol', pricing_model_id: 'gpt-6.1-sol', pricing_model_source: 'cli_model',
      input_tokens: 98311, output_tokens: 13835, cache_read_tokens: 1552680, cache_write_tokens: 0, reasoning_output_tokens: 5699,
      usage_capture_source: 'dispatch_transcript', usage_capture_status: 'captured', usage_capture_error: null,
    })
  })

  it('prefers the model the transcript observed', () => {
    expect(dispatchUsageColumns({ ...captured, runtime: 'CLAUDE', model: 'claude-opus-5-5', reasoning_output_tokens: null }, 'other-model'))
      .toMatchObject({ model_id: 'claude-opus-5-5', pricing_model_id: 'claude-opus-5-5', pricing_model_source: 'observed_event', reasoning_output_tokens: null })
  })

  it('records missing_model when neither the transcript nor the job names one', () => {
    expect(dispatchUsageColumns(captured, null)).toMatchObject({
      model_id: null, pricing_model_id: null, pricing_model_source: null, input_tokens: 98311,
      usage_capture_status: 'missing_model', usage_capture_error: 'dispatch_transcript_missing_model',
    })
  })

  it('keeps no counts for a run without usage events', () => {
    expect(dispatchUsageColumns({ ...captured, status: 'no_usage_events', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, reasoning_output_tokens: null }, 'gpt-6.1-sol'))
      .toEqual({
        model_id: null, pricing_model_id: null, pricing_model_source: null,
        input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_output_tokens: null,
        usage_capture_source: 'dispatch_transcript', usage_capture_status: 'no_usage_events', usage_capture_error: 'dispatch_transcript_no_usage_events',
      })
  })

  it.each([
    ['a negative count', { ...captured, input_tokens: -1 }],
    ['a count beyond int4', { ...captured, output_tokens: 3_000_000_000 }],
    ['a fractional count', { ...captured, output_tokens: 1.5 }],
    ['an unknown field', { ...captured, cost_usd: 1 }],
    ['a model with spaces', { ...captured, model: 'gpt 6' }],
    ['a string', 'captured'],
  ])('turns %s into parse_error without counts', (_label, raw) => {
    expect(dispatchUsageColumns(raw, 'gpt-6.1-sol')).toMatchObject({
      input_tokens: null, output_tokens: null, model_id: null,
      usage_capture_status: 'parse_error', usage_capture_error: 'dispatch_transcript_parse_error',
    })
  })
})
