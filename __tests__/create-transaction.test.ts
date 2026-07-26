import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { BASE_BACKOFF_MS } from '../src/lib/retry-backoff.js'

vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn().mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' }),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/access.js', () => ({
  userCanAccessProduct: vi.fn().mockResolvedValue(true),
}))

const { tx, root } = vi.hoisted(() => {
  const transactionClient = {
    pbi: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    story: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    task: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    pbiDoc: { upsert: vi.fn() },
  }
  const prismaClient = {
    pbi: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    sprint: { findUnique: vi.fn() },
    story: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    task: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    productDoc: { findMany: vi.fn() },
    productDocRevision: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  }
  return { tx: transactionClient, root: prismaClient }
})

vi.mock('../src/prisma.js', () => ({ prisma: root }))

import { registerCreatePbiTool } from '../src/tools/create-pbi.js'
import { handleCreateStory } from '../src/tools/create-story.js'
import { handleCreateTask } from '../src/tools/create-task.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

function p2034() {
  return new Prisma.PrismaClientKnownRequestError('write conflict', {
    code: 'P2034',
    clientVersion: 'test',
  })
}

function p2002(target: string[] | string) {
  return new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  })
}

// Shapes below are copied verbatim from a live Postgres 17.9 run on
// Prisma 7.8 + @prisma/adapter-pg. The driver adapter does NOT populate
// `meta.target`; the constraint lands under meta.driverAdapterError.cause,
// and a commit-time 40001 never becomes P2034 at all — it escapes raw.
function driverAdapterError(cause: Record<string, unknown>) {
  const error = new Error(String(cause.kind))
  error.name = 'DriverAdapterError'
  ;(error as Error & { cause: unknown }).cause = cause
  return error
}

function adapterP2002(fields: string[], constraintName: string) {
  return new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'test',
    meta: {
      modelName: 'Task',
      driverAdapterError: driverAdapterError({
        originalCode: '23505',
        originalMessage: `duplicate key value violates unique constraint "${constraintName}"`,
        kind: 'UniqueConstraintViolation',
        constraint: { fields },
      }),
    },
  })
}

function adapterWriteConflict() {
  return driverAdapterError({
    originalCode: '40001',
    originalMessage: 'could not serialize access due to read/write dependencies among transactions',
    kind: 'TransactionWriteConflict',
  })
}

function capturePbiHandler() {
  // Promise<CallToolResult>, niet Promise<unknown>: in de it.each-tupels staat deze
  // handler naast handleCreateStory/handleCreateTask, en één unknown-tak maakt de
  // hele unie unknown — waardoor result.isError niet meer leesbaar is.
  let handler: ((input: Record<string, unknown>) => Promise<CallToolResult>) | undefined
  registerCreatePbiTool({
    registerTool: vi.fn((_name, _definition, callback) => { handler = callback }),
  } as never)
  return handler!
}

beforeEach(() => {
  vi.clearAllMocks()
  root.$transaction.mockReset()
  root.pbi.findUnique.mockResolvedValue({ product_id: 'product-1' })
  root.story.findUnique.mockResolvedValue({ product_id: 'product-1', sprint_id: null, assignee_id: null })
  root.productDoc.findMany.mockResolvedValue([])
  root.pbi.findMany.mockResolvedValue([])
  root.pbi.findFirst.mockResolvedValue({ sort_order: 3 })
  root.story.findMany.mockResolvedValue([])
  root.story.findFirst.mockResolvedValue({ sort_order: 5 })
  root.story.create.mockResolvedValue({ id: 'story-root', code: 'ST-001', sort_order: 6 })
  root.task.findMany.mockResolvedValue([])
  root.task.findFirst.mockResolvedValue({ sort_order: 7 })
  root.task.create.mockResolvedValue({ id: 'task-root', code: 'T-1', sort_order: 8 })
  tx.pbi.findMany.mockResolvedValue([])
  tx.pbi.findFirst.mockResolvedValue({ sort_order: 3 })
  tx.pbi.create.mockResolvedValue({ id: 'pbi-1', code: 'PBI-1', sort_order: 4 })
  tx.story.findMany.mockResolvedValue([])
  tx.story.findFirst.mockResolvedValue({ sort_order: 5 })
  tx.story.create.mockResolvedValue({ id: 'story-1', code: 'ST-001', sort_order: 6 })
  tx.task.findMany.mockResolvedValue([])
  tx.task.findFirst.mockResolvedValue({ sort_order: 7 })
  tx.task.create.mockResolvedValue({ id: 'task-1', code: 'T-1', sort_order: 8 })
  root.$transaction.mockImplementation(async (callback) => callback(tx))
})

describe('create tools serialize parent-scoped append', () => {
  it.each([
    ['pbi', () => capturePbiHandler()({ product_id: 'product-1', title: 'PBI', priority: 2 }), tx.pbi, root.pbi],
    ['story', () => handleCreateStory({ pbi_id: 'pbi-1', title: 'Story', priority: 2 }), tx.story, root.story],
    ['task', () => handleCreateTask({ story_id: 'story-1', title: 'Task', priority: 2 }), tx.task, root.task],
  ] as const)('%s reads the parent max and creates inside one Serializable transaction', async (_name, create, txModel, rootModel) => {
    await create()

    expect(root.$transaction).toHaveBeenCalledTimes(1)
    expect(root.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    })
    expect(txModel.findFirst).toHaveBeenCalledOnce()
    expect(txModel.create).toHaveBeenCalledOnce()
    expect(rootModel.findFirst).not.toHaveBeenCalled()
    expect(rootModel.create).not.toHaveBeenCalled()
  })

  it('retries P2034 at most three times and reruns the complete transaction', async () => {
    root.$transaction
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(p2034())
      .mockImplementationOnce(async (callback) => callback(tx))

    await handleCreateTask({ story_id: 'story-1', title: 'Task', priority: 2 })

    expect(root.$transaction).toHaveBeenCalledTimes(4)
  })

  it('does not retry errors other than P2034', async () => {
    root.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
    )

    await handleCreateTask({ story_id: 'story-1', title: 'Task', priority: 2 })

    expect(root.$transaction).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['pbi', () => capturePbiHandler()({ product_id: 'product-1', title: 'PBI', priority: 2 })],
    ['story', () => handleCreateStory({ pbi_id: 'pbi-1', title: 'Story', priority: 2 })],
    ['task', () => handleCreateTask({ story_id: 'story-1', title: 'Task', priority: 2 })],
  ] as const)('%s retries the complete create attempt after the expected code P2002', async (_name, create) => {
    root.$transaction
      .mockRejectedValueOnce(p2002(['product_id', 'code']))
      .mockImplementationOnce(async (callback) => callback(tx))

    const result = await create()

    expect(result.isError).not.toBe(true)
    expect(root.$transaction).toHaveBeenCalledTimes(2)
  })

  it('stops after three expected code P2002 retries', async () => {
    root.$transaction.mockRejectedValue(p2002('tasks_product_id_code_key'))

    const result = await handleCreateTask({ story_id: 'story-1', title: 'Task', priority: 2 })

    expect(result.isError).toBe(true)
    expect(root.$transaction).toHaveBeenCalledTimes(4)
  })

  it('propagates an unrelated P2002 without outer retry', async () => {
    root.$transaction.mockRejectedValueOnce(p2002(['story_id', 'sort_order']))

    const result = await handleCreateTask({ story_id: 'story-1', title: 'Task', priority: 2 })

    expect(result.isError).toBe(true)
    expect(root.$transaction).toHaveBeenCalledTimes(1)
  })
})

describe('create tools recognise driver-adapter error shapes', () => {
  it.each([
    ['pbi', () => capturePbiHandler()({ product_id: 'product-1', title: 'PBI', priority: 2 })],
    ['story', () => handleCreateStory({ pbi_id: 'pbi-1', title: 'Story', priority: 2 })],
    ['task', () => handleCreateTask({ story_id: 'story-1', title: 'Task', priority: 2 })],
  ] as const)('%s retries the code conflict the driver adapter reports without meta.target', async (_name, create) => {
    root.$transaction
      .mockRejectedValueOnce(adapterP2002(['product_id', 'code'], 'tasks_product_id_code_key'))
      .mockImplementationOnce(async (callback) => callback(tx))

    const result = await create()

    expect(result.isError).not.toBe(true)
    expect(root.$transaction).toHaveBeenCalledTimes(2)
  })

  it('propagates an unrelated driver-adapter unique conflict without outer retry', async () => {
    root.$transaction.mockRejectedValueOnce(
      adapterP2002(['story_id', 'sort_order'], 'tasks_story_id_sort_order_key'),
    )

    const result = await handleCreateTask({ story_id: 'story-1', title: 'Task', priority: 2 })

    expect(result.isError).toBe(true)
    expect(root.$transaction).toHaveBeenCalledTimes(1)
  })

  // adapter-pg derives `constraint.fields` from the Postgres DETAIL line and
  // leaves `constraint` undefined when that line is absent — then the index
  // name in the original message is all we have to go on.
  it('retries on the constraint name when the adapter reports no fields', async () => {
    const noFields = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
      meta: {
        driverAdapterError: driverAdapterError({
          originalCode: '23505',
          originalMessage:
            'duplicate key value violates unique constraint "tasks_product_id_code_key"',
          kind: 'UniqueConstraintViolation',
        }),
      },
    })
    root.$transaction
      .mockRejectedValueOnce(noFields)
      .mockImplementationOnce(async (callback) => callback(tx))

    const result = await handleCreateTask({ story_id: 'story-1', title: 'Task', priority: 2 })

    expect(result.isError).not.toBe(true)
    expect(root.$transaction).toHaveBeenCalledTimes(2)
  })

  it('waits before retrying so contending losers do not re-collide in lockstep', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)
    root.$transaction
      .mockRejectedValueOnce(adapterWriteConflict())
      .mockImplementationOnce(async (callback) => callback(tx))

    const started = performance.now()
    await handleCreateTask({ story_id: 'story-1', title: 'Task', priority: 2 })
    const elapsed = performance.now() - started

    expect(root.$transaction).toHaveBeenCalledTimes(2)
    expect(elapsed).toBeGreaterThanOrEqual(BASE_BACKOFF_MS)
  })

  it('retries a commit-time write conflict that never becomes P2034', async () => {
    root.$transaction
      .mockRejectedValueOnce(adapterWriteConflict())
      .mockImplementationOnce(async (callback) => callback(tx))

    const result = await handleCreateTask({ story_id: 'story-1', title: 'Task', priority: 2 })

    expect(result.isError).not.toBe(true)
    expect(root.$transaction).toHaveBeenCalledTimes(2)
  })
})
