import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeJobKind } from '@prisma/client'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn(), findFirst: vi.fn() },
    // getFullJobContext leest voor een HARNESS-job de productkeuze (zonder .catch), en voor elke job de
    // JobKindConfig (met .catch, maar dat print dan een stacktrace): beide zonder rij.
    productHarnessChoice: { findUnique: vi.fn().mockResolvedValue(null) },
    jobKindConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    ideaChatMessage: { findMany: vi.fn() },
    claudeQuestion: { findMany: vi.fn() },
  },
}))

// doc-index: best-effort, geen invloed op de prompt.
vi.mock('../src/lib/doc-index.js', () => ({
  buildDocIndex: vi.fn().mockResolvedValue(null),
}))

// getFullJobContext haalt getIdeaPromptText op via een dynamische import. De spy laat de echte
// functie doorlopen (de prompttekst blijft echt) en legt vast met welke runtime hij wordt
// aangeroepen: voor CODEX is de tekst gelijk aan die van CLAUDE, dus alleen de argumenten
// tonen of de aanroeper de effectieve runtime meegeeft.
vi.mock('../src/lib/kind-prompts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/kind-prompts.js')>()
  return { ...actual, getIdeaPromptText: vi.fn(actual.getIdeaPromptText) }
})

import { prisma } from '../src/prisma.js'
import { getIdeaPromptText, getKindPromptText } from '../src/lib/kind-prompts.js'
import { getFullJobContext } from '../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> }
  ideaChatMessage: { findMany: ReturnType<typeof vi.fn> }
  claudeQuestion: { findMany: ReturnType<typeof vi.fn> }
}
const mockGetIdeaPromptText = getIdeaPromptText as unknown as ReturnType<typeof vi.fn>

const IDEA_KINDS = [
  'IDEA_GRILL',
  'IDEA_MAKE_PLAN',
  'IDEA_REVIEW_PLAN',
  'IDEA_MAKE_SPEC',
  'IDEA_REVISE_SPEC',
  'IDEA_CHAT',
  'PLAN_CHAT',
] as const

describe('prompttekst per runtime — HARNESS krijgt geen Claude-prompt', () => {
  it.each(Object.values(ClaudeJobKind))('getKindPromptText(%s, HARNESS) is leeg', (kind) => {
    expect(getKindPromptText(kind, 'HARNESS')).toBe('')
  })

  it.each(IDEA_KINDS)('getIdeaPromptText(%s, HARNESS) is leeg', (kind) => {
    expect(getIdeaPromptText(kind, 'HARNESS')).toBe('')
  })

  it('getIdeaPromptText(IDEA_CHAT, HARNESS) is leeg; voor CLAUDE blijft de bestaande prompt', () => {
    // HARNESS eerst: een lege uitkomst mag de tekst van de andere runtimes niet beïnvloeden.
    expect(getIdeaPromptText('IDEA_CHAT', 'HARNESS')).toBe('')

    const claude = getIdeaPromptText('IDEA_CHAT', 'CLAUDE')
    expect(claude.length).toBeGreaterThan(0)
    expect(claude).toContain('IDEA_CHAT')
    expect(claude).toBe(getIdeaPromptText('IDEA_CHAT'))
    expect(claude).toBe(getKindPromptText('IDEA_CHAT', 'CODEX'))
  })
})

function buildChatJobRow(kind: 'IDEA_CHAT' | 'PLAN_CHAT', overrides: Record<string, unknown> = {}) {
  return {
    id: `job-${kind.toLowerCase()}-1234`,
    kind,
    source: 'SYSTEM',
    status: 'CLAIMED',
    runtime: 'CLAUDE',
    created_at: new Date('2026-07-03T10:00:00.000Z'),
    chat_cutoff_message_id: 'msg1',
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

function promptTextOf(context: unknown): unknown {
  return (context as { prompt_text?: unknown }).prompt_text
}

// De aanroepen in getFullJobContext (PLAN_CHAT en IDEA_CHAT) gaven geen runtime mee en vielen
// daardoor stil terug op CLAUDE. Ze geven nu de effectieve runtime mee: de parameter van de
// aanroeper, anders de runtime van de job zelf (dezelfde regel als de configresolutie).
describe('getFullJobContext — de chat-prompts volgen de effectieve runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.claudeJob.findFirst.mockResolvedValue(null)
    mockPrisma.ideaChatMessage.findMany.mockResolvedValue([])
    mockPrisma.claudeQuestion.findMany.mockResolvedValue([])
  })

  describe('IDEA_CHAT', () => {
    it('HARNESS (parameter van de aanroeper): lege prompt_text, config van de HARNESS-tak', async () => {
      mockPrisma.claudeJob.findUnique.mockResolvedValue(
        buildChatJobRow('IDEA_CHAT', { requested_model: 'gsq-lokaal', runtime: 'HARNESS' }),
      )

      const context = await getFullJobContext('job-idea_chat-1234', 'HARNESS')

      expect(promptTextOf(context)).toBe('')
      expect(mockGetIdeaPromptText).toHaveBeenCalledWith('IDEA_CHAT', 'HARNESS')
      expect((context as { config: { runtime: string } }).config.runtime).toBe('HARNESS')
    })

    it('HARNESS (runtime van de job, geen parameter): lege prompt_text', async () => {
      mockPrisma.claudeJob.findUnique.mockResolvedValue(
        buildChatJobRow('IDEA_CHAT', { requested_model: 'gsq-lokaal', runtime: 'HARNESS' }),
      )

      const context = await getFullJobContext('job-idea_chat-1234')

      expect(promptTextOf(context)).toBe('')
      expect(mockGetIdeaPromptText).toHaveBeenCalledWith('IDEA_CHAT', 'HARNESS')
    })

    it('CLAUDE: de bestaande prompt, mét de runtime als argument', async () => {
      mockPrisma.claudeJob.findUnique.mockResolvedValue(buildChatJobRow('IDEA_CHAT'))

      const context = await getFullJobContext('job-idea_chat-1234', 'CLAUDE')

      expect(String(promptTextOf(context))).toContain('IDEA_CHAT')
      expect(mockGetIdeaPromptText).toHaveBeenCalledWith('IDEA_CHAT', 'CLAUDE')
    })

    it('CODEX (runtime van de job, geen parameter): geeft CODEX door', async () => {
      mockPrisma.claudeJob.findUnique.mockResolvedValue(
        buildChatJobRow('IDEA_CHAT', { runtime: 'CODEX' }),
      )

      await getFullJobContext('job-idea_chat-1234')

      expect(mockGetIdeaPromptText).toHaveBeenCalledWith('IDEA_CHAT', 'CODEX')
    })
  })

  describe('PLAN_CHAT', () => {
    it('CODEX (parameter van de aanroeper): geeft CODEX door', async () => {
      mockPrisma.claudeJob.findUnique.mockResolvedValue(buildChatJobRow('PLAN_CHAT', { runtime: 'CODEX' }))

      const context = await getFullJobContext('job-plan_chat-1234', 'CODEX')

      expect(String(promptTextOf(context))).toContain('PLAN_CHAT')
      expect(mockGetIdeaPromptText).toHaveBeenCalledWith('PLAN_CHAT', 'CODEX')
    })

    it('CODEX (runtime van de job, geen parameter): geeft CODEX door', async () => {
      mockPrisma.claudeJob.findUnique.mockResolvedValue(
        buildChatJobRow('PLAN_CHAT', { runtime: 'CODEX' }),
      )

      await getFullJobContext('job-plan_chat-1234')

      expect(mockGetIdeaPromptText).toHaveBeenCalledWith('PLAN_CHAT', 'CODEX')
    })

    it('CLAUDE: de bestaande prompt, mét de runtime als argument', async () => {
      mockPrisma.claudeJob.findUnique.mockResolvedValue(buildChatJobRow('PLAN_CHAT'))

      const context = await getFullJobContext('job-plan_chat-1234', 'CLAUDE')

      expect(String(promptTextOf(context))).toContain('PLAN_CHAT')
      expect(mockGetIdeaPromptText).toHaveBeenCalledWith('PLAN_CHAT', 'CLAUDE')
    })
  })
})
