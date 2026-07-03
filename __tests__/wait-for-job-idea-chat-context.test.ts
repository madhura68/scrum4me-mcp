import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn() },
    ideaChatMessage: { findMany: vi.fn() },
  },
}))

import { prisma } from '../src/prisma.js'
import { getFullJobContext } from '../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
  ideaChatMessage: { findMany: ReturnType<typeof vi.fn> }
}

// M17 idea-chat: payload voor een IDEA_CHAT-beurt — kanaal-historie hard
// begrensd op de gepersisteerde cutoff (spec §4.2), chronologisch aangeleverd.
describe('getFullJobContext system IDEA_CHAT jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
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
    })
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
    const chat = (context as { chat: { messages: Array<{ id: string }> } }).chat
    expect(chat.messages.map((m) => m.id)).toEqual(['msg1', 'msg2'])
    expect(String((context as { prompt_text?: string }).prompt_text)).toContain('IDEA_CHAT')
    expect(context).not.toHaveProperty('worktree_path')
    expect(context).not.toHaveProperty('branch_suggestion')
  })
})
