import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockProductFindFirst,
  mockSprintFindFirst,
  mockStoryFindFirst,
  mockTodoFindMany,
} = vi.hoisted(() => ({
  mockProductFindFirst: vi.fn(),
  mockSprintFindFirst: vi.fn(),
  mockStoryFindFirst: vi.fn(),
  mockTodoFindMany: vi.fn(),
}))

vi.mock('../src/auth.js', () => ({
  getAuth: vi.fn().mockResolvedValue({ userId: 'user-1', isDemo: false }),
}))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    product: { findFirst: mockProductFindFirst },
    sprint: { findFirst: mockSprintFindFirst },
    story: { findFirst: mockStoryFindFirst },
    todo: { findMany: mockTodoFindMany },
  },
}))

vi.mock('../src/errors.js', () => ({
  toolError: vi.fn((msg: string) => ({ isError: true, content: [{ type: 'text', text: msg }] })),
  toolJson: vi.fn((data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })),
  withToolErrors: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}))

import { registerGetClaudeContextTool } from '../src/tools/get-claude-context.js'

// Minimal McpServer stub that captures the registered handler
function makeServer() {
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null
  const server = {
    registerTool: vi.fn((_name: string, _def: unknown, h: typeof handler) => {
      handler = h
    }),
    call: async (args: Record<string, unknown>) => {
      if (!handler) throw new Error('tool not registered')
      return handler(args)
    },
  }
  return server
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProductFindFirst.mockResolvedValue({
    id: 'prod-1', code: 'P1', name: 'Test', description: null, repo_url: null, definition_of_done: null,
  })
  mockSprintFindFirst.mockResolvedValue({ id: 'sprint-1', sprint_goal: 'Goal', status: 'ACTIVE' })
  mockStoryFindFirst.mockResolvedValue(null)
  mockTodoFindMany.mockResolvedValue([])
})

describe('get_claude_context safety-net filter', () => {
  it('passes OR tasks filter in next-story query', async () => {
    const server = makeServer()
    registerGetClaudeContextTool(server as never)
    await server.call({ product_id: 'prod-1' })

    expect(mockStoryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { tasks: { none: {} } },
            { tasks: { some: { status: { not: 'DONE' } } } },
          ],
        }),
      }),
    )
  })

  it('still filters on sprint_id and status', async () => {
    const server = makeServer()
    registerGetClaudeContextTool(server as never)
    await server.call({ product_id: 'prod-1' })

    expect(mockStoryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sprint_id: 'sprint-1',
          status: { in: ['OPEN', 'IN_SPRINT'] },
        }),
      }),
    )
  })

  it('does not query next story when no active sprint', async () => {
    mockSprintFindFirst.mockResolvedValue(null)
    const server = makeServer()
    registerGetClaudeContextTool(server as never)
    await server.call({ product_id: 'prod-1' })

    expect(mockStoryFindFirst).not.toHaveBeenCalled()
  })
})
