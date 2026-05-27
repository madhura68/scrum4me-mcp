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

describe('getFullJobContext orchestrator jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      id: 'job-orch-12345678',
      kind: 'PLAN_CHAT',
      source: 'ORCHESTRATOR',
      status: 'CLAIMED',
      requested_model: 'claude-haiku-4-5-20251001',
      requested_thinking_budget: 3000,
      requested_permission_mode: 'plan',
      required_capability: 'review',
      created_by_job_id: 'parent-job',
      orchestration_key: 'verify-after-implementation',
      summary: 'Controleer implementatie en maak vervolgadvies',
      task: null,
      idea: null,
      sprint_run_id: null,
      manual_drafts: [],
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

  it('returns product-scoped follow-up context with prompt_text from the job summary', async () => {
    const context = await getFullJobContext('job-orch-12345678')

    expect(context).toMatchObject({
      job_id: 'job-orch-12345678',
      kind: 'PLAN_CHAT',
      source: 'ORCHESTRATOR',
      status: 'claimed',
      orchestrator_job: {
        parent_job_id: 'parent-job',
        orchestration_key: 'verify-after-implementation',
        required_capability: 'review',
        summary: 'Controleer implementatie en maak vervolgadvies',
      },
      product: {
        id: 'prod-1',
        name: 'Scrum4Me',
        repo_url: 'https://github.com/acme/scrum4me.git',
        definition_of_done: 'Tests groen.',
      },
      repo_url: 'https://github.com/acme/scrum4me.git',
      prompt_text: 'Controleer implementatie en maak vervolgadvies',
      branch_suggestion: 'feat/orchestrator-12345678',
    })
  })
})
