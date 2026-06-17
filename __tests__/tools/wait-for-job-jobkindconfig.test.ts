import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn() },
    jobKindConfig: { findUnique: vi.fn() },
  },
}))

// doc-index: best-effort, return null so it doesn't interfere.
vi.mock('../../src/lib/doc-index.js', () => ({
  buildDocIndex: vi.fn().mockResolvedValue(null),
}))

import { prisma } from '../../src/prisma.js'
import { getFullJobContext } from '../../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
  jobKindConfig: { findUnique: ReturnType<typeof vi.fn> }
}

// ORCHESTRATOR-job: simpelste tak met een `config`-veld, zonder DB-side-effects
// (geen worktree/sprint-snapshot). Volstaat om de config-resolutie te bewijzen.
const BASE_ORCH_JOB = {
  id: 'job-jkc-1',
  kind: 'IDEA_GRILL',
  source: 'ORCHESTRATOR',
  status: 'CLAIMED',
  requested_model: null,
  requested_thinking_budget: null,
  requested_permission_mode: null,
  created_by_job_id: null,
  orchestration_key: null,
  required_capability: null,
  summary: 'doe iets',
  task: null,
  idea: null,
  sprint_run_id: null,
  pr_url: null,
  doc_id: null,
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
}

describe('getFullJobContext — live JobKindConfig-resolutie', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.claudeJob.findUnique.mockResolvedValue(BASE_ORCH_JOB)
  })

  it('CLAUDE: DB JobKindConfig overschrijft de code-default model/permission/tools', async () => {
    mockPrisma.jobKindConfig.findUnique.mockResolvedValue({
      kind: 'IDEA_GRILL',
      claude_model: 'claude-opus-4-8',
      codex_model: 'gpt-5.1-codex',
      thinking_budget: 9000,
      claude_permission_mode: 'default',
      codex_sandbox_mode: 'read-only',
      allow_all_tools: false,
      allowed_tools: ['Read', 'Grep'],
      skills: ['skill-a'],
      max_turns: 7,
    })

    const ctx = (await getFullJobContext('job-jkc-1', 'CLAUDE')) as any
    expect(mockPrisma.jobKindConfig.findUnique).toHaveBeenCalledWith({
      where: { kind: 'IDEA_GRILL' },
    })
    expect(ctx.config.runtime).toBe('CLAUDE')
    expect(ctx.config.model).toBe('claude-opus-4-8')
    expect(ctx.config.permission_mode).toBe('default')
    expect(ctx.config.allowed_tools).toEqual(['Read', 'Grep'])
    expect(ctx.config.skills).toEqual(['skill-a'])
  })

  it('CODEX: gebruikt codex_model + sandbox_mode en heeft geen allowed_tools', async () => {
    mockPrisma.jobKindConfig.findUnique.mockResolvedValue({
      kind: 'IDEA_GRILL',
      claude_model: 'claude-opus-4-8',
      codex_model: 'gpt-5.1-codex',
      thinking_budget: 9000,
      claude_permission_mode: 'default',
      codex_sandbox_mode: 'read-only',
      allow_all_tools: false,
      allowed_tools: ['Read', 'Grep'],
      skills: ['skill-a'],
      max_turns: 7,
    })

    const ctx = (await getFullJobContext('job-jkc-1', 'CODEX')) as any
    expect(ctx.config.runtime).toBe('CODEX')
    expect(ctx.config.model).toBe('gpt-5.1-codex')
    expect(ctx.config.sandbox_mode).toBe('read-only')
    expect(ctx.config).not.toHaveProperty('allowed_tools')
    expect(ctx.config.skills).toEqual(['skill-a'])
  })

  it('best-effort: een falende jobKindConfig-lookup degradeert naar de code-default', async () => {
    mockPrisma.jobKindConfig.findUnique.mockRejectedValue(new Error('db down'))

    const ctx = (await getFullJobContext('job-jkc-1', 'CLAUDE')) as any
    expect(ctx.config.runtime).toBe('CLAUDE')
    // IDEA_GRILL code-default (KIND_DEFAULTS): sonnet + acceptEdits
    expect(ctx.config.model).toBe('claude-sonnet-4-6')
    expect(ctx.config.permission_mode).toBe('acceptEdits')
  })

  it('geen DB-rij (null): valt terug op de code-default', async () => {
    mockPrisma.jobKindConfig.findUnique.mockResolvedValue(null)

    const ctx = (await getFullJobContext('job-jkc-1', 'CLAUDE')) as any
    expect(ctx.config.model).toBe('claude-sonnet-4-6')
  })
})
