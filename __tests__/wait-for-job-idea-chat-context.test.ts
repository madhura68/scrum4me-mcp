import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn(), findFirst: vi.fn() },
    ideaChatMessage: { findMany: vi.fn() },
    claudeQuestion: { findMany: vi.fn() },
  },
}))

import { prisma } from '../src/prisma.js'
import { getFullJobContext } from '../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> }
  ideaChatMessage: { findMany: ReturnType<typeof vi.fn> }
  claudeQuestion: { findMany: ReturnType<typeof vi.fn> }
}

function buildJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-ideachat-1234',
    kind: 'IDEA_CHAT',
    source: 'SYSTEM',
    status: 'CLAIMED',
    created_at: new Date('2026-07-03T10:00:00.000Z'),
    chat_cutoff_message_id: 'msg2',
    chat_cutoff_at: new Date('2026-07-03T09:59:00.000Z'),
    requested_model: null,
    requested_thinking_budget: null,
    requested_permission_mode: null,
    task: null,
    sprint_run_id: null,
    manual_drafts: [],
    idea: {
      id: 'idea-1',
      code: 'IDEA-134',
      title: 'Idea chat channel',
      description: 'Chat per idee.',
      grill_md: 'Grill notes',
      plan_md: null,
      status: 'DRAFT',
      product_id: 'prod-1',
      pbi: null,
      secondary_products: [],
      plan_doc: null,
      grill_doc: { current_revision: { content_md: 'Grill doc content' } },
      user_questions: [],
    },
    product: {
      id: 'prod-1',
      name: 'Scrum4Me',
      repo_url: 'https://git.example/scrum4me.git',
      definition_of_done: 'Tests groen.',
      preferred_model: null,
      thinking_budget_default: null,
      preferred_permission_mode: null,
    },
    ...overrides,
  }
}

// M17 idea-chat: payload voor een IDEA_CHAT-beurt — kanaal-historie hard
// begrensd op de gepersisteerde cutoff (spec §4.2), chronologisch aangeleverd.
describe('getFullJobContext system IDEA_CHAT jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.claudeJob.findUnique.mockResolvedValue(buildJobRow())
    mockPrisma.claudeJob.findFirst.mockResolvedValue(null)
    mockPrisma.claudeQuestion.findMany.mockResolvedValue([
      {
        id: 'cq1',
        question: 'In het plan opnemen?',
        options: ['ja', 'nee'],
        status: 'answered',
        answer: 'ja',
        created_at: new Date('2026-07-03T09:30:00.000Z'),
      },
    ])
    mockPrisma.ideaChatMessage.findMany.mockResolvedValue([
      {
        id: 'msg2',
        role: 'USER',
        kind: 'TEXT',
        content: 'Wat vind je van deze toevoeging?',
        created_at: new Date('2026-07-03T09:59:00.000Z'),
      },
      {
        id: 'msg1',
        role: 'ASSISTANT',
        kind: 'TEXT',
        content: 'Eerder antwoord.',
        created_at: new Date('2026-07-03T09:00:00.000Z'),
      },
    ])
  })

  it('returns chat context bounded by the persisted cutoff, oldest first', async () => {
    const context = await getFullJobContext('job-ideachat-1234', 'CLAUDE')

    // Historie-query moet de cutoff-grens (OR-predicaat) bevatten — een
    // post-claim bericht mag niet dubbel behandeld worden.
    expect(mockPrisma.ideaChatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          idea_id: 'idea-1',
          OR: [
            { created_at: { lt: new Date('2026-07-03T09:59:00.000Z') } },
            { created_at: new Date('2026-07-03T09:59:00.000Z'), id: { lte: 'msg2' } },
          ],
        }),
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: 50,
      })
    )
    expect(context).toMatchObject({
      job_id: 'job-ideachat-1234',
      kind: 'IDEA_CHAT',
      source: 'SYSTEM',
      status: 'claimed',
      idea: {
        id: 'idea-1',
        code: 'IDEA-134',
        grill_md: 'Grill doc content',
        plan_md: null,
        status: 'DRAFT',
      },
      chat: {
        cutoff_message_id: 'msg2',
        cutoff_at: '2026-07-03T09:59:00.000Z',
      },
    })
    const chat = (context as {
      chat: { messages: Array<{ id: string }>; questions: Array<Record<string, unknown>> }
    }).chat
    expect(chat.messages.map((m) => m.id)).toEqual(['msg1', 'msg2'])
    // M17b: kaart-Q&A-geheugen — vervolg-beurten kennen eerdere kaartvragen.
    expect(chat.questions).toEqual([
      expect.objectContaining({
        id: 'cq1',
        question: 'In het plan opnemen?',
        options: ['ja', 'nee'],
        status: 'answered',
        answer: 'ja',
        created_at: '2026-07-03T09:30:00.000Z',
      }),
    ])
    expect(String((context as { prompt_text?: string }).prompt_text)).toContain('IDEA_CHAT')
    expect(context).not.toHaveProperty('worktree_path')
    expect(context).not.toHaveProperty('branch_suggestion')
  })
})

// M2 (agent-harness idea-chat-local-llm, ronde 1 BLOCKER): de payload moet
// zelf zeggen welke USER-berichten nog open staan — de cutoff van de huidige
// claim vindt een USER-bericht dat vóór het vorige ASSISTANT-antwoord binnenkwam
// niet terug als "onbeantwoord" zonder deze lookup (zie het M2-plan Taak 2).
describe('getFullJobContext IDEA_CHAT pending_user_message_ids (M2 coalescing)', () => {
  const T1 = new Date('2026-07-03T09:00:00.000Z') // USER A
  const T2 = new Date('2026-07-03T09:30:00.000Z') // USER B
  const T3 = new Date('2026-07-03T09:59:00.000Z') // ASSISTANT A

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.claudeJob.findUnique.mockResolvedValue(buildJobRow({
      chat_cutoff_message_id: 'msgAssistantA',
      chat_cutoff_at: T3,
    }))
    mockPrisma.ideaChatMessage.findMany.mockResolvedValue([
      { id: 'msgAssistantA', role: 'ASSISTANT', kind: 'TEXT', content: 'Antwoord op A.', created_at: T3 },
      { id: 'msgB', role: 'USER', kind: 'TEXT', content: 'Bericht B.', created_at: T2 },
      { id: 'msgA', role: 'USER', kind: 'TEXT', content: 'Bericht A.', created_at: T1 },
    ])
    mockPrisma.claudeQuestion.findMany.mockResolvedValue([])
  })

  it('laatste DONE-job met cutoff = USER A ⇒ pending_user_message_ids = [B]', async () => {
    mockPrisma.claudeJob.findFirst.mockResolvedValue({
      chat_cutoff_at: T1,
      chat_cutoff_message_id: 'msgA',
      created_at: T1,
    })

    const context = await getFullJobContext('job-ideachat-1234', 'CLAUDE')

    expect(mockPrisma.claudeJob.findFirst).toHaveBeenCalledWith({
      where: { idea_id: 'idea-1', kind: 'IDEA_CHAT', status: 'DONE', id: { not: 'job-ideachat-1234' } },
      orderBy: [{ finished_at: 'desc' }, { id: 'desc' }],
      select: { chat_cutoff_at: true, chat_cutoff_message_id: true, created_at: true },
    })
    expect((context as { chat: { pending_user_message_ids: string[] } }).chat.pending_user_message_ids).toEqual(['msgB'])
  })

  it('geen DONE-job ⇒ pending_user_message_ids = alle USER-berichten [A, B]', async () => {
    mockPrisma.claudeJob.findFirst.mockResolvedValue(null)

    const context = await getFullJobContext('job-ideachat-1234', 'CLAUDE')

    expect((context as { chat: { pending_user_message_ids: string[] } }).chat.pending_user_message_ids).toEqual(['msgA', 'msgB'])
  })

  it('laatste DONE-job met cutoff = ASSISTANT A en geen latere USER ⇒ pending_user_message_ids = []', async () => {
    mockPrisma.claudeJob.findFirst.mockResolvedValue({
      chat_cutoff_at: T3,
      chat_cutoff_message_id: 'msgAssistantA',
      created_at: T3,
    })

    const context = await getFullJobContext('job-ideachat-1234', 'CLAUDE')

    expect((context as { chat: { pending_user_message_ids: string[] } }).chat.pending_user_message_ids).toEqual([])
  })

  it('findFirst rejectt ⇒ de contextopbouw faalt (geen gegokte pending-lijst)', async () => {
    mockPrisma.claudeJob.findFirst.mockRejectedValue(new Error('db unavailable'))

    await expect(getFullJobContext('job-ideachat-1234', 'CLAUDE')).rejects.toThrow('db unavailable')
  })
})
