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

describe('getFullJobContext manual jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      id: 'job-manual-12345678',
      kind: 'PLAN_CHAT',
      source: 'MANUAL',
      status: 'CLAIMED',
      requested_model: 'claude-haiku-4-5-20251001',
      requested_thinking_budget: 3000,
      requested_permission_mode: 'plan',
      task: null,
      idea: null,
      sprint_run_id: null,
      manual_drafts: [
        {
          id: 'draft-1',
          title: 'Maak plan',
          adapter: 'claude_messages_api',
          required_capability: 'planning',
          prompt_md: 'Maak een plan voor dit product.',
          launch_preview_json: { previewJson: { messages: [] } },
        },
      ],
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

  it('returns manual context with prompt_text from the linked draft', async () => {
    const context = await getFullJobContext('job-manual-12345678', 'CLAUDE')

    expect(context).toMatchObject({
      job_id: 'job-manual-12345678',
      kind: 'PLAN_CHAT',
      source: 'MANUAL',
      status: 'claimed',
      manual_job: {
        draft_id: 'draft-1',
        title: 'Maak plan',
        adapter: 'claude_messages_api',
        required_capability: 'planning',
        prompt_md: 'Maak een plan voor dit product.',
        launch_preview_json: { previewJson: { messages: [] } },
      },
      manual_draft: {
        draft_id: 'draft-1',
        title: 'Maak plan',
      },
      product: {
        id: 'prod-1',
        name: 'Scrum4Me',
        repo_url: 'https://github.com/acme/scrum4me.git',
        definition_of_done: 'Tests groen.',
      },
      repo_url: 'https://github.com/acme/scrum4me.git',
      prompt_text: 'Maak een plan voor dit product.',
      branch_suggestion: 'feat/manual-12345678',
    })
  })
})
