import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/prisma.js', () => ({ prisma: { reviewLog: { upsert: vi.fn() } } }))

import { prisma } from '../../src/prisma.js'
import { upsertReviewLog } from '../../src/lib/upsert-review-log.js'

const mockUpsert = (prisma as unknown as { reviewLog: { upsert: ReturnType<typeof vi.fn> } }).reviewLog.upsert

beforeEach(() => vi.clearAllMocks())

describe('upsertReviewLog', () => {
  it('upsert op review_job_id; create en update bevatten dezelfde row incl. null-pins', async () => {
    await upsertReviewLog({
      review_job_id: 'job-1', kind: 'SPEC_REVIEW', product_id: 'p-1',
      verdict: 'APPROVED', findings: [{ severity: 'info', message: 'ok' }], summary: 's',
    })
    expect(mockUpsert).toHaveBeenCalledTimes(1)
    const arg = mockUpsert.mock.calls[0][0]
    expect(arg.where).toEqual({ review_job_id: 'job-1' })
    expect(arg.create.review_job_id).toBe('job-1')
    expect(arg.create.kind).toBe('SPEC_REVIEW')
    expect(arg.create.idea_id).toBeNull()
    expect(arg.create.pr_commit_id).toBeNull()
    expect(arg.update.idea_id).toBeNull()
  })

  it('pins (idea_id, pr_commit_id) komen door', async () => {
    await upsertReviewLog({
      review_job_id: 'j2', kind: 'IDEA_REVIEW_PLAN', product_id: 'p',
      verdict: 'CHANGES_REQUESTED', findings: [], summary: 's', pins: { idea_id: 'idea-9' },
    })
    const arg = mockUpsert.mock.calls[0][0]
    expect(arg.create.idea_id).toBe('idea-9')
    expect(arg.create.pr_commit_id).toBeNull()
  })
})
