import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    task: { findUnique: vi.fn() },
    story: { findUnique: vi.fn() },
    sprint: { findUnique: vi.fn() },
  },
}))

import { prisma } from '../src/prisma.js'
import {
  extractWorkItemIds,
  mergeWorkItemInputs,
  resolveWorkItem,
} from '../src/queue/work-item.js'
import type { AnyMock } from './helpers/mocks.js'

const mockTask = prisma.task.findUnique as AnyMock
const mockStory = prisma.story.findUnique as AnyMock
const mockSprint = prisma.sprint.findUnique as AnyMock

beforeEach(() => vi.clearAllMocks())

describe('extractWorkItemIds', () => {
  it('leest alleen de drie id-sleutels als string; product_id en rommel vervallen', () => {
    expect(
      extractWorkItemIds({
        task_id: 't1', story_id: 's1', sprint_id: 'sp1',
        product_id: 'vervalst', extra: 1, nested: { task_id: 'nee' },
      }),
    ).toEqual({ task_id: 't1', story_id: 's1', sprint_id: 'sp1' })
  })
  it('geeft {} voor non-object, lege of id-loze input', () => {
    expect(extractWorkItemIds(undefined)).toEqual({})
    expect(extractWorkItemIds('x')).toEqual({})
    expect(extractWorkItemIds({ product_id: 'p' })).toEqual({})
    expect(extractWorkItemIds({ task_id: '' })).toEqual({})
    expect(extractWorkItemIds({ task_id: 42 })).toEqual({})
  })
})

describe('mergeWorkItemInputs', () => {
  it('verenigt disjuncte en gelijke sleutels', () => {
    expect(mergeWorkItemInputs({ task_id: 't1' }, { story_id: 's1', task_id: 't1' }))
      .toEqual({ task_id: 't1', story_id: 's1' })
  })
  it('gooit VALIDATION_ERROR bij conflict parameter↔blok', () => {
    expect(() => mergeWorkItemInputs({ task_id: 't1' }, { task_id: 't2' }))
      .toThrow(/VALIDATION_ERROR.*task_id/)
  })
})

describe('resolveWorkItem', () => {
  it('geeft null bij lege input en raakt de DB niet aan', async () => {
    expect(await resolveWorkItem({})).toBeNull()
    expect(mockTask).not.toHaveBeenCalled()
    expect(mockStory).not.toHaveBeenCalled()
    expect(mockSprint).not.toHaveBeenCalled()
  })

  it('task_id: sprint én product komen uit de Story, in één findUnique met story-select', async () => {
    mockTask.mockResolvedValue({
      story_id: 's1',
      story: { sprint_id: 'sp1', product_id: 'p1' },
    })
    const block = await resolveWorkItem({ task_id: 't1' })
    expect(block).toEqual({ product_id: 'p1', sprint_id: 'sp1', story_id: 's1', task_id: 't1' })
    // De select mag de gedenormaliseerde Task-kolommen niet lezen (spec §4):
    const select = (mockTask.mock.calls[0][0] as { select: Record<string, unknown> }).select
    expect(select).not.toHaveProperty('sprint_id')
    expect(select).not.toHaveProperty('product_id')
    expect(select).toHaveProperty('story')
    expect(mockStory).not.toHaveBeenCalled()
    expect(mockSprint).not.toHaveBeenCalled()
  })

  it('task in story zonder sprint → blok zonder sprint_id-sleutel', async () => {
    mockTask.mockResolvedValue({ story_id: 's1', story: { sprint_id: null, product_id: 'p1' } })
    const block = await resolveWorkItem({ task_id: 't1' })
    expect(block).toEqual({ product_id: 'p1', story_id: 's1', task_id: 't1' })
    expect(block).not.toHaveProperty('sprint_id')
  })

  it('story_id: sprint (nullable) en product uit de Story', async () => {
    mockStory.mockResolvedValue({ sprint_id: null, product_id: 'p1' })
    expect(await resolveWorkItem({ story_id: 's1' }))
      .toEqual({ product_id: 'p1', story_id: 's1' })
  })

  it('sprint_id alleen: product uit de Sprint', async () => {
    mockSprint.mockResolvedValue({ product_id: 'p1' })
    expect(await resolveWorkItem({ sprint_id: 'sp1' }))
      .toEqual({ product_id: 'p1', sprint_id: 'sp1' })
  })

  it('onbestaand id → VALIDATION_ERROR met het veld erin', async () => {
    mockTask.mockResolvedValue(null)
    await expect(resolveWorkItem({ task_id: 'weg' })).rejects.toThrow(/VALIDATION_ERROR.*task_id.*weg/)
    mockStory.mockResolvedValue(null)
    await expect(resolveWorkItem({ story_id: 'weg' })).rejects.toThrow(/VALIDATION_ERROR.*story_id.*weg/)
    mockSprint.mockResolvedValue(null)
    await expect(resolveWorkItem({ sprint_id: 'weg' })).rejects.toThrow(/VALIDATION_ERROR.*sprint_id.*weg/)
  })

  it('task hoort niet bij gegeven story → VALIDATION_ERROR met beide kanten', async () => {
    mockTask.mockResolvedValue({ story_id: 's-echt', story: { sprint_id: null, product_id: 'p1' } })
    await expect(resolveWorkItem({ task_id: 't1', story_id: 's-anders' }))
      .rejects.toThrow(/VALIDATION_ERROR.*s-echt.*s-anders/)
  })

  it('afgeleide sprint ≠ gegeven sprint → VALIDATION_ERROR', async () => {
    mockTask.mockResolvedValue({ story_id: 's1', story: { sprint_id: 'sp-echt', product_id: 'p1' } })
    await expect(resolveWorkItem({ task_id: 't1', sprint_id: 'sp-anders' }))
      .rejects.toThrow(/VALIDATION_ERROR.*sp-echt.*sp-anders/)
  })

  it('sprint gegeven maar story zit niet in een sprint → VALIDATION_ERROR', async () => {
    mockStory.mockResolvedValue({ sprint_id: null, product_id: 'p1' })
    await expect(resolveWorkItem({ story_id: 's1', sprint_id: 'sp1' }))
      .rejects.toThrow(/VALIDATION_ERROR.*niet in een sprint/)
  })

  it('story_id + kloppende sprint_id: geen extra sprint-query', async () => {
    mockStory.mockResolvedValue({ sprint_id: 'sp1', product_id: 'p1' })
    expect(await resolveWorkItem({ story_id: 's1', sprint_id: 'sp1' }))
      .toEqual({ product_id: 'p1', sprint_id: 'sp1', story_id: 's1' })
    expect(mockSprint).not.toHaveBeenCalled()
  })
})
