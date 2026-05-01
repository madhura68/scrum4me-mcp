import { describe, it, expect } from 'vitest'
import { resolveNextAction } from '../src/tools/update-job-status.js'

describe('resolveNextAction', () => {
  it('returns wait_for_job_again when queue has jobs after done', () => {
    expect(resolveNextAction(3, 'done')).toBe('wait_for_job_again')
  })

  it('returns queue_empty when queue is empty after done', () => {
    expect(resolveNextAction(0, 'done')).toBe('queue_empty')
  })

  it('returns wait_for_job_again when queue has jobs after failed', () => {
    expect(resolveNextAction(1, 'failed')).toBe('wait_for_job_again')
  })

  it('returns queue_empty when queue is empty after failed', () => {
    expect(resolveNextAction(0, 'failed')).toBe('queue_empty')
  })

  it('returns idle for running status regardless of queue count', () => {
    expect(resolveNextAction(5, 'running')).toBe('idle')
    expect(resolveNextAction(0, 'running')).toBe('idle')
  })
})
