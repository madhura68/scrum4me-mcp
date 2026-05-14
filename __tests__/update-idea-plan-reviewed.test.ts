import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    idea: { update: vi.fn() },
    ideaLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}))

vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(),
  PermissionDeniedError: class PermissionDeniedError extends Error {
    constructor(message = 'Demo accounts cannot perform write operations') {
      super(message)
      this.name = 'PermissionDeniedError'
    }
  },
}))

vi.mock('../src/access.js', () => ({
  userOwnsIdea: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { userOwnsIdea } from '../src/access.js'
import { handleUpdateIdeaPlanReviewed } from '../src/tools/update-idea-plan-reviewed.js'

const mockPrisma = prisma as unknown as {
  idea: { update: ReturnType<typeof vi.fn> }
  ideaLog: { create: ReturnType<typeof vi.fn> }
  $transaction: ReturnType<typeof vi.fn>
}
const mockRequireWriteAccess = requireWriteAccess as ReturnType<typeof vi.fn>
const mockUserOwnsIdea = userOwnsIdea as ReturnType<typeof vi.fn>

const IDEA_ID = 'idea-1'
const USER_ID = 'user-1'
const REVIEW_LOG = {
  rounds: [{ score: 88 }],
  convergence: { stable_at_round: 2 },
  approval: { status: 'approved' },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireWriteAccess.mockResolvedValue({
    userId: USER_ID,
    tokenId: 'tok-1',
    username: 'alice',
    isDemo: false,
  })
  mockUserOwnsIdea.mockResolvedValue(true)
  // $transaction returns the array of its two operations' results; the handler
  // only reads result[0] (the idea.update result).
  mockPrisma.$transaction.mockImplementation(async () => [
    { id: IDEA_ID, status: 'PLACEHOLDER', code: 'IDEA-1' },
    {},
  ])
})

function parseResult(result: Awaited<ReturnType<typeof handleUpdateIdeaPlanReviewed>>) {
  const text = result.content?.[0]?.type === 'text' ? result.content[0].text : ''
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// The handler builds `data.status` inside the idea.update call passed to
// $transaction. We capture it by inspecting the prisma.idea.update mock args.
function statusPassedToUpdate(): string | undefined {
  const call = mockPrisma.idea.update.mock.calls[0]
  return call?.[0]?.data?.status
}

describe('handleUpdateIdeaPlanReviewed — status transition', () => {
  it('approval_status="approved" → PLAN_REVIEWED', async () => {
    await handleUpdateIdeaPlanReviewed({
      idea_id: IDEA_ID,
      review_log: REVIEW_LOG,
      approval_status: 'approved',
    })
    expect(statusPassedToUpdate()).toBe('PLAN_REVIEWED')
  })

  it('approval_status="rejected" → PLAN_REVIEW_FAILED', async () => {
    await handleUpdateIdeaPlanReviewed({
      idea_id: IDEA_ID,
      review_log: REVIEW_LOG,
      approval_status: 'rejected',
    })
    expect(statusPassedToUpdate()).toBe('PLAN_REVIEW_FAILED')
  })

  it('approval_status="pending" → PLAN_REVIEW_FAILED (needs manual approval, never silently approved)', async () => {
    await handleUpdateIdeaPlanReviewed({
      idea_id: IDEA_ID,
      review_log: REVIEW_LOG,
      approval_status: 'pending',
    })
    expect(statusPassedToUpdate()).toBe('PLAN_REVIEW_FAILED')
  })

  it('omitted approval_status → PLAN_REVIEW_FAILED (safe default, not PLAN_REVIEWED)', async () => {
    await handleUpdateIdeaPlanReviewed({
      idea_id: IDEA_ID,
      review_log: REVIEW_LOG,
    })
    expect(statusPassedToUpdate()).toBe('PLAN_REVIEW_FAILED')
  })

  it('returns "Idea not found" when the user does not own the idea', async () => {
    mockUserOwnsIdea.mockResolvedValue(false)
    const result = await handleUpdateIdeaPlanReviewed({
      idea_id: IDEA_ID,
      review_log: REVIEW_LOG,
      approval_status: 'approved',
    })
    expect(parseResult(result)).toContain('Idea not found')
    expect(mockPrisma.idea.update).not.toHaveBeenCalled()
  })

  it('persists review_log + reviewed_at and logs a PLAN_REVIEW_RESULT entry', async () => {
    await handleUpdateIdeaPlanReviewed({
      idea_id: IDEA_ID,
      review_log: REVIEW_LOG,
      approval_status: 'approved',
    })
    const updateArg = mockPrisma.idea.update.mock.calls[0]?.[0]
    expect(updateArg?.data?.plan_review_log).toEqual(REVIEW_LOG)
    expect(updateArg?.data?.reviewed_at).toBeInstanceOf(Date)

    const logArg = mockPrisma.ideaLog.create.mock.calls[0]?.[0]
    expect(logArg?.data?.type).toBe('PLAN_REVIEW_RESULT')
    expect(logArg?.data?.idea_id).toBe(IDEA_ID)
  })
})
