import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureContextTools } from './helpers/capture-context-tools.js'

const db = vi.hoisted(() => ({
  product: { findFirst: vi.fn() },
  sprint: { findFirst: vi.fn(), findMany: vi.fn() },
  story: { findFirst: vi.fn(), findMany: vi.fn() },
  task: { findFirst: vi.fn() },
  idea: { findMany: vi.fn() },
}))
const scopedProducts = vi.hoisted(() => ({ value: [] as string[] }))
vi.mock('../src/prisma.js', () => ({ prisma: db }))
vi.mock('../src/auth.js', () => ({
  getAuth: async () => ({ userId: 'user-1' }),
  getTokenScopedProducts: async () => scopedProducts.value,
  PermissionDeniedError: class extends Error {},
}))
vi.mock('../src/lib/agent-guide.js', () => ({
  resolveAgentGuide: async () => ({
    guide_md: 'GUIDE', has_product_override: false, product_doc: null,
    agent_context: { runtime: null, model_id: null, display_name: null, applied_profiles: [] },
  }),
}))
import { registerGetContextTool } from '../src/tools/get-context.js'

beforeEach(() => {
  vi.resetAllMocks()
  scopedProducts.value = []
  db.product.findFirst.mockResolvedValue({
    id: 'prod-1', code: 'P1', name: 'Test', description: null, repo_url: null,
    definition_of_done: null, enabled_doc_folders: [],
  })
  db.sprint.findFirst.mockResolvedValue(null)
  db.sprint.findMany.mockResolvedValue([
    { id: 's2', code: 'S-2', sprint_goal: 'Second', status: 'OPEN', start_date: null },
    { id: 's1', code: 'S-1', sprint_goal: 'First', status: 'OPEN', start_date: null },
  ])
  db.idea.findMany.mockResolvedValue([])
})

describe('compact product context', () => {
  it('returns every open sprint without reading stories, tasks or ideas', async () => {
    const tools = captureContextTools(registerGetContextTool)
    const data = await tools.json('get_claude_context', { product_id: 'prod-1' })
    expect(data.active_sprints?.map((s: { id: string }) => s.id)).toEqual(['s2', 's1'])
    expect(data).not.toHaveProperty('active_sprint')
    expect(data).not.toHaveProperty('next_story')
    expect(data).not.toHaveProperty('open_ideas')
    expect(db.story.findFirst).not.toHaveBeenCalled()
    expect(db.story.findMany).not.toHaveBeenCalled()
    expect(db.task.findFirst).not.toHaveBeenCalled()
    expect(db.idea.findMany).not.toHaveBeenCalled()
    expect(db.sprint.findMany).toHaveBeenCalledWith({
      where: { product_id: 'prod-1', status: 'OPEN' },
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      select: { id: true, code: true, sprint_goal: true, status: true, start_date: true },
    })
  })

  it('returns an empty sprint list when no sprint is open', async () => {
    db.sprint.findMany.mockResolvedValue([])
    const data = await captureContextTools(registerGetContextTool).json('get_claude_context', { product_id: 'prod-1' })
    expect(data.active_sprints).toEqual([])
  })

  it('refuses a product outside the token scope before reading its sprints', async () => {
    scopedProducts.value = ['another-product']
    const result = await captureContextTools(registerGetContextTool).call('get_claude_context', { product_id: 'prod-1' })
    expect(result.isError).toBe(true)
    expect(db.sprint.findMany).not.toHaveBeenCalled()
  })

  it('refuses an inaccessible product', async () => {
    db.product.findFirst.mockResolvedValue(null)
    const result = await captureContextTools(registerGetContextTool).call('get_claude_context', { product_id: 'missing' })
    expect(result.isError).toBe(true)
    expect(db.sprint.findMany).not.toHaveBeenCalled()
  })

  it('offers the old name as the same compact handler as get_context', async () => {
    const tools = captureContextTools(registerGetContextTool)
    expect(tools.handlers.get('get_context')).toBeTypeOf('function')
    expect(tools.handlers.get('get_claude_context')).toBe(tools.handlers.get('get_context'))
    expect(await tools.json('get_context', { product_id: 'P1' }))
      .toEqual(await tools.json('get_claude_context', { product_id: 'P1' }))
  })
})
