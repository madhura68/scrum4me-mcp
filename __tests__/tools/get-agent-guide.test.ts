import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuth, mockProductFindFirst, mockResolveAgentGuide } = vi.hoisted(() => ({
  mockGetAuth: vi.fn(),
  mockProductFindFirst: vi.fn(),
  mockResolveAgentGuide: vi.fn(),
}))

vi.mock('../../src/auth.js', () => ({
  getAuth: mockGetAuth,
  // errors.js (real) references PermissionDeniedError via instanceof.
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))

vi.mock('../../src/prisma.js', () => ({
  prisma: { product: { findFirst: mockProductFindFirst } },
}))

vi.mock('../../src/lib/agent-guide.js', () => ({
  resolveAgentGuide: mockResolveAgentGuide,
}))

import { registerGetAgentGuideTool } from '../../src/tools/get-agent-guide.js'

function makeServer() {
  let handler: ((args: Record<string, unknown>) => Promise<any>) | null = null
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
  mockGetAuth.mockResolvedValue({ userId: 'u1' })
  mockProductFindFirst.mockResolvedValue({
    id: 'p1',
    code: 'P1',
    name: 'Test',
    enabled_doc_folders: ['MANUAL'],
  })
  mockResolveAgentGuide.mockResolvedValue({
    guide_md: 'MERGED GUIDE',
    has_product_override: true,
    product_doc: { slug: 'agent-guide', status: 'active', updated_at: new Date() },
  })
})

describe('get_agent_guide tool', () => {
  it('returns the resolved guide for an accessible product', async () => {
    const server = makeServer()
    registerGetAgentGuideTool(server as never)
    const res = await server.call({ product_id: 'p1' })
    expect(res.isError).toBeFalsy()
    expect(JSON.parse(res.content[0].text).guide_md).toBe('MERGED GUIDE')
  })

  it('errors and skips the resolver when the product is not accessible', async () => {
    mockProductFindFirst.mockResolvedValue(null)
    const server = makeServer()
    registerGetAgentGuideTool(server as never)
    const res = await server.call({ product_id: 'nope' })
    expect(res.isError).toBe(true)
    expect(mockResolveAgentGuide).not.toHaveBeenCalled()
  })

  it('hard-fails (isError) when the merged guide is too large', async () => {
    mockResolveAgentGuide.mockRejectedValue(
      new Error('AGENT_GUIDE_TOO_LARGE: merged guide is 20000 chars (max 16000)'),
    )
    const server = makeServer()
    registerGetAgentGuideTool(server as never)
    const res = await server.call({ product_id: 'p1' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('AGENT_GUIDE_TOO_LARGE')
  })
})
