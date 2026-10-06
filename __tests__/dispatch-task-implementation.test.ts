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
    // M45-2b: de enqueue leest de productkeuze (readHarnessChoice); standaard bestaat die niet.
    productHarnessChoice: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}))
vi.mock('../src/lib/dispatch/snapshot.js', () => ({
  getJobConfigSnapshot: vi.fn().mockResolvedValue({}),
}))
vi.mock('../src/lib/dispatch/notify.js', () => ({ notifyJobEnqueued: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { dispatchTaskImplementation } from '../src/lib/dispatch/task-implementation.js'
import { getJobConfigSnapshot } from '../src/lib/dispatch/snapshot.js'
import { notifyJobEnqueued } from '../src/lib/dispatch/notify.js'
import { DispatchError } from '../src/lib/dispatch/errors.js'

const mockTask = prisma.task.findUnique as ReturnType<typeof vi.fn>
const mockCreate = prisma.claudeJob.create as ReturnType<typeof vi.fn>
const mockFindFirst = prisma.claudeJob.findFirst as ReturnType<typeof vi.fn>
const mockChoice = prisma.productHarnessChoice.findUnique as ReturnType<typeof vi.fn>

const baseTask = { id: 't1', status: 'TO_DO', story: { product_id: 'prod-1' } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: unknown) => (fn as (tx: typeof prisma) => Promise<unknown>)(prisma))
  mockCreate.mockResolvedValue({ id: 'job-1' })
  mockFindFirst.mockResolvedValue(null)
  mockTask.mockResolvedValue(baseTask)
  mockChoice.mockResolvedValue(null)
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
    const data = mockCreate.mock.calls[0][0].data
    expect(data).not.toHaveProperty('required_capability')
    expect(data).not.toHaveProperty('runtime')
  })

  it('de optie requiredCapability bestaat niet meer: een oude aanroeper krijgt geen required_capability en geen runtime op de job', async () => {
    // M45-2b: dispatch_job weigert required_capability (dispatch-job.test.ts); de dispatcher zelf draagt de optie en de
    // tak ervan niet meer. Een job met local_llm ontstaat hier dus nooit meer.
    const res = await dispatchTaskImplementation({
      taskId: 't1', productId: 'prod-1', userId: 'u1',
      // @ts-expect-error de optie is met M45-2b vervallen
      requiredCapability: 'local_llm',
    })
    expect(res).toEqual({ job_id: 'job-1' })
    const data = mockCreate.mock.calls[0][0].data
    expect(data).not.toHaveProperty('required_capability')
    expect(data).not.toHaveProperty('runtime')
  })
})

// M45-2b Taak 4 (spec §5.2): met een keuze voor (product, TASK_IMPLEMENTATION) wordt de losse taak een HARNESS-job
// met de gekozen configuratie en zonder de Claude-snapshot; zonder keuze is het create-object exact dat van vóór M45.
describe('dispatchTaskImplementation: routering via de productkeuze', () => {
  const SNAPSHOT = {
    requested_model: 'claude-sonnet-5',
    requested_thinking_budget: 8000,
    requested_permission_mode: 'default',
  }
  const CHOICE = { configuration: 'gsq-lokaal', max_cost_usd: '0.5000' }
  const BASE_DATA = {
    user_id: 'u1',
    product_id: 'prod-1',
    task_id: 't1',
    kind: 'TASK_IMPLEMENTATION',
    status: 'QUEUED',
    source: 'COPILOT',
  }

  it('met een keuze: runtime HARNESS en de configuratie als requested_model, zonder Claude-snapshot en zonder capability', async () => {
    vi.mocked(getJobConfigSnapshot).mockResolvedValueOnce(SNAPSHOT as never)
    mockChoice.mockResolvedValue(CHOICE)

    const res = await dispatchTaskImplementation({ taskId: 't1', productId: 'prod-1', userId: 'u1' })

    expect(res).toEqual({ job_id: 'job-1' })
    // Exact: geen requested_thinking_budget, geen requested_permission_mode, geen required_capability.
    expect(mockCreate.mock.calls[0][0]).toStrictEqual({
      data: { ...BASE_DATA, runtime: 'HARNESS', requested_model: 'gsq-lokaal' },
      select: { id: true },
    })
    expect(notifyJobEnqueued).toHaveBeenCalledWith(expect.objectContaining({ job_id: 'job-1', kind: 'TASK_IMPLEMENTATION' }))
  })

  it('zonder keuze: exact het object van vóór M45, met de Claude-snapshot en zonder runtime of capability', async () => {
    vi.mocked(getJobConfigSnapshot).mockResolvedValueOnce(SNAPSHOT as never)

    await dispatchTaskImplementation({ taskId: 't1', productId: 'prod-1', userId: 'u1' })

    expect(mockCreate.mock.calls[0][0]).toStrictEqual({
      data: { ...BASE_DATA, ...SNAPSHOT },
      select: { id: true },
    })
  })

  it('de keuze wordt op de transactieclient gelezen, voor (product, TASK_IMPLEMENTATION), na de guards en vóór de create', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 't1' }]),
      task: { findUnique: vi.fn().mockResolvedValue(baseTask) },
      claudeJob: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'job-1' }),
      },
      productHarnessChoice: { findUnique: vi.fn().mockResolvedValue(CHOICE) },
    }
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) as never)

    await dispatchTaskImplementation({ taskId: 't1', productId: 'prod-1', userId: 'u1' })

    expect(tx.productHarnessChoice.findUnique).toHaveBeenCalledTimes(1)
    expect(tx.productHarnessChoice.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { product_id_kind: { product_id: 'prod-1', kind: 'TASK_IMPLEMENTATION' } },
    }))
    // Niet via de losse client, en pas na de laatste guard (de duplicaatcheck).
    expect(mockChoice).not.toHaveBeenCalled()
    const read = tx.productHarnessChoice.findUnique.mock.invocationCallOrder[0]
    expect(tx.claudeJob.findFirst.mock.invocationCallOrder[0]).toBeLessThan(read)
    expect(read).toBeLessThan(tx.claudeJob.create.mock.invocationCallOrder[0])
    expect(tx.claudeJob.create.mock.calls[0][0].data).toMatchObject({ runtime: 'HARNESS', requested_model: 'gsq-lokaal' })
  })

  it('een leesfout van de keuze is geen "geen keuze": de dispatch mislukt, zonder job en zonder melding', async () => {
    mockChoice.mockRejectedValue(new Error('READ_FAILED'))

    await expect(
      dispatchTaskImplementation({ taskId: 't1', productId: 'prod-1', userId: 'u1' }),
    ).rejects.toThrow('READ_FAILED')

    expect(mockCreate).not.toHaveBeenCalled()
    expect(notifyJobEnqueued).not.toHaveBeenCalled()
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
 // ST-1590.38 (c): whoever holds the Task, the requester reads the active-job message, never the
 // bare guard code.
 const reason=await dispatchTaskImplementation({taskId:'t1',productId:'prod-1',userId:'u1'}).then(()=>null,(error:unknown)=>String(error))
 expect(reason).toMatch(/actieve job/)
 expect(reason).not.toMatch(/DISPATCH_MANAGED_ROW/)
 expect(mockCreate).not.toHaveBeenCalled()
})
