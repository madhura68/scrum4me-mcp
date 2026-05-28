import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/prisma.js', () => ({
  prisma: {
    story: { findFirst: vi.fn(), findMany: vi.fn() },
    task: { findFirst: vi.fn(), findMany: vi.fn() },
    product: { findFirst: vi.fn() },
  },
}))

import { prisma } from '../../src/prisma.js'
import { resolveStoryRef, resolveTaskRef, resolveProductRef } from '../../src/lib/resolve-entity.js'

const P = prisma as unknown as {
  story: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }
  task: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }
  product: { findFirst: ReturnType<typeof vi.fn> }
}

beforeEach(() => vi.clearAllMocks())

describe('resolveStoryRef', () => {
  it('returns the id when given a valid CUID', async () => {
    P.story.findFirst.mockResolvedValueOnce({ id: 'cmp_story_1' })
    expect(await resolveStoryRef('cmp_story_1', 'u1')).toEqual({ id: 'cmp_story_1' })
  })

  it('resolves a story code to its id', async () => {
    P.story.findFirst.mockResolvedValueOnce(null)            // id miss
    P.story.findMany.mockResolvedValueOnce([{ id: 'cmp_story_2' }]) // code hit
    expect(await resolveStoryRef('ST-1427', 'u1')).toEqual({ id: 'cmp_story_2' })
  })

  it('hints when a task code is passed where a story is expected', async () => {
    P.story.findFirst.mockResolvedValueOnce(null)
    P.story.findMany.mockResolvedValueOnce([])
    P.task.findFirst.mockResolvedValueOnce({ id: 'cmp_task_9' }) // it's a task code
    const r = await resolveStoryRef('T-1219', 'u1')
    expect('error' in r && /task code/.test(r.error)).toBe(true)
  })

  it('errors when nothing matches', async () => {
    P.story.findFirst.mockResolvedValueOnce(null)
    P.story.findMany.mockResolvedValueOnce([])
    P.task.findFirst.mockResolvedValueOnce(null)
    const r = await resolveStoryRef('nope', 'u1')
    expect('error' in r && /not found or not accessible/.test(r.error)).toBe(true)
  })
})

describe('resolveProductRef', () => {
  it('resolves a product code/name miss to id via code', async () => {
    P.product.findFirst.mockResolvedValueOnce(null)             // id miss
    P.product.findFirst.mockResolvedValueOnce({ id: 'cmp_prod_1' }) // code hit
    expect(await resolveProductRef('scrum4me', 'u1')).toEqual({ id: 'cmp_prod_1' })
  })
})
