import { describe, expect, it } from 'vitest'

import {
  formatWorkerUsageCaptureSummary,
  summarizeWorkerUsageCapture,
  type WorkerUsageCaptureCanaryRow,
} from '../../src/lib/job-usage/canary.js'

function row(overrides: Partial<WorkerUsageCaptureCanaryRow> = {}): WorkerUsageCaptureCanaryRow {
  return {
    id: 'job-1',
    status: 'DONE',
    runtime: 'CODEX',
    model_id: null,
    pricing_model_id: 'gpt-5.4',
    input_tokens: 100,
    output_tokens: 10,
    cache_read_tokens: 20,
    cache_write_tokens: 0,
    usage_capture_status: 'captured',
    usage_capture_error: null,
    ...overrides,
  }
}

describe('summarizeWorkerUsageCapture', () => {
  it('passes when recent successful Codex jobs are captured and priced', () => {
    const summary = summarizeWorkerUsageCapture([
      row({ id: 'ok-1' }),
      row({ id: 'failed-no-usage', status: 'FAILED', input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, usage_capture_status: null }),
    ])

    expect(summary.ok).toBe(true)
    expect(summary.total).toBe(2)
    expect(summary.captureStatusCounts).toMatchObject({
      captured: 1,
      missing_capture_status: 1,
    })
    expect(summary.failedWithoutUsageCount).toBe(1)
    expect(summary.issues).toEqual([])
  })

  it('reports successful Codex jobs without captured usage as data-quality issues', () => {
    const summary = summarizeWorkerUsageCapture([
      row({ id: 'missing-model', pricing_model_id: null, usage_capture_status: 'missing_model' }),
      row({ id: 'parse-error', usage_capture_status: 'parse_error' }),
      row({ id: 'no-tokens', input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null }),
    ])

    expect(summary.ok).toBe(false)
    expect(summary.captureStatusCounts).toMatchObject({
      missing_model: 1,
      parse_error: 1,
      captured: 1,
    })
    expect(summary.issues.map((issue) => issue.code)).toEqual([
      'successful_non_captured_status',
      'successful_missing_pricing_model',
      'successful_non_captured_status',
      'successful_missing_token_fields',
    ])
  })

  it('fails explicitly when the canary window has no Codex jobs', () => {
    const summary = summarizeWorkerUsageCapture([])

    expect(summary.ok).toBe(false)
    expect(summary.issues).toEqual([
      {
        code: 'no_recent_codex_jobs',
        jobId: null,
        detail: 'No recent Codex jobs were found for the canary window.',
      },
    ])
  })

  it('formats status buckets and informational failed jobs separately', () => {
    const text = formatWorkerUsageCaptureSummary(
      summarizeWorkerUsageCapture([
        row({ id: 'ok-1' }),
        row({ id: 'failed-no-usage', status: 'FAILED', input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, usage_capture_status: null }),
      ]),
    )

    expect(text).toContain('Worker usage capture canary: OK')
    expect(text).toContain('- DONE: 1')
    expect(text).toContain('- FAILED: 1')
    expect(text).toContain('- captured: 1')
    expect(text).toContain('- missing_capture_status: 1')
    expect(text).toContain('Failed jobs without usage (informational): 1')
  })
})
