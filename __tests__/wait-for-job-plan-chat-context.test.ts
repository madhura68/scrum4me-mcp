import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn() },
  },
}))

import { prisma } from '../src/prisma.js'
import { getFullJobContext } from '../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
}

describe('getFullJobContext system PLAN_CHAT jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      id: 'job-chat-12345678',
      kind: 'PLAN_CHAT',
      source: 'SYSTEM',
      status: 'CLAIMED',
      requested_model: null,
      requested_thinking_budget: null,
      requested_permission_mode: null,
      task: null,
      sprint_run_id: null,
      manual_drafts: [],
      idea: {
        id: 'idea-1',
        code: 'IDEA-42',
        title: 'Improve planning chat',
        description: 'Let users ask follow-up questions about plans.',
        grill_md: 'Grill notes',
        plan_md: 'Plan notes',
        status: 'PLAN_READY',
        product_id: 'prod-1',
        pbi: { id: 'pbi-1', code: 'PBI-1', title: 'Planning UX' },
        secondary_products: [],
        plan_doc: { current_revision: { content_md: 'Plan doc content' } },
        grill_doc: { current_revision: { content_md: 'Grill doc content' } },
        user_questions: [
          {
            id: 'question-1',
            question: 'Wat is de volgende stap?',
            status: 'pending',
            created_at: new Date('2026-05-27T12:00:00.000Z'),
          },
        ],
      },
      product: {
        id: 'prod-1',
        name: 'Scrum4Me',
        repo_url: 'https://github.com/acme/scrum4me.git',
        definition_of_done: 'Tests groen.',
        preferred_model: null,
        thinking_budget_default: null,
        preferred_permission_mode: null,
      },
    })
  })

  it('returns idea chat context with the latest pending user question', async () => {
    const context = await getFullJobContext('job-chat-12345678', 'CLAUDE')

    expect(mockPrisma.claudeJob.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        idea: expect.objectContaining({
          include: expect.objectContaining({
            user_questions: {
              where: { status: 'pending' },
              orderBy: { created_at: 'desc' },
              take: 1,
              select: {
                id: true,
                question: true,
                status: true,
                created_at: true,
              },
            },
          }),
        }),
      }),
    }))
    expect(context).toMatchObject({
      job_id: 'job-chat-12345678',
      kind: 'PLAN_CHAT',
      source: 'SYSTEM',
      status: 'claimed',
      idea: {
        id: 'idea-1',
        code: 'IDEA-42',
        title: 'Improve planning chat',
        description: 'Let users ask follow-up questions about plans.',
        grill_md: 'Grill doc content',
        plan_md: 'Plan doc content',
        status: 'PLAN_READY',
        product_id: 'prod-1',
      },
      product: {
        id: 'prod-1',
        name: 'Scrum4Me',
        repo_url: 'https://github.com/acme/scrum4me.git',
        definition_of_done: 'Tests groen.',
      },
      pbi: { id: 'pbi-1', code: 'PBI-1', title: 'Planning UX' },
      repo_url: 'https://github.com/acme/scrum4me.git',
      plan_chat: {
        question_id: 'question-1',
        question: 'Wat is de volgende stap?',
        status: 'pending',
        created_at: '2026-05-27T12:00:00.000Z',
      },
      user_question: {
        question_id: 'question-1',
        question: 'Wat is de volgende stap?',
      },
      branch_suggestion: 'feat/idea-idea-42-chat',
    })
    expect(context).toHaveProperty('prompt_text')
    expect(String((context as { prompt_text?: string }).prompt_text)).toContain('PLAN_CHAT')
    expect(context).not.toHaveProperty('worktree_path')
  })
})
