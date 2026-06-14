import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { claudeQuestion: { findMany: vi.fn().mockResolvedValue([]) } },
}))
vi.mock('../src/auth.js', () => ({ getAuth: vi.fn() }))
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { getAuth } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'

// We test via the server's tool handler — register and invoke inline
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerListIdeaQuestionsTool } from '../src/tools/list-idea-questions.js'

const mockFindMany = prisma.claudeQuestion.findMany as ReturnType<typeof vi.fn>
const mockGetAuth = getAuth as ReturnType<typeof vi.fn>
const mockAccess = userCanAccessProduct as ReturnType<typeof vi.fn>

// Minimal McpServer stub: capture the registered handler and call it directly.
function makeStub() {
  let handler: ((input: Record<string, unknown>) => Promise<unknown>) | undefined
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, h: typeof handler) => {
      handler = h
    }),
  } as unknown as McpServer
  registerListIdeaQuestionsTool(server)
  return {
    call: (input: Record<string, unknown>) => {
      if (!handler) throw new Error('handler not registered')
      return handler(input)
    },
  }
}

const stub = makeStub()

const NOW = new Date('2026-01-15T12:00:00Z')
const FUTURE = new Date('2026-12-31T00:00:00Z')

const SAMPLE_ROW = {
  id: 'q-1',
  idea_id: 'idea-1',
  question: 'Welke kleur?',
  options: ['Rood', 'Blauw'],
  created_at: NOW,
  expires_at: FUTURE,
  idea: { code: 'IDEA-001', title: 'Mijn idee' },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetAuth.mockResolvedValue({ userId: 'user-1' })
  mockAccess.mockResolvedValue(true)
  mockFindMany.mockResolvedValue([])
})

it('geeft open vraag terug met idea_code/idea_title', async () => {
  mockFindMany.mockResolvedValue([SAMPLE_ROW])
  const res = await stub.call({ product_id: 'prod-1' }) as { content: { text: string }[]; isError?: boolean }
  expect(res.isError).toBeFalsy()
  const body = JSON.parse(res.content[0].text)
  expect(body.count).toBe(1)
  const q = body.questions[0]
  expect(q.question_id).toBe('q-1')
  expect(q.idea_code).toBe('IDEA-001')
  expect(q.idea_title).toBe('Mijn idee')
  expect(q.options).toEqual(['Rood', 'Blauw'])
})

it('filtert op user_id en product_id via idea relation-WHERE', async () => {
  await stub.call({ product_id: 'prod-1' })
  expect(mockFindMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        product_id: 'prod-1',
        status: 'open',
        idea: { is: { user_id: 'user-1', product_id: 'prod-1' } },
      }),
    }),
  )
})

it('geeft lege lijst wanneer er geen open vragen zijn', async () => {
  const res = await stub.call({ product_id: 'prod-1' }) as { content: { text: string }[]; isError?: boolean }
  expect(res.isError).toBeFalsy()
  const body = JSON.parse(res.content[0].text)
  expect(body.count).toBe(0)
  expect(body.questions).toEqual([])
})

it('vraag op idee van andere user/product → via scope-guard of relation-WHERE leeg', async () => {
  // Simulate: findMany returns empty because idea belongs to different user
  mockFindMany.mockResolvedValue([])
  const res = await stub.call({ product_id: 'prod-1' }) as { content: { text: string }[]; isError?: boolean }
  expect(res.isError).toBeFalsy()
  const body = JSON.parse(res.content[0].text)
  expect(body.count).toBe(0)
})

it('token gescoped op X + product_id=Y → Product Y not found or not accessible', async () => {
  mockAccess.mockResolvedValue(false)
  const res = await stub.call({ product_id: 'prod-y' }) as { content: { text: string }[]; isError?: boolean }
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/Product prod-y not found or not accessible/)
  // No DB query issued
  expect(mockFindMany).not.toHaveBeenCalled()
})

it('scope-guard is de eerste check: DB wordt niet aangeroepen bij geweigerd product', async () => {
  mockAccess.mockResolvedValue(false)
  await stub.call({ product_id: 'prod-z' })
  expect(mockFindMany).not.toHaveBeenCalled()
})
