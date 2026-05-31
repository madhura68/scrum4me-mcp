import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { claudeJob: { findUnique: vi.fn() } },
}))
vi.mock('../src/lib/doc-index.js', () => ({
  buildDocIndex: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { buildDocIndex } from '../src/lib/doc-index.js'
import { getFullJobContext } from '../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
}
const mockBuild = buildDocIndex as unknown as ReturnType<typeof vi.fn>

const MANUAL_JOB = {
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
      id: 'draft-1', title: 'Maak plan', adapter: 'claude_messages_api',
      required_capability: 'planning', prompt_md: 'Maak een plan.',
      launch_preview_json: { previewJson: { messages: [] } },
    },
  ],
  product: {
    id: 'prod-1', name: 'Scrum4Me', repo_url: 'https://example.com/r.git',
    definition_of_done: 'Tests groen.', preferred_model: null,
    thinking_budget_default: null, preferred_permission_mode: null,
  },
}

describe('getFullJobContext doc_index injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.claudeJob.findUnique.mockResolvedValue(MANUAL_JOB)
  })

  it('includes the built doc_index in the returned context', async () => {
    const index = { product_id: 'prod-1', folders: [], hint: 'h' }
    mockBuild.mockResolvedValueOnce(index)
    const ctx = await getFullJobContext('job-manual-12345678') as Record<string, unknown>
    expect(mockBuild).toHaveBeenCalledWith('prod-1')
    expect(ctx.doc_index).toEqual(index)
  })

  it('sets doc_index to null when buildDocIndex throws (best-effort)', async () => {
    mockBuild.mockRejectedValueOnce(new Error('db down'))
    const ctx = await getFullJobContext('job-manual-12345678') as Record<string, unknown>
    expect(ctx.doc_index).toBeNull()
  })
})
