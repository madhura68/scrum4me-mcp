import { describe, it, expect, vi } from 'vitest'

import { materializeIdeaPlan, MaterializeError } from '../src/lib/idea-materialize.js'

const VALID_PLAN = `---
pbi:
  title: New PBI
  priority: 2
stories:
  - title: Story A
    priority: 2
    tasks:
      - title: Task A1
        priority: 2
        implementation_plan: "1. Doe X"
      - title: Task A2
        priority: 2
  - title: Story B
    priority: 3
    tasks:
      - title: Task B1
        priority: 3
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
  }
  const db = {
    idea: { findFirst: vi.fn().mockResolvedValue(idea) },
    task: { count: vi.fn().mockResolvedValue(0) },
    pbi: { findUnique: vi.fn().mockResolvedValue(null) },
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
    const r = await materializeIdeaPlan(db as never, { ideaId: 'idea-1', userId: 'u1' })
    expect(r.pbi_code).toBe('PBI-1')
    expect(r.story_ids).toEqual(['s-A', 's-B'])
    expect(r.task_ids).toEqual(['t-A1', 't-A2', 't-B1'])
    expect(r.product_id).toBe('p1')
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
