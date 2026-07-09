import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))

import { prisma } from '../../src/prisma.js'
import { persistJobUsageSnapshot } from '../../src/lib/job-usage/persist.js'
import type { JobUsageSnapshot } from '../../src/lib/job-usage/types.js'

const mockClaudeJob = (
  prisma as unknown as {
    claudeJob: {
      update: ReturnType<typeof vi.fn>
      updateMany: ReturnType<typeof vi.fn>
    }
  }
).claudeJob

beforeEach(() => {
  mockClaudeJob.update.mockReset()
  mockClaudeJob.updateMany.mockReset()
})

function codexSnapshot(overrides: Partial<JobUsageSnapshot> = {}): JobUsageSnapshot {
  return {
    runtime: 'CODEX',
    modelId: null,
    pricingModelId: 'gpt-5.4',
    pricingModelSource: 'pricing_default',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    reasoningOutputTokens: 5,
    captureSource: 'codex_exec_jsonl',
    captureStatus: 'captured',
    ...overrides,
  }
}

describe('persistJobUsageSnapshot', () => {
  it('writes guarded Codex usage with claim-owner and worker-instance guard', async () => {
    mockClaudeJob.updateMany.mockResolvedValue({ count: 1 })

    const result = await persistJobUsageSnapshot('job-1', codexSnapshot(), {
      ownerGuard: {
        claimedByTokenId: 'token-1',
        workerInstanceId: 'worker-1',
      },
    })

    expect(result).toBe('written')
    expect(mockClaudeJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        claimed_by_token_id: 'token-1',
        worker_instance_id: 'worker-1',
        status: { not: 'QUEUED' },
      },
      data: {
        pricing_model_id: 'gpt-5.4',
        pricing_model_source: 'pricing_default',
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 30,
        cache_write_tokens: 0,
        reasoning_output_tokens: 5,
        usage_capture_source: 'codex_exec_jsonl',
        usage_capture_status: 'captured',
        usage_capture_error: null,
      },
    })
    expect(mockClaudeJob.update).not.toHaveBeenCalled()
  })

  it('skips guarded writes when owner identity is incomplete', async () => {
    const result = await persistJobUsageSnapshot('job-1', codexSnapshot(), {
      ownerGuard: {
        claimedByTokenId: 'token-1',
        workerInstanceId: null,
      },
    })

    expect(result).toBe('skipped')
    expect(mockClaudeJob.updateMany).not.toHaveBeenCalled()
    expect(mockClaudeJob.update).not.toHaveBeenCalled()
  })

  it('reports guard_mismatch when the owner guard does not update a row', async () => {
    mockClaudeJob.updateMany.mockResolvedValue({ count: 0 })

    const result = await persistJobUsageSnapshot('job-1', codexSnapshot(), {
      ownerGuard: {
        claimedByTokenId: 'token-1',
        workerInstanceId: 'worker-1',
      },
    })

    expect(result).toBe('guard_mismatch')
    expect(mockClaudeJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: 'QUEUED' } }),
      }),
    )
  })

  it.each([
    ['no_usage_events', 'codex_exec_jsonl_no_usage_events'],
    ['parse_error', 'codex_exec_jsonl_parse_error'],
    ['missing_model', 'codex_exec_jsonl_missing_model'],
  ] as const)('persists diagnostic status %s with an error marker', async (captureStatus, error) => {
    mockClaudeJob.update.mockResolvedValue({})

    const result = await persistJobUsageSnapshot(
      'job-2',
      codexSnapshot({
        pricingModelId: null,
        pricingModelSource: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        reasoningOutputTokens: null,
        captureStatus,
      }),
    )

    expect(result).toBe('written')
    expect(mockClaudeJob.update).toHaveBeenCalledWith({
      where: { id: 'job-2' },
      data: expect.objectContaining({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_output_tokens: null,
        usage_capture_status: captureStatus,
        usage_capture_error: error,
      }),
    })
  })
})
