import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ id: 't1' }]),
    task: { findUnique: vi.fn() },
    claudeJob: {
      create: vi.fn().mockResolvedValue({ id: 'job-1' }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}))
vi.mock('../src/lib/dispatch/snapshot.js', () => ({
  getJobConfigSnapshot: vi.fn().mockResolvedValue({}),
}))
vi.mock('../src/lib/dispatch/notify.js', () => ({ notifyJobEnqueued: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { dispatchTaskImplementation } from '../src/lib/dispatch/task-implementation.js'
import { DispatchError } from '../src/lib/dispatch/errors.js'

const mockTask = prisma.task.findUnique as ReturnType<typeof vi.fn>
const mockCreate = prisma.claudeJob.create as ReturnType<typeof vi.fn>
const mockFindFirst = prisma.claudeJob.findFirst as ReturnType<typeof vi.fn>

const baseTask = { id: 't1', status: 'TO_DO', story: { product_id: 'prod-1' } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) => (fn as (tx: typeof prisma) => Promise<unknown>)(prisma))
  mockCreate.mockResolvedValue({ id: 'job-1' })
  mockFindFirst.mockResolvedValue(null)
  mockTask.mockResolvedValue(baseTask)
})

describe('dispatchTaskImplementation', () => {
  it('foreign task (story.product_id ≠ productId) → DispatchError /not found in this product/', async () => {
    mockTask.mockResolvedValue({ id: 't1', status: 'TO_DO', story: { product_id: 'prod-2' } })
    await expect(
      dispatchTaskImplementation({ taskId: 't1', productId: 'prod-1', userId: 'u1' }),
    ).rejects.toThrow(/not found in this product/)
  })

  it('task met status ≠ TO_DO → DispatchError /TO_DO/', async () => {
    mockTask.mockResolvedValue({ id: 't1', status: 'IN_PROGRESS', story: { product_id: 'prod-1' } })
    await expect(
      dispatchTaskImplementation({ taskId: 't1', productId: 'prod-1', userId: 'u1' }),
    ).rejects.toThrow(/TO_DO/)
  })

  it('actieve job aanwezig → DispatchError /actieve/', async () => {
    mockFindFirst.mockResolvedValue({ id: 'job-existing' })
    await expect(
      dispatchTaskImplementation({ taskId: 't1', productId: 'prod-1', userId: 'u1' }),
    ).rejects.toThrow(/actieve/)
  })

  it('happy path → claudeJob.create met TASK_IMPLEMENTATION + COPILOT + QUEUED en return {job_id}', async () => {
    const res = await dispatchTaskImplementation({ taskId: 't1', productId: 'prod-1', userId: 'u1' })
    expect(res).toEqual({ job_id: 'job-1' })
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: 'TASK_IMPLEMENTATION',
        source: 'COPILOT',
        task_id: 't1',
        status: 'QUEUED',
      }),
    }))
  })
})

it('locks the task before duplicate check and job creation in the same transaction', async () => {
  await dispatchTaskImplementation({ taskId: 't1', productId: 'prod-1', userId: 'u1' })
  expect(prisma.$transaction).toHaveBeenCalledOnce()
  const lock = vi.mocked(prisma.$queryRaw)
  expect(lock.mock.calls[0][0].toString()).toContain('FOR UPDATE')
  expect(lock.mock.invocationCallOrder[0]).toBeLessThan(mockFindFirst.mock.invocationCallOrder[0])
  expect(mockFindFirst.mock.invocationCallOrder[0]).toBeLessThan(mockCreate.mock.invocationCallOrder[0])
})
it('rejects a public Task dispatch binding before creating a job or sending notification',async()=>{
 mockTask.mockResolvedValue({...baseTask,dispatch_request_id:'active-host-request'})
 await expect(dispatchTaskImplementation({taskId:'t1',productId:'prod-1',userId:'u1'})).rejects.toThrow('DISPATCH_MANAGED_ROW')
 expect(mockCreate).not.toHaveBeenCalled()
})
