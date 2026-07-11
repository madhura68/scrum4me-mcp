import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip

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

  it('serializes two concurrent append transactions into distinct sibling positions', async () => {
    const { withSerializableRetry } = await import('../src/lib/serializable-transaction.js')

    await Promise.all(['PBI-CONCURRENT-A', 'PBI-CONCURRENT-B'].map((code) =>
      withSerializableRetry(async (tx) => {
        const last = await tx.pbi.findFirst({
          where: { product_id: productId },
          orderBy: [{ sort_order: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
          select: { sort_order: true },
        })
        await tx.pbi.create({
          data: {
            product_id: productId,
            code,
            title: code,
            priority: 2,
            sort_order: (last?.sort_order ?? 0) + 1,
          },
        })
      }),
    ))

    const rows = await setup.pbi.findMany({
      where: { product_id: productId },
      orderBy: { sort_order: 'asc' },
      select: { sort_order: true },
    })
    expect(rows.map((row) => row.sort_order)).toEqual([1, 2])
  })
})
