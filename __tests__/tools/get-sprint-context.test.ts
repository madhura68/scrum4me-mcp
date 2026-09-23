import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureContextTools } from '../helpers/capture-context-tools.js'

const db = vi.hoisted(() => ({
  sprint: { findUnique: vi.fn() }, story: { findMany: vi.fn() }, task: { findFirst: vi.fn() },
}))
const access = vi.hoisted(() => vi.fn())
vi.mock('../../src/prisma.js', () => ({ prisma: db }))
vi.mock('../../src/auth.js', () => ({ getAuth: async () => ({ userId: 'u1' }), PermissionDeniedError: class extends Error {} }))
vi.mock('../../src/access.js', () => ({ userCanAccessProduct: access }))
import { registerSharedTools } from '../../src/register.js'

beforeEach(() => {
  vi.resetAllMocks()
  access.mockResolvedValue(true)
  db.sprint.findUnique.mockResolvedValue({ id: 's1', code: 'S-1', product_id: 'p1', sprint_goal: 'Goal', status: 'CLOSED', start_date: null, end_date: null, completed_at: null })
  db.story.findMany.mockResolvedValue([
    { id: 'st1', code: 'ST-1', title: 'First', status: 'DONE', priority: 4, sort_order: 2, pbi: { id: 'pbi1', code: 'PBI-1', title: 'PBI' }, tasks: [
      { id: 't1', code: 'T-93', title: 'First task', priority: 4, sort_order: 1, status: 'DONE' },
      { id: 't2', code: 'T-19', title: 'Second task', priority: 1, sort_order: 2, status: 'REVIEW' },
    ] },
    { id: 'st2', code: 'ST-2', title: 'Second', status: 'FAILED', priority: 1, sort_order: 1, pbi: { id: 'pbi2', code: 'PBI-2', title: 'Other PBI' }, tasks: [
      { id: 't3', code: 'T-2', title: 'Excluded', priority: 1, sort_order: 1, status: 'EXCLUDED' },
    ] },
  ])
})

describe('get_sprint_context', () => {
  it('shows terminal stories/tasks with stored codes, without retrieving plans', async () => {
    const data = await captureContextTools(registerSharedTools).json('get_sprint_context', { sprint_id: 's1' })
    expect(data.sprint.status).toBe('CLOSED')
    expect(data.stories.map((s: { id: string }) => s.id)).toEqual(['st1', 'st2'])
    expect(data.stories[0].tasks.map((t: { code: string; status: string }) => [t.code, t.status])).toEqual([['T-93', 'done'], ['T-19', 'review']])
    expect(data.stories[1].tasks[0].status).toBe('excluded')
    expect(data.selected_task).toBeNull()
    expect(db.task.findFirst).not.toHaveBeenCalled()
    const query = db.story.findMany.mock.calls[0][0]
    expect(query.where).toEqual({ sprint_id: 's1', product_id: 'p1' })
    expect(query.orderBy).toEqual([
      { pbi: { sort_order: 'asc' } }, { pbi: { created_at: 'asc' } }, { pbi: { id: 'asc' } },
      { sort_order: 'asc' }, { created_at: 'asc' }, { id: 'asc' },
    ])
    expect(query.select.tasks.orderBy).toEqual([{ sort_order: 'asc' }, { created_at: 'asc' }, { id: 'asc' }])
    expect(query.select).not.toHaveProperty('description')
    expect(query.select).not.toHaveProperty('acceptance_criteria')
    expect(query.select.tasks.select).not.toHaveProperty('description')
    expect(query.select.tasks.select).not.toHaveProperty('implementation_plan')
  })

  it('retrieves exactly the selected full plan and its story context', async () => {
    const plan = 'complete plan\n'.repeat(8000)
    db.task.findFirst.mockResolvedValue({ id: 't2', code: 'T-19', title: 'Second task', status: 'REVIEW', description: 'Detail', implementation_plan: plan, repo_url: 'https://git.example/repo', story: { id: 'st1', description: 'Story details', acceptance_criteria: 'Acceptance' } })
    const data = await captureContextTools(registerSharedTools).json('get_sprint_context', { sprint_id: 's1', task_id: 't2' })
    expect(data.selected_task.implementation_plan).toBe(plan)
    expect(data.selected_task.story.acceptance_criteria).toBe('Acceptance')
    expect(data.selected_task.status).toBe('review')
    expect(db.task.findFirst).toHaveBeenCalledTimes(1)
    expect(db.task.findFirst.mock.calls[0][0].where).toEqual({ id: 't2', story: { sprint_id: 's1', product_id: 'p1' } })
  })

  it('keeps an absent selected plan null', async () => {
    db.task.findFirst.mockResolvedValue({ id: 't1', status: 'TO_DO', implementation_plan: null, story: { id: 'st1', description: null, acceptance_criteria: null } })
    const data = await captureContextTools(registerSharedTools).json('get_sprint_context', { sprint_id: 's1', task_id: 't1' })
    expect(data.selected_task.implementation_plan).toBeNull()
  })

  it('rejects a task outside the selected sprint without falling back', async () => {
    db.task.findFirst.mockResolvedValue(null)
    const result = await captureContextTools(registerSharedTools).call('get_sprint_context', { sprint_id: 's1', task_id: 'foreign' })
    expect(result.isError).toBe(true)
  })

  it.each(['missing', 'forbidden'])('does not query stories or plans for a %s sprint', async (kind) => {
    if (kind === 'missing') db.sprint.findUnique.mockResolvedValue(null)
    else access.mockResolvedValue(false)
    const result = await captureContextTools(registerSharedTools).call('get_sprint_context', { sprint_id: 's1', task_id: 't1' })
    expect(result.isError).toBe(true)
    expect(db.story.findMany).not.toHaveBeenCalled()
    expect(db.task.findFirst).not.toHaveBeenCalled()
  })
})
