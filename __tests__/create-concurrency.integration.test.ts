import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip
const authState = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(async () => ({ userId: authState.userId, tokenId: 'integration-test' })),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/access.js', () => ({
  userCanAccessProduct: vi.fn().mockResolvedValue(true),
}))

describeWithDatabase('create append concurrency (TEST_DATABASE_URL)', () => {
  let setupPool: Pool
  let setup: PrismaClient
  let productId: string
  let userId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl
    setupPool = new Pool({ connectionString: testDatabaseUrl })
    setup = new PrismaClient({ adapter: new PrismaPg(setupPool) })
    const suffix = randomUUID()
    const user = await setup.user.create({
      data: {
        username: `create-concurrency-${suffix}`,
        password_hash: 'test-only',
      },
    })
    userId = user.id
    authState.userId = user.id
    const product = await setup.product.create({
      data: {
        user_id: user.id,
        name: `create-concurrency-${suffix}`,
        definition_of_done: 'test',
      },
    })
    productId = product.id
  })

  afterAll(async () => {
    if (setup) {
      await setup.user.delete({ where: { id: userId } })
      await setup.$disconnect()
      await setupPool.end()
    }
  })

  it('lets two real create_pbi handlers generate unique codes and sibling positions', async () => {
    const { registerCreatePbiTool } = await import('../src/tools/create-pbi.js')
    let handler: ((input: Record<string, unknown>) => Promise<{
      isError?: boolean
      content?: Array<{ type: string; text: string }>
    }>) | undefined
    registerCreatePbiTool({
      registerTool: vi.fn((_name, _definition, callback) => { handler = callback }),
    } as never)

    const results = await Promise.all(['Concurrent A', 'Concurrent B'].map((title) =>
      handler!({ product_id: productId, title, priority: 2 }),
    ))

    expect(results.every((result) => result.isError !== true)).toBe(true)
    const payloads = results.map((result) => JSON.parse(result.content![0].text) as {
      code: string
      sort_order: number
    })
    expect(new Set(payloads.map((payload) => payload.code))).toEqual(new Set(['PBI-1', 'PBI-2']))
    expect(payloads.map((payload) => payload.sort_order).sort()).toEqual([1, 2])

    const rows = await setup.pbi.findMany({
      where: { product_id: productId },
      orderBy: { sort_order: 'asc' },
      select: { code: true, sort_order: true },
    })
    expect(rows.map((row) => row.sort_order)).toEqual([1, 2])
    expect(rows.map((row) => row.code)).toEqual(['PBI-1', 'PBI-2'])
  })
})
