import { describe, it, expect, vi, beforeEach } from 'vitest'

// T-1865: handleUpdateTaskStatus must translate the managed-row guard (raised via assertUnmanagedTask
// when the task carries a dispatch binding) into a friendly, fail-closed refusal instead of leaking
// the bare DISPATCH_MANAGED_ROW code. Unit-level pin; the DB-backed red/green lives in
// __tests__/dispatch/host-task.integration.test.ts.
vi.mock('../src/prisma.js', () => ({
  prisma: {
    task: { findUnique: vi.fn() },
    sprintRun: { findUnique: vi.fn() },
    claudeJob: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn().mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' }),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/lib/resolve-entity.js', () => ({ resolveTaskRef: vi.fn().mockResolvedValue({ id: 'task-1' }) }))
vi.mock('../src/lib/tasks-status-update.js', () => ({ updateTaskStatusWithStoryPromotion: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { updateTaskStatusWithStoryPromotion } from '../src/lib/tasks-status-update.js'
import { handleUpdateTaskStatus } from '../src/tools/update-task-status.js'

const findUnique = prisma.task.findUnique as ReturnType<typeof vi.fn>
const statusMutation = updateTaskStatusWithStoryPromotion as ReturnType<typeof vi.fn>
const text = (r: { content?: Array<{ type: string; text?: string }> }) => r.content?.[0]?.text ?? ''

beforeEach(() => { vi.clearAllMocks() })

describe('handleUpdateTaskStatus managed-row refusal (T-1865)', () => {
  it('translates the managed-row guard into a friendly, fail-closed refusal', async () => {
    // A managed task carries a dispatch_request_id; assertUnmanagedTask refuses on it.
    findUnique.mockResolvedValue({ dispatch_request_id: 'managed-req' })
    const result = await handleUpdateTaskStatus({ task_id: 'task-1', status: 'in_progress' })
    expect(result).toMatchObject({ isError: true })
    expect(text(result)).toMatch(/actieve dispatch voor deze task/)
    expect(text(result)).not.toContain('DISPATCH_MANAGED_ROW')
    // Fail-closed: no status mutation was attempted.
    expect(statusMutation).not.toHaveBeenCalled()
  })

  it('lets an unmanaged task proceed past the guard', async () => {
    findUnique.mockResolvedValue({ dispatch_request_id: null })
    statusMutation.mockResolvedValue({
      task: { id: 'task-1', status: 'IN_PROGRESS', implementation_plan: null },
      storyStatusChange: null, sprintRunChanged: false,
    })
    const result = await handleUpdateTaskStatus({ task_id: 'task-1', status: 'in_progress' })
    expect(result).not.toMatchObject({ isError: true })
    expect(statusMutation).toHaveBeenCalledTimes(1)
  })
})
