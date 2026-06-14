import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeQuestion: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
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
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess, PermissionDeniedError } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAnswerQuestionTool } from '../src/tools/answer-question.js'

const mockFindUnique = prisma.claudeQuestion.findUnique as ReturnType<typeof vi.fn>
const mockUpdateMany = prisma.claudeQuestion.updateMany as ReturnType<typeof vi.fn>
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockAccess = userCanAccessProduct as ReturnType<typeof vi.fn>

// Minimal McpServer stub — capture and expose the registered handler.
function makeStub() {
  let handler: ((input: Record<string, unknown>) => Promise<unknown>) | undefined
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, h: typeof handler) => {
      handler = h
    }),
  } as unknown as McpServer
  registerAnswerQuestionTool(server)
  return {
    call: (input: Record<string, unknown>) => {
      if (!handler) throw new Error('handler not registered')
      return handler(input)
    },
  }
}

const stub = makeStub()

const OPEN_QUESTION = {
  idea_id: 'idea-1',
  options: null,
  idea: { user_id: 'user-1', product_id: 'prod-1' },
}

const OPEN_QUESTION_WITH_OPTIONS = {
  idea_id: 'idea-1',
  options: ['A', 'B'],
  idea: { user_id: 'user-1', product_id: 'prod-1' },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'user-1', isDemo: false })
  mockAccess.mockResolvedValue(true)
  mockFindUnique.mockResolvedValue(OPEN_QUESTION)
  mockUpdateMany.mockResolvedValue({ count: 1 })
})

// (a) Happy path: open vraag op binding-idee → ok, DB status='answered'
it('(a) antwoordt open vraag op binding-idee, DB updated status=answered', async () => {
  const res = await stub.call({
    question_id: 'q-1',
    product_id: 'prod-1',
    answer: 'Mijn antwoord',
  }) as { content: { text: string }[]; isError?: boolean }
  expect(res.isError).toBeFalsy()
  const body = JSON.parse(res.content[0].text)
  expect(body.ok).toBe(true)
  expect(body.question_id).toBe('q-1')
  // DB write: updateMany must be called with answered fields
  expect(mockUpdateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        id: 'q-1',
        status: 'open',
        idea: { is: { user_id: 'user-1', product_id: 'prod-1' } },
      }),
      data: expect.objectContaining({
        status: 'answered',
        answer: 'Mijn antwoord',
        answered_by: 'user-1',
      }),
    }),
  )
})

// (b) Vraag op idee van andere user/product → 'Question not found', geen write
it('(b) vraag op idee van andere user → Question not found, geen DB write', async () => {
  mockFindUnique.mockResolvedValue({
    idea_id: 'idea-x',
    options: null,
    idea: { user_id: 'other-user', product_id: 'prod-1' },
  })
  const res = await stub.call({
    question_id: 'q-x',
    product_id: 'prod-1',
    answer: 'poging',
  }) as { content: { text: string }[]; isError?: boolean }
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/Question not found/)
  expect(mockUpdateMany).not.toHaveBeenCalled()
})

it('(b) vraag op idee van ander product → Question not found, geen DB write', async () => {
  mockFindUnique.mockResolvedValue({
    idea_id: 'idea-1',
    options: null,
    idea: { user_id: 'user-1', product_id: 'prod-other' },
  })
  const res = await stub.call({
    question_id: 'q-1',
    product_id: 'prod-1',
    answer: 'poging',
  }) as { content: { text: string }[]; isError?: boolean }
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/Question not found/)
  expect(mockUpdateMany).not.toHaveBeenCalled()
})

it('(b) question niet gevonden (null) → Question not found, geen DB write', async () => {
  mockFindUnique.mockResolvedValue(null)
  const res = await stub.call({
    question_id: 'q-gone',
    product_id: 'prod-1',
    answer: 'poging',
  }) as { content: { text: string }[]; isError?: boolean }
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/Question not found/)
  expect(mockUpdateMany).not.toHaveBeenCalled()
})

// (c) Dubbel/expired → 'Question already answered or expired'
it('(c) dubbel antwoorden (updateMany.count=0) → already answered or expired', async () => {
  mockUpdateMany.mockResolvedValue({ count: 0 })
  const res = await stub.call({
    question_id: 'q-1',
    product_id: 'prod-1',
    answer: 'tweede poging',
  }) as { content: { text: string }[]; isError?: boolean }
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/Question already answered or expired/)
})

// (d) Options=['A','B']: answer='C' → Invalid answer option, geen write
it("(d) options=['A','B'], answer='C' → Invalid answer option, geen DB write", async () => {
  mockFindUnique.mockResolvedValue(OPEN_QUESTION_WITH_OPTIONS)
  const res = await stub.call({
    question_id: 'q-1',
    product_id: 'prod-1',
    answer: 'C',
  }) as { content: { text: string }[]; isError?: boolean }
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/Invalid answer option/)
  expect(mockUpdateMany).not.toHaveBeenCalled()
})

it("(d) options=['A','B'], answer='A' → ok", async () => {
  mockFindUnique.mockResolvedValue(OPEN_QUESTION_WITH_OPTIONS)
  const res = await stub.call({
    question_id: 'q-1',
    product_id: 'prod-1',
    answer: 'A',
  }) as { content: { text: string }[]; isError?: boolean }
  expect(res.isError).toBeFalsy()
  const body = JSON.parse(res.content[0].text)
  expect(body.ok).toBe(true)
})

// (e) Token gescoped op X + product_id=Y → Product Y not found or not accessible, geen write
it('(e) token gescoped op X + product_id=Y → not accessible, geen DB write', async () => {
  mockAccess.mockResolvedValue(false)
  const res = await stub.call({
    question_id: 'q-1',
    product_id: 'prod-y',
    answer: 'poging',
  }) as { content: { text: string }[]; isError?: boolean }
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/Product prod-y not found or not accessible/)
  expect(mockFindUnique).not.toHaveBeenCalled()
  expect(mockUpdateMany).not.toHaveBeenCalled()
})

it('(e) scope-guard is vóór elke DB-query', async () => {
  mockAccess.mockResolvedValue(false)
  await stub.call({ question_id: 'q-1', product_id: 'prod-y', answer: 'x' })
  // No DB touched at all
  expect(mockFindUnique).not.toHaveBeenCalled()
  expect(mockUpdateMany).not.toHaveBeenCalled()
})

// Demo account → PERMISSION_DENIED
it('demo-account wordt geweigerd (PERMISSION_DENIED)', async () => {
  mockAuth.mockRejectedValue(new PermissionDeniedError())
  const res = await stub.call({
    question_id: 'q-1',
    product_id: 'prod-1',
    answer: 'poging',
  }) as { content: { text: string }[]; isError?: boolean }
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/PERMISSION_DENIED/)
})
