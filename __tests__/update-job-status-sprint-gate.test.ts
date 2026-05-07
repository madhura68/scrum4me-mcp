import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    sprintTaskExecution: {
      findMany: vi.fn(),
    },
    sprintRun: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    story: {
      count: vi.fn(),
    },
  },
}))

import { prisma } from '../src/prisma.js'
import {
  checkSprintVerifyGate,
  finalizeSprintRunOnDone,
} from '../src/tools/update-job-status.js'

type MockedPrisma = {
  sprintTaskExecution: { findMany: ReturnType<typeof vi.fn> }
  sprintRun: {
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  story: { count: ReturnType<typeof vi.fn> }
}

const mocked = prisma as unknown as MockedPrisma

const LONG_SUMMARY = 'Refactor touched extra files for type narrowing.'

function execRow(overrides: Record<string, unknown>) {
  return {
    id: 'exec-' + Math.random().toString(36).slice(2, 8),
    task_id: 't1',
    order: 0,
    status: 'DONE',
    verify_result: 'ALIGNED',
    verify_summary: null,
    verify_required_snapshot: 'ALIGNED_OR_PARTIAL',
    verify_only_snapshot: false,
    task: { code: 'TASK-1', title: 'Sample task' },
    ...overrides,
  }
}

describe('checkSprintVerifyGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects when no executions exist (claim-bug)', async () => {
    mocked.sprintTaskExecution.findMany.mockResolvedValue([])
    const r = await checkSprintVerifyGate('job-x')
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.error).toMatch(/geen SprintTaskExecution-rows/i)
  })

  it('blocks PENDING/RUNNING executions', async () => {
    mocked.sprintTaskExecution.findMany.mockResolvedValue([
      execRow({ status: 'PENDING' }),
      execRow({ status: 'RUNNING' }),
    ])
    const r = await checkSprintVerifyGate('job-x')
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.error).toMatch(/PENDING/)
      expect(r.error).toMatch(/RUNNING/)
    }
  })

  it('blocks FAILED executions', async () => {
    mocked.sprintTaskExecution.findMany.mockResolvedValue([
      execRow({ status: 'FAILED' }),
    ])
    const r = await checkSprintVerifyGate('job-x')
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.error).toMatch(/FAILED/)
  })

  it('blocks SKIPPED unless verify_required_snapshot=ANY', async () => {
    mocked.sprintTaskExecution.findMany.mockResolvedValue([
      execRow({ status: 'SKIPPED', verify_required_snapshot: 'ALIGNED' }),
    ])
    const r = await checkSprintVerifyGate('job-x')
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.error).toMatch(/SKIPPED/)
  })

  it('allows SKIPPED when verify_required_snapshot=ANY', async () => {
    mocked.sprintTaskExecution.findMany.mockResolvedValue([
      execRow({ status: 'SKIPPED', verify_required_snapshot: 'ANY' }),
    ])
    expect((await checkSprintVerifyGate('job-x')).allowed).toBe(true)
  })

  it('runs per-row gate for DONE executions', async () => {
    // PARTIAL zonder summary onder ALIGNED_OR_PARTIAL → blocker
    mocked.sprintTaskExecution.findMany.mockResolvedValue([
      execRow({
        status: 'DONE',
        verify_result: 'PARTIAL',
        verify_summary: null,
        verify_required_snapshot: 'ALIGNED_OR_PARTIAL',
      }),
    ])
    const r = await checkSprintVerifyGate('job-x')
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.error).toMatch(/DONE-gate/)
  })

  it('passes when all DONE rows pass per-row gate', async () => {
    mocked.sprintTaskExecution.findMany.mockResolvedValue([
      execRow({ verify_result: 'ALIGNED' }),
      execRow({
        verify_result: 'PARTIAL',
        verify_summary: LONG_SUMMARY,
        verify_required_snapshot: 'ALIGNED_OR_PARTIAL',
      }),
    ])
    expect((await checkSprintVerifyGate('job-x')).allowed).toBe(true)
  })

  it('aggregates multiple blockers in one error message', async () => {
    mocked.sprintTaskExecution.findMany.mockResolvedValue([
      execRow({ status: 'FAILED', task: { code: 'A', title: 'a' } }),
      execRow({ status: 'PENDING', task: { code: 'B', title: 'b' } }),
    ])
    const r = await checkSprintVerifyGate('job-x')
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.error).toMatch(/2 task\(s\) blokkeren/)
      expect(r.error).toMatch(/A: a/)
      expect(r.error).toMatch(/B: b/)
    }
  })
})

describe('finalizeSprintRunOnDone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('no-op when SprintRun already DONE (idempotent)', async () => {
    mocked.sprintRun.findUnique.mockResolvedValue({
      id: 'sr-1',
      status: 'DONE',
      sprint_id: 's1',
    })
    await finalizeSprintRunOnDone('sr-1')
    expect(mocked.sprintRun.update).not.toHaveBeenCalled()
  })

  it('no-op when SprintRun does not exist', async () => {
    mocked.sprintRun.findUnique.mockResolvedValue(null)
    await finalizeSprintRunOnDone('sr-x')
    expect(mocked.sprintRun.update).not.toHaveBeenCalled()
  })

  it('no-op when stories still open', async () => {
    mocked.sprintRun.findUnique.mockResolvedValue({
      id: 'sr-1',
      status: 'RUNNING',
      sprint_id: 's1',
    })
    mocked.story.count.mockResolvedValue(2)
    await finalizeSprintRunOnDone('sr-1')
    expect(mocked.sprintRun.update).not.toHaveBeenCalled()
  })

  it('sets SprintRun → DONE when all stories DONE/FAILED', async () => {
    mocked.sprintRun.findUnique.mockResolvedValue({
      id: 'sr-1',
      status: 'RUNNING',
      sprint_id: 's1',
    })
    mocked.story.count.mockResolvedValue(0)
    await finalizeSprintRunOnDone('sr-1')
    expect(mocked.sprintRun.update).toHaveBeenCalledWith({
      where: { id: 'sr-1' },
      data: expect.objectContaining({
        status: 'DONE',
        finished_at: expect.any(Date),
      }),
    })
  })
})
