import { describe, it, expect, vi, beforeEach } from 'vitest'

const tx = {
  sprint: { findUnique: vi.fn() },
  sprintRun: { findFirst: vi.fn(), create: vi.fn().mockResolvedValue({ id: 'run-1' }) },
  story: { findMany: vi.fn() },
  claudeQuestion: { findMany: vi.fn() },
  claudeJob: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
}
vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  },
}))
vi.mock('../src/lib/dispatch/snapshot.js', () => ({
  getJobConfigSnapshot: vi.fn().mockResolvedValue({}),
}))

import { dispatchSprintRun, DispatchError } from '../src/lib/dispatch/sprint-run.js'

const mockSprint = tx.sprint.findUnique
const mockActiveRun = tx.sprintRun.findFirst
const mockStories = tx.story.findMany
const mockQuestions = tx.claudeQuestion.findMany

const baseSprint = {
  id: 's1',
  status: 'OPEN',
  product_id: 'prod-1',
  product: { id: 'prod-1', repo_url: 'https://git/x', pr_strategy: 'SPRINT_BATCH' },
}

const baseTask = {
  id: 't1',
  code: 'T-1',
  title: 'Do thing',
  status: 'TO_DO',
  implementation_plan: 'Plan here',
  repo_url: null,
  sort_order: 0,
}

const baseStories = [
  {
    id: 'story-1',
    sort_order: 0,
    pbi: { id: 'pbi-1', code: 'PBI-1', title: 'First PBI', status: 'TODO', priority: 1, sort_order: 0 },
    tasks: [baseTask],
  },
]

const opts = { sprintId: 's1', productId: 'prod-1', userId: 'user-1' }

beforeEach(() => {
  vi.clearAllMocks()
  tx.sprintRun.create.mockResolvedValue({ id: 'run-1' })
  tx.claudeJob.create.mockResolvedValue({ id: 'job-1' })
  tx.sprint.findUnique.mockResolvedValue(baseSprint)
  tx.sprintRun.findFirst.mockResolvedValue(null)
  tx.story.findMany.mockResolvedValue(baseStories)
  tx.claudeQuestion.findMany.mockResolvedValue([])
})

describe('dispatchSprintRun', () => {
  // (a) happy path SPRINT_BATCH
  it('maakt 1 SPRINT_IMPLEMENTATION-job bij pr_strategy SPRINT_BATCH', async () => {
    const res = await dispatchSprintRun(opts)
    expect(res).toEqual({ sprint_run_id: 'run-1', jobs_count: 1 })
    expect(tx.claudeJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'SPRINT_IMPLEMENTATION',
          source: 'COPILOT',
          sprint_run_id: 'run-1',
        }),
      }),
    )
  })

  // (b) sprint van ander product
  it('gooit DispatchError als sprint.product_id !== productId', async () => {
    mockSprint.mockResolvedValue({ ...baseSprint, product_id: 'prod-2', product: { ...baseSprint.product, id: 'prod-2' } })
    await expect(dispatchSprintRun(opts)).rejects.toThrow(/not found in this product/)
    await expect(dispatchSprintRun(opts)).rejects.toBeInstanceOf(DispatchError)
  })

  // (c) sprint niet OPEN
  it('gooit DispatchError als sprint niet OPEN is', async () => {
    mockSprint.mockResolvedValue({ ...baseSprint, status: 'PLANNED' })
    await expect(dispatchSprintRun(opts)).rejects.toBeInstanceOf(DispatchError)
  })

  // (d) actieve run aanwezig
  it('gooit DispatchError als er al een actieve sprint-run is', async () => {
    mockActiveRun.mockResolvedValue({ id: 'run-existing', status: 'RUNNING' })
    await expect(dispatchSprintRun(opts)).rejects.toBeInstanceOf(DispatchError)
  })

  // (e) blocker task_no_plan
  it('gooit DispatchError PRE_FLIGHT_BLOCKED met task-label bij task zonder plan', async () => {
    mockStories.mockResolvedValue([
      {
        ...baseStories[0],
        tasks: [{ ...baseTask, implementation_plan: null }],
      },
    ])
    const err = await dispatchSprintRun(opts).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DispatchError)
    expect((err as Error).message).toMatch(/PRE_FLIGHT_BLOCKED/)
    expect((err as Error).message).toMatch(/T-1/)
  })

  // (f) STORY-strategie: per TO_DO-task één TASK_IMPLEMENTATION-job
  it('maakt per task 1 TASK_IMPLEMENTATION-job bij pr_strategy STORY, gesorteerd op pbi.priority → pbi.sort_order → story.sort_order', async () => {
    mockSprint.mockResolvedValue({
      ...baseSprint,
      product: { ...baseSprint.product, pr_strategy: 'STORY' },
    })
    const taskA = { ...baseTask, id: 't-a', code: 'T-A', sort_order: 1 }
    const taskB = { ...baseTask, id: 't-b', code: 'T-B', sort_order: 0 }
    mockStories.mockResolvedValue([
      {
        id: 'story-2',
        sort_order: 1,
        pbi: { id: 'pbi-2', code: 'PBI-2', title: 'Second', status: 'TODO', priority: 2, sort_order: 1 },
        tasks: [taskA],
      },
      {
        id: 'story-1',
        sort_order: 0,
        pbi: { id: 'pbi-1', code: 'PBI-1', title: 'First', status: 'TODO', priority: 1, sort_order: 0 },
        tasks: [taskB],
      },
    ])
    const res = await dispatchSprintRun(opts)
    expect(res.jobs_count).toBe(2)
    expect(tx.claudeJob.create).toHaveBeenCalledTimes(2)
    const calls = tx.claudeJob.create.mock.calls
    expect(calls[0][0].data).toMatchObject({ kind: 'TASK_IMPLEMENTATION', source: 'COPILOT', sprint_run_id: 'run-1', task_id: 't-b' })
    expect(calls[1][0].data).toMatchObject({ kind: 'TASK_IMPLEMENTATION', source: 'COPILOT', sprint_run_id: 'run-1', task_id: 't-a' })
  })
})
