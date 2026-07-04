import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    idea: { findUnique: vi.fn() },
    ideaChatMessage: { findMany: vi.fn() },
    ideaLog: { findMany: vi.fn() },
    claudeQuestion: { findMany: vi.fn() },
    userQuestion: { findMany: vi.fn() },
    claudeJob: { findFirst: vi.fn() },
  },
}))
vi.mock('../src/auth.js', () => ({ getAuth: vi.fn() }))
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { getAuth } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerGetIdeaChatChannelTool } from '../src/tools/get-idea-chat-channel.js'

function makeStub() {
  let handler: ((input: Record<string, unknown>) => Promise<unknown>) | undefined
  const server = {
    registerTool: vi.fn((_n: string, _m: unknown, h: typeof handler) => {
      handler = h
    }),
  } as unknown as McpServer
  registerGetIdeaChatChannelTool(server)
  return { call: (input: Record<string, unknown>) => handler!(input) }
}
const stub = makeStub()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAuth).mockResolvedValue({ userId: 'u1' } as never)
  vi.mocked(userCanAccessProduct).mockResolvedValue(true)
  vi.mocked(prisma.idea.findUnique).mockResolvedValue({ user_id: 'u1', product_id: 'p1' } as never)
  ;[
    prisma.ideaChatMessage.findMany,
    prisma.ideaLog.findMany,
    prisma.claudeQuestion.findMany,
    prisma.userQuestion.findMany,
  ].forEach((m) => vi.mocked(m).mockResolvedValue([] as never))
  vi.mocked(prisma.claudeJob.findFirst).mockResolvedValue(null as never)
})

it('token-scope-guard eerst: product buiten scope → not accessible, geen queries', async () => {
  vi.mocked(userCanAccessProduct).mockResolvedValue(false)
  const res = (await stub.call({ product_id: 'p2', idea_id: 'i1' })) as { isError?: boolean }
  expect(res.isError).toBe(true)
  expect(prisma.ideaChatMessage.findMany).not.toHaveBeenCalled()
})

it('productgrens: idea van ander product → "Idea not found" (anti-enum)', async () => {
  vi.mocked(prisma.idea.findUnique).mockResolvedValue({ user_id: 'u1', product_id: 'ander' } as never)
  const res = (await stub.call({ product_id: 'p1', idea_id: 'i1' })) as {
    isError?: boolean
    content: [{ text: string }]
  }
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/not found/i)
})

it('after+before samen → validatiefout', async () => {
  const res = (await stub.call({ product_id: 'p1', idea_id: 'i1', after: 'x|1', before: 'y|2' })) as {
    isError?: boolean
  }
  expect(res.isError).toBe(true)
})

it('merged kanaal + active_job + question_states in één respons', async () => {
  vi.mocked(prisma.ideaChatMessage.findMany).mockResolvedValue([
    { id: 'm1', role: 'USER', kind: 'TEXT', content: 'hoi', metadata: null, job_id: null, created_at: new Date('2026-07-04T10:00:00Z') },
  ] as never)
  vi.mocked(prisma.claudeJob.findFirst).mockResolvedValue({ id: 'j1', kind: 'IDEA_CHAT', status: 'RUNNING' } as never)
  vi.mocked(prisma.claudeQuestion.findMany)
    // items-bron (met cursorWhere)
    .mockResolvedValueOnce([
      { id: 'q1', question: 'Optie?', options: ['A'], status: 'open', answer: null, expires_at: new Date('2026-07-05T10:00:00Z'), created_at: new Date('2026-07-04T09:00:00Z') },
    ] as never)
    // open-set (ongeacht leeftijd)
    .mockResolvedValueOnce([
      { id: 'q1', status: 'open', answer: null, expires_at: new Date('2026-07-05T10:00:00Z') },
    ] as never)
    // recentste 50
    .mockResolvedValueOnce([
      { id: 'q1', status: 'open', answer: null, expires_at: new Date('2026-07-05T10:00:00Z') },
    ] as never)
  const res = (await stub.call({ product_id: 'p1', idea_id: 'i1' })) as { content: [{ text: string }] }
  const body = JSON.parse(res.content[0].text)
  expect(body.items.map((i: { source: string }) => i.source)).toEqual(['message', 'claude_question'])
  expect(body.active_job).toEqual({ id: 'j1', kind: 'IDEA_CHAT', status: 'RUNNING' })
  expect(body.question_states).toEqual([
    { id: 'q1', status: 'open', answer: null, expires_at: '2026-07-05T10:00:00.000Z' },
  ])
})

it('cursor-predicaat zit ín de DB-query (after)', async () => {
  await stub.call({ product_id: 'p1', idea_id: 'i1', after: '2026-07-04T10:00:00.000Z|m1' })
  const where = vi.mocked(prisma.ideaChatMessage.findMany).mock.calls[0][0]!.where as Record<string, unknown>
  expect(where.OR).toBeDefined()
})

it('open vraag buiten de recentste 50 zit tóch in de overlay (open ∪ recent, codex r1-P2)', async () => {
  const oud = { id: 'q-oud', status: 'open', answer: null, expires_at: new Date('2026-07-05T10:00:00Z') }
  vi.mocked(prisma.claudeQuestion.findMany)
    .mockResolvedValueOnce([] as never) // items-bron
    .mockResolvedValueOnce([oud] as never) // open-set (ongeacht leeftijd)
    .mockResolvedValueOnce([] as never) // recentste 50
  const res = (await stub.call({ product_id: 'p1', idea_id: 'i1' })) as { content: [{ text: string }] }
  const body = JSON.parse(res.content[0].text)
  expect(body.question_states.map((s: { id: string }) => s.id)).toContain('q-oud')
})
