import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/prisma.js', () => ({
  prisma: { claudeJob: { findUnique: vi.fn() }, reviewLog: { findUnique: vi.fn() } },
}))
vi.mock('../../src/auth.js', () => ({ getAuth: vi.fn() }))
vi.mock('../../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))

import { prisma } from '../../src/prisma.js'
import { getAuth } from '../../src/auth.js'
import { userCanAccessProduct } from '../../src/access.js'
import { handleGetReview } from '../../src/tools/get-review.js'
import { toolText } from '../helpers/tool-result.js'

const p = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
  reviewLog: { findUnique: ReturnType<typeof vi.fn> }
}
const mockAuth = getAuth as ReturnType<typeof vi.fn>
const mockAccess = userCanAccessProduct as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'u1', tokenId: 't', username: 'a', isDemo: false })
  mockAccess.mockResolvedValue(true)
})

describe('get_review', () => {
  it('reviewed: ReviewLog-rij aanwezig', async () => {
    p.claudeJob.findUnique.mockResolvedValue({ id: 'j1', kind: 'SPEC_REVIEW', status: 'DONE', product_id: 'p1', pr_url: null, summary: 'trace' })
    p.reviewLog.findUnique.mockResolvedValue({
      verdict: 'APPROVED', summary: 's', findings: [{ severity: 'info', message: 'ok' }], created_at: new Date(),
      doc_id: 'd1', doc_revision_id: 'r1', task_id: null, sprint_task_execution_id: null, idea_id: null, pr_commit_id: null,
    })
    const res = await handleGetReview({ job_id: 'j1' })
    const json = JSON.parse((res as any).content[0].text)
    expect(json.state).toBe('reviewed')
    expect(json.verdict).toBe('APPROVED')
    expect(json.target.doc_id).toBe('d1')
  })

  it('pending: geen rij + job RUNNING', async () => {
    p.claudeJob.findUnique.mockResolvedValue({ id: 'j1', kind: 'PR_REVIEW', status: 'RUNNING', product_id: 'p1', pr_url: 'x', summary: null })
    p.reviewLog.findUnique.mockResolvedValue(null)
    const res = await handleGetReview({ job_id: 'j1' })
    const json = JSON.parse((res as any).content[0].text)
    expect(json.state).toBe('pending')
    expect(json.verdict).toBeNull()
  })

  it('no_verdict: geen rij + job DONE (bv. PR COMMENT) → incl. job.summary', async () => {
    p.claudeJob.findUnique.mockResolvedValue({ id: 'j1', kind: 'PR_REVIEW', status: 'DONE', product_id: 'p1', pr_url: 'x', summary: 'PR review COMMENT: note' })
    p.reviewLog.findUnique.mockResolvedValue(null)
    const res = await handleGetReview({ job_id: 'j1' })
    const json = JSON.parse((res as any).content[0].text)
    expect(json.state).toBe('no_verdict')
    expect(json.summary).toBe('PR review COMMENT: note')
  })

  it('out-of-scope → 404-shape', async () => {
    p.claudeJob.findUnique.mockResolvedValue({ id: 'j1', kind: 'SPEC_REVIEW', status: 'DONE', product_id: 'p1', pr_url: null, summary: null })
    mockAccess.mockResolvedValue(false)
    const res = await handleGetReview({ job_id: 'j1' })
    expect(toolText(res)).toBe('Job j1 not found')
  })
})
