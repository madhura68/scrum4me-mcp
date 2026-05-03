import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: {
      count: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}))

vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})

vi.mock('../src/access.js', () => ({
  userCanAccessProduct: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess, PermissionDeniedError } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { registerCheckQueueEmptyTool } from '../src/tools/check-queue-empty.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as {
  claudeJob: {
    count: ReturnType<typeof vi.fn>
    groupBy: ReturnType<typeof vi.fn>
  }
}
const mockRequireWriteAccess = requireWriteAccess as ReturnType<typeof vi.fn>
const mockUserCanAccessProduct = userCanAccessProduct as ReturnType<typeof vi.fn>

const USER_ID = 'user-abc'
const PRODUCT_A = 'product-aaa'
const PRODUCT_B = 'product-bbb'

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>) => handler(args),
  }
  registerCheckQueueEmptyTool(server as unknown as McpServer)
  return server
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireWriteAccess.mockResolvedValue({ userId: USER_ID, tokenId: 'tok-1', username: 'agent', isDemo: false })
  mockUserCanAccessProduct.mockResolvedValue(true)
})

describe('check_queue_empty — no product_id', () => {
  it('returns empty:true when no active jobs exist', async () => {
    mockPrisma.claudeJob.groupBy.mockResolvedValue([])
    const server = makeServer()
    const result = await server.call({}) as { content: { text: string }[] }
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ empty: true, remaining: 0, by_product: {} })
  })

  it('returns correct counts for one product with active jobs', async () => {
    mockPrisma.claudeJob.groupBy.mockResolvedValue([{ product_id: PRODUCT_A, _count: 3 }])
    const server = makeServer()
    const result = await server.call({}) as { content: { text: string }[] }
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ empty: false, remaining: 3, by_product: { [PRODUCT_A]: 3 } })
  })

  it('aggregates across two products', async () => {
    mockPrisma.claudeJob.groupBy.mockResolvedValue([
      { product_id: PRODUCT_A, _count: 2 },
      { product_id: PRODUCT_B, _count: 1 },
    ])
    const server = makeServer()
    const result = await server.call({}) as { content: { text: string }[] }
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({
      empty: false,
      remaining: 3,
      by_product: { [PRODUCT_A]: 2, [PRODUCT_B]: 1 },
    })
  })

  it('passes correct where clause to groupBy', async () => {
    mockPrisma.claudeJob.groupBy.mockResolvedValue([])
    const server = makeServer()
    await server.call({})
    expect(mockPrisma.claudeJob.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['product_id'],
        where: expect.objectContaining({
          user_id: USER_ID,
          status: { in: expect.arrayContaining(['QUEUED', 'CLAIMED', 'RUNNING']) },
          product: expect.objectContaining({ OR: expect.any(Array) }),
        }),
        _count: true,
      }),
    )
  })
})

describe('check_queue_empty — with product_id', () => {
  it('returns empty:true when product queue is empty', async () => {
    mockPrisma.claudeJob.count.mockResolvedValue(0)
    const server = makeServer()
    const result = await server.call({ product_id: PRODUCT_A }) as { content: { text: string }[] }
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ empty: true, remaining: 0 })
    expect(body.by_product).toBeUndefined()
  })

  it('returns correct remaining count for a product with jobs', async () => {
    mockPrisma.claudeJob.count.mockResolvedValue(2)
    const server = makeServer()
    const result = await server.call({ product_id: PRODUCT_A }) as { content: { text: string }[] }
    const body = JSON.parse(result.content[0].text)
    expect(body).toEqual({ empty: false, remaining: 2 })
  })

  it('returns error when user has no access to the product', async () => {
    mockUserCanAccessProduct.mockResolvedValue(false)
    const server = makeServer()
    const result = await server.call({ product_id: PRODUCT_A }) as { content: { text: string }[]; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not found or not accessible')
    expect(mockPrisma.claudeJob.count).not.toHaveBeenCalled()
  })
})

describe('check_queue_empty — demo user', () => {
  it('returns PERMISSION_DENIED error for demo accounts', async () => {
    mockRequireWriteAccess.mockRejectedValue(new PermissionDeniedError())
    const server = makeServer()
    const result = await server.call({}) as { content: { text: string }[]; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('PERMISSION_DENIED')
  })
})
