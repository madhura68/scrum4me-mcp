// M23: claim-filter + resolveReviewFeedback voor de spec-fase-kinds.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { m } = vi.hoisted(() => ({
  m: {
    claudeJob: { findUnique: vi.fn() },
    reviewLog: { findUnique: vi.fn() },
  },
}))
vi.mock('../src/prisma.js', () => ({ prisma: m }))

import { resolveReviewFeedback } from '../src/tools/wait-for-job.js'

beforeEach(() => {
  m.claudeJob.findUnique.mockReset()
  m.reviewLog.findUnique.mockReset()
})

describe('M23 claim-filter', () => {
  it('CLAIMABLE_STANDALONE_KINDS bevat de spec-maker-kinds (SQL-tuple)', async () => {
    const src = (await import('node:fs')).readFileSync('src/tools/wait-for-job.ts', 'utf8')
    const tuple = src.match(/CLAIMABLE_STANDALONE_KINDS = "\(([^)]+)\)"/)?.[1] ?? ''
    expect(tuple).toContain("'IDEA_MAKE_SPEC'")
    expect(tuple).toContain("'IDEA_REVISE_SPEC'")
  })
})

describe('M23 resolveReviewFeedback', () => {
  it('IDEA_REVISE_SPEC met SPEC_REVIEW-parent krijgt de vorige findings', async () => {
    m.claudeJob.findUnique.mockResolvedValue({ id: 'rev-1', kind: 'SPEC_REVIEW' })
    m.reviewLog.findUnique.mockResolvedValue({ verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'major', message: 'x' }], summary: 's' })
    const r = await resolveReviewFeedback({ kind: 'IDEA_REVISE_SPEC', created_by_job_id: 'rev-1', orchestration_key: 'idea:i1:spec-loop:r2' })
    expect(r).toEqual(expect.objectContaining({ verdict: 'CHANGES_REQUESTED', round: 2 }))
  })
  it('IDEA_MAKE_PLAN met SPEC_REVIEW-parent (approved-doorstroom) krijgt GEEN feedback', async () => {
    m.claudeJob.findUnique.mockResolvedValue({ id: 'rev-1', kind: 'SPEC_REVIEW' })
    const r = await resolveReviewFeedback({ kind: 'IDEA_MAKE_PLAN', created_by_job_id: 'rev-1', orchestration_key: 'idea:i1:plan-loop:r1' })
    expect(r).toBeUndefined()
  })
  it('IDEA_MAKE_PLAN met IDEA_REVIEW_PLAN-parent blijft werken (M20)', async () => {
    m.claudeJob.findUnique.mockResolvedValue({ id: 'rev-2', kind: 'IDEA_REVIEW_PLAN' })
    m.reviewLog.findUnique.mockResolvedValue({ verdict: 'CHANGES_REQUESTED', findings: [], summary: 's' })
    const r = await resolveReviewFeedback({ kind: 'IDEA_MAKE_PLAN', created_by_job_id: 'rev-2', orchestration_key: 'idea:i1:plan-loop:r2' })
    expect(r).toEqual(expect.objectContaining({ round: 2 }))
  })
})
