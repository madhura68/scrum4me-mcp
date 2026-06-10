import { describe, it, expect, vi, beforeEach } from 'vitest'

const findFirstExecution = vi.fn()
const findFirstJob = vi.fn()
vi.mock('../../src/prisma.js', () => ({
  prisma: {
    sprintTaskExecution: { findFirst: (...a: any[]) => findFirstExecution(...a) },
    claudeJob: { findFirst: (...a: any[]) => findFirstJob(...a) },
  },
}))

import { resolveTaskImplContext } from '../../src/lib/task-review-context.js'

beforeEach(() => {
  vi.clearAllMocks()
  findFirstExecution.mockResolvedValue(null)
  findFirstJob.mockResolvedValue(null)
})

describe('resolveTaskImplContext', () => {
  it('DONE execution exists → returns execution sha/plan, execution_id set, pr_url from sprint_job', async () => {
    findFirstExecution.mockResolvedValue({
      id: 'exec-1',
      plan_snapshot: 'PLAN_SNAP',
      base_sha: 'base-abc',
      head_sha: 'head-def',
      sprint_job: { pr_url: 'https://git.jp-visser.nl/o/r/pulls/42' },
    })

    const result = await resolveTaskImplContext('task-1')

    expect(result).toMatchObject({
      plan_snapshot: 'PLAN_SNAP',
      base_sha: 'base-abc',
      head_sha: 'head-def',
      pr_url: 'https://git.jp-visser.nl/o/r/pulls/42',
      execution_id: 'exec-1',
    })
  })

  it('DONE execution exists but sprint_job.pr_url is null → fallback to impl job pr_url', async () => {
    findFirstExecution.mockResolvedValue({
      id: 'exec-2',
      plan_snapshot: 'PLAN',
      base_sha: 'base-1',
      head_sha: 'head-2',
      sprint_job: { pr_url: null },
    })
    findFirstJob.mockResolvedValue({
      plan_snapshot: 'JOB_PLAN',
      base_sha: 'jbase',
      head_sha: 'jhead',
      pr_url: 'https://git.jp-visser.nl/o/r/pulls/99',
    })

    const result = await resolveTaskImplContext('task-2')

    // execution wins for sha/plan, but pr_url falls back to impl job
    expect(result).toMatchObject({
      plan_snapshot: 'PLAN',
      base_sha: 'base-1',
      head_sha: 'head-2',
      pr_url: 'https://git.jp-visser.nl/o/r/pulls/99',
      execution_id: 'exec-2',
    })
  })

  it('No execution, TASK_IMPLEMENTATION job exists → job sha/plan/pr_url, execution_id null', async () => {
    findFirstExecution.mockResolvedValue(null)
    findFirstJob.mockResolvedValue({
      plan_snapshot: 'JOB_PLAN',
      base_sha: 'jbase-abc',
      head_sha: 'jhead-def',
      pr_url: 'https://git.jp-visser.nl/o/r/pulls/7',
    })

    const result = await resolveTaskImplContext('task-3')

    expect(result).toMatchObject({
      plan_snapshot: 'JOB_PLAN',
      base_sha: 'jbase-abc',
      head_sha: 'jhead-def',
      pr_url: 'https://git.jp-visser.nl/o/r/pulls/7',
      execution_id: null,
    })
  })

  it('Neither execution nor job → all-null object', async () => {
    const result = await resolveTaskImplContext('task-4')

    expect(result).toMatchObject({
      plan_snapshot: null,
      base_sha: null,
      head_sha: null,
      pr_url: null,
      execution_id: null,
    })
  })

  it('queries sprintTaskExecution.findFirst with correct where/orderBy', async () => {
    await resolveTaskImplContext('task-5')

    const call = findFirstExecution.mock.calls[0][0]
    expect(call.where).toEqual({ task_id: 'task-5', status: 'DONE' })
    expect(call.orderBy).toEqual({ created_at: 'desc' })
  })

  it('queries claudeJob.findFirst with correct where/orderBy', async () => {
    await resolveTaskImplContext('task-6')

    const call = findFirstJob.mock.calls[0][0]
    expect(call.where).toEqual({ task_id: 'task-6', kind: 'TASK_IMPLEMENTATION' })
    expect(call.orderBy).toEqual({ created_at: 'desc' })
  })
})
