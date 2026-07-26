import { describe, expect, it } from 'vitest'
import { isRealtimePayload } from '@shared/realtime-payload.js'

describe('MCP realtime payload contract', () => {
  it('accepts job status changed payload with runtime and source', () => {
    expect(isRealtimePayload({
      type: 'claude_job_status_changed',
      user_id: 'u1',
      product_id: 'p1',
      job_id: 'j1',
      kind: 'TASK_IMPLEMENTATION',
      status: 'RUNNING',
      runtime: 'CLAUDE',
      source: 'MANUAL',
    })).toBe(true)
  })

  it('accepts worker heartbeat payload with runtime', () => {
    expect(isRealtimePayload({
      type: 'claude_worker_heartbeat',
      worker_id: 'w1',
      user_id: 'u1',
      runtime: 'CLAUDE',
    })).toBe(true)
  })
})
