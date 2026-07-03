import { it, expect, vi, beforeEach } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const txMocks = vi.hoisted(() => ({
  idea: { update: vi.fn() },
  ideaChatMessage: { create: vi.fn() },
  ideaLog: { create: vi.fn() },
}))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    idea: { findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMocks)),
  },
}))
vi.mock('../src/lib/product-doc-write.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeProductDoc: vi.fn().mockResolvedValue({
    doc_id: 'doc-1',
    revision_id: 'rev-1',
    revision: 1,
    noop: false,
  }),
}))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(),
  PermissionDeniedError: class PermissionDeniedError extends Error {
    constructor(message = 'Demo accounts cannot perform write operations') {
      super(message)
      this.name = 'PermissionDeniedError'
    }
  },
}))
vi.mock('../src/access.js', () => ({
  userOwnsIdea: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { userOwnsIdea } from '../src/access.js'
import { registerUpdateIdeaGrillMdTool } from '../src/tools/update-idea-grill-md.js'

const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockOwns = userOwnsIdea as ReturnType<typeof vi.fn>
const mockFindUnique = (prisma as unknown as { idea: { findUnique: ReturnType<typeof vi.fn> } })
  .idea.findUnique

// Capture the tool handler the way register() installs it.
type Handler = (input: { idea_id: string; markdown: string; product_id?: string }) => Promise<CallToolResult>
function captureHandler(): Handler {
  let handler: Handler | undefined
  const server = {
    registerTool: (_name: string, _meta: unknown, fn: Handler) => {
      handler = fn
    },
  }
  registerUpdateIdeaGrillMdTool(server as never)
  if (!handler) throw new Error('handler not registered')
  return handler
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'user-1', isDemo: false })
  mockOwns.mockResolvedValue(true)
  mockFindUnique.mockResolvedValue({
    id: 'idea-1',
    code: 'IDEA-042',
    user_id: 'user-1',
    product_id: 'prod-1',
    title: 'T',
  })
})

it('weigert wanneer het meegegeven product_id niet bij het idee hoort (cross-product)', async () => {
  const handler = captureHandler()
  const res = await handler({ idea_id: 'idea-1', markdown: '# grill', product_id: 'prod-OTHER' })
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/not found/i)
})

it('schrijft het grill-resultaat als ASSISTANT/GRILL_RESULT-kanaalbericht, niet meer als IdeaLog (M17)', async () => {
  txMocks.idea.update.mockResolvedValue({ id: 'idea-1', status: 'GRILLED', code: 'IDEA-042' })
  txMocks.ideaChatMessage.create.mockResolvedValue({ id: 'msg-1' })
  const handler = captureHandler()

  const res = await handler({ idea_id: 'idea-1', markdown: '# grill\n\nVolledige inhoud.' })

  expect(res.isError).toBeFalsy()
  expect(txMocks.ideaChatMessage.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      idea_id: 'idea-1',
      role: 'ASSISTANT',
      kind: 'GRILL_RESULT',
      content: '# grill\n\nVolledige inhoud.',
      metadata: expect.objectContaining({ doc_id: 'doc-1', revision: 1 }),
    }),
  })
  // Dubbel-render-preventie (spec §3): géén IdeaLog GRILL_RESULT meer.
  expect(txMocks.ideaLog.create).not.toHaveBeenCalled()
})
