import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockProductFindFirst,
  mockSprintFindFirst,
  mockStoryFindFirst,
  mockIdeaFindMany,
  mockResolveAgentGuide,
} = vi.hoisted(() => ({
  mockProductFindFirst: vi.fn(),
  mockSprintFindFirst: vi.fn(),
  mockStoryFindFirst: vi.fn(),
  mockIdeaFindMany: vi.fn(),
  mockResolveAgentGuide: vi.fn(),
}))

vi.mock('../../src/auth.js', () => ({
  getAuth: vi.fn().mockResolvedValue({ userId: 'u1', isDemo: false }),
  getTokenScopedProducts: async () => [],
}))

vi.mock('../../src/prisma.js', () => ({
  prisma: {
    product: { findFirst: mockProductFindFirst },
    sprint: { findMany: mockSprintFindFirst },
    story: { findFirst: mockStoryFindFirst },
    idea: { findMany: mockIdeaFindMany },
  },
}))

vi.mock('../../src/errors.js', () => ({
  toolError: vi.fn((msg: string) => ({ isError: true, content: [{ type: 'text', text: msg }] })),
  toolJson: vi.fn((data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })),
  withToolErrors: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

vi.mock('../../src/lib/agent-guide.js', () => ({
  resolveAgentGuide: mockResolveAgentGuide,
}))

import { registerGetContextTool } from '../../src/tools/get-context.js'

function makeServer() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | null = null
  const server = {
    registerTool: vi.fn((_n: string, _d: unknown, h: typeof handler) => {
      handler = h
    }),
    call: async (args: Record<string, unknown>) => handler!(args),
  }
  return server
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProductFindFirst.mockResolvedValue({
    id: 'p1', code: 'P1', name: 'Test', description: null, repo_url: null,
    definition_of_done: null, enabled_doc_folders: ['MANUAL'],
  })
  mockSprintFindFirst.mockResolvedValue([])
  mockStoryFindFirst.mockResolvedValue(null)
  mockIdeaFindMany.mockResolvedValue([])
})

describe('get_context agent_guide field', () => {
  it('includes the resolved guide on success', async () => {
    mockResolveAgentGuide.mockResolvedValue({
      guide_md: 'GUIDE', has_product_override: false, product_doc: null,
      agent_context: { runtime: null, model_id: null, display_name: null, applied_profiles: [] },
    })
    const server = makeServer()
    registerGetContextTool(server as never)
    const res = await server.call({ product_id: 'p1' })
    const data = JSON.parse(res.content[0].text)
    expect(data.agent_guide).toBe('GUIDE')
    expect(data.agent_guide_error).toBeNull()
    expect(data.agent_context.applied_profiles).toEqual([])
  })

  it('degrades to null + error string instead of failing the whole call', async () => {
    mockResolveAgentGuide.mockRejectedValue(new Error('AGENT_GUIDE_TOO_LARGE: too big'))
    const server = makeServer()
    registerGetContextTool(server as never)
    const res = await server.call({ product_id: 'p1', agent: { runtime: 'CODEX', model_id: 'gpt-6-astra' } })
    expect(res.isError).toBeFalsy()
    const data = JSON.parse(res.content[0].text)
    expect(data.agent_guide).toBeNull()
    expect(data.agent_guide_error).toContain('AGENT_GUIDE_TOO_LARGE')
    expect(data.agent_context).toEqual({ runtime: 'CODEX', model_id: 'gpt-6-astra', display_name: null, applied_profiles: null })
  })

  it('normalizes and forwards identity without retaining the previous call', async () => {
    mockResolveAgentGuide.mockResolvedValue({ guide_md: 'GUIDE', agent_context: {} })
    const server = makeServer()
    registerGetContextTool(server as never)
    await server.call({ product_id: 'p1', agent: { runtime: 'CODEX', model_id: '  gpt-6-astra  ' } })
    expect(mockResolveAgentGuide).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'p1' }), { runtime: 'CODEX', model_id: 'gpt-6-astra' })
    await server.call({ product_id: 'p1' })
    expect(mockResolveAgentGuide).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'p1' }), undefined)
  })
})
