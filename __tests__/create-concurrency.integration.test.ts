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

  // Both retry wrappers once matched error shapes that Prisma 7 + the pg driver
  // adapter never produce (`meta.target` for P2002; P2034 for a commit-time
  // 40001), which silently turned every bounded retry into a single attempt.
  // A hand-built error object cannot catch that regression — only one Postgres
  // actually raised can. Hence: assert against captured, real errors.
  describe('retry wrappers against real Postgres errors', () => {
    let scopedProductId: string

    beforeAll(async () => {
      const product = await setup.product.create({
        data: {
          user_id: userId,
          name: `retry-shapes-${randomUUID()}`,
          definition_of_done: 'test',
        },
      })
      scopedProductId = product.id
    })

    it('retries a unique-code conflict the database really raised', async () => {
      const { withCodeUniqueRetry } = await import('../src/lib/code-unique-retry.js')
      await setup.pbi.create({
        data: { product_id: scopedProductId, code: 'PBI-1', title: 'first', priority: 2, sort_order: 1 },
      })
      let captured: unknown
      try {
        await setup.pbi.create({
          data: { product_id: scopedProductId, code: 'PBI-1', title: 'dup', priority: 2, sort_order: 2 },
        })
      } catch (error) { captured = error }
      expect(captured).toBeDefined()

      let attempts = 0
      const result = await withCodeUniqueRetry('pbis_product_id_code_key', async () => {
        attempts += 1
        if (attempts === 1) throw captured
        return 'recovered'
      })

      expect(attempts).toBe(2)
      expect(result).toBe('recovered')
    })

    it('retries a serialization failure the database really raised', async () => {
      process.env.DATABASE_URL = testDatabaseUrl
      const { withSerializableRetry } = await import('../src/lib/serializable-transaction.js')
      const a = await setup.pbi.create({
        data: { product_id: scopedProductId, code: 'PBI-10', title: 'a', priority: 2, sort_order: 10 },
      })
      const b = await setup.pbi.create({
        data: { product_id: scopedProductId, code: 'PBI-11', title: 'b', priority: 2, sort_order: 11 },
      })

      // Write skew: each side reads the row the other writes. Only the first
      // attempt of each side stalls, so they overlap exactly once and the
      // retries are free to finish.
      const skew = (readId: string, writeId: string) => {
        let attempt = 0
        return withSerializableRetry(async (tx) => {
          attempt += 1
          await tx.pbi.findMany({ where: { id: readId }, select: { priority: true } })
          if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 300))
          await tx.pbi.update({ where: { id: writeId }, data: { priority: 3 } })
        })
      }

      const settled = await Promise.allSettled([skew(b.id, a.id), skew(a.id, b.id)])

      expect(settled.map((entry) => entry.status)).toEqual(['fulfilled', 'fulfilled'])
    }, 20000)
  })
})
