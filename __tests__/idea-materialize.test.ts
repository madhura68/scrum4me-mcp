import { describe, it, expect, vi } from 'vitest'

import { materializeIdeaPlan, MaterializeError } from '../src/lib/idea-materialize.js'

const VALID_PLAN = `---
pbi:
  title: New PBI
  priority: 2
stories:
  - title: Story A
    priority: 4
    tasks:
      - title: Task A1
        priority: 1
        implementation_plan: "1. Doe X"
      - title: Task A2
        priority: 3
        implementation_plan: "1. Doe Y"
  - title: Story B
    priority: 1
    tasks:
      - title: Task B1
        priority: 4
        implementation_plan: "1. Doe Z"
---

body
`

function makeDb(idea: Record<string, unknown> | null) {
  const tx = {
    pbi: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'pbi-1', code: 'PBI-1' }),
      delete: vi.fn(),
    },
    story: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi
        .fn()
        .mockResolvedValueOnce({ id: 's-A' })
        .mockResolvedValueOnce({ id: 's-B' }),
    },
    task: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi
        .fn()
        .mockResolvedValueOnce({ id: 't-A1' })
        .mockResolvedValueOnce({ id: 't-A2' })
        .mockResolvedValueOnce({ id: 't-B1' }),
    },
    idea: { update: vi.fn() },
    ideaLog: { create: vi.fn() },
    pbiDoc: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    sprint: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'sprint-1' }) },
  }
  const db = {
    idea: { findFirst: vi.fn().mockResolvedValue(idea) },
    task: { count: vi.fn().mockResolvedValue(0) },
    pbi: { findUnique: vi.fn().mockResolvedValue(null) },
    reviewLog: { findFirst: vi.fn().mockResolvedValue(null) },
    productDoc: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  }
  return { db, tx }
}

describe('materializeIdeaPlan (mcp)', () => {
  it('weigert status buiten PLAN_READY/PLAN_REVIEWED', async () => {
    const { db } = makeDb({ id: 'idea-1', status: 'PLANNING', product_id: 'p1', plan_md: VALID_PLAN, pbi_id: null })
    await expect(
      materializeIdeaPlan(db as never, { ideaId: 'idea-1', userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'STATUS' })
  })

  it('maakt PBI + stories + tasks vanuit PLAN_REVIEWED en zet PLANNED', async () => {
    const { db, tx } = makeDb({ id: 'idea-1', status: 'PLAN_REVIEWED', product_id: 'p1', plan_md: VALID_PLAN, pbi_id: null })
    tx.story.findMany.mockResolvedValue([{ code: 'ST-020' }])
    tx.task.findMany.mockResolvedValue([{ code: 'T-40' }])
    const r = await materializeIdeaPlan(db as never, { ideaId: 'idea-1', userId: 'u1' })
    expect(r.pbi_code).toBe('PBI-1')
    expect(r.story_ids).toEqual(['s-A', 's-B'])
    expect(r.task_ids).toEqual(['t-A1', 't-A2', 't-B1'])
    expect(r.product_id).toBe('p1')
    expect(tx.pbi.findFirst).toHaveBeenCalledWith({
      where: { product_id: 'p1' },
      orderBy: [{ sort_order: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
      select: { sort_order: true },
    })
    expect(tx.story.create.mock.calls.map(([args]) => args.data.sort_order)).toEqual([1, 2])
    expect(tx.task.create.mock.calls.map(([args]) => args.data.sort_order)).toEqual([1, 2, 1])
    expect(tx.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PLANNED' }) }),
    )
  })

  it('weigert zonder plan_md', async () => {
    const { db } = makeDb({ id: 'idea-1', status: 'PLAN_READY', product_id: 'p1', plan_md: null, pbi_id: null })
    await expect(
      materializeIdeaPlan(db as never, { ideaId: 'idea-1', userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'NO_PLAN' })
  })

  it('gooit MaterializeError als klasse', async () => {
    const { db } = makeDb(null)
    await expect(
      materializeIdeaPlan(db as never, { ideaId: 'idea-1', userId: 'u1' }),
    ).rejects.toBeInstanceOf(MaterializeError)
  })
})

describe('M23 spiegel: pinning + buildSprint', () => {
  it('resolvePlanSource: gepinde approval ≠ current met andere content → STALE_PLAN', async () => {
    const { resolvePlanSource, MaterializeError } = await import('../src/lib/idea-materialize.js')
    const db = {
      productDoc: { findUnique: vi.fn().mockResolvedValue({
        current_revision_id: 'rev-3',
        current_revision: { id: 'rev-3', content_md: '# anders' },
      }) },
      reviewLog: { findFirst: vi.fn().mockResolvedValue({
        doc_revision_id: 'rev-2', doc_revision: { content_md: '# origineel' },
      }) },
    }
    await expect(resolvePlanSource(db as never, {
      id: 'i1', status: 'PLAN_REVIEWED' as never, plan_md: null, plan_doc_id: 'pd-1',
    })).rejects.toBeInstanceOf(MaterializeError)
  })
})
