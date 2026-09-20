import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn() },
    queueDispatchRequest: { findUnique: vi.fn() },
    queueDispatchCandidate: { findUnique: vi.fn() },
    queueDispatchArtifact: { findMany: vi.fn() },
    jobKindConfig: { findUnique: vi.fn() },
  },
}))

import { prisma } from '../../src/prisma.js'
import { getFullJobContext } from '../../src/tools/wait-for-job.js'
import { getKindPromptText } from '../../src/lib/kind-prompts.js'

const mock = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
  queueDispatchRequest: { findUnique: ReturnType<typeof vi.fn> }
  queueDispatchCandidate: { findUnique: ReturnType<typeof vi.fn> }
  queueDispatchArtifact: { findMany: ReturnType<typeof vi.fn> }
}

const requestId = '11111111-1111-4111-8111-111111111111'
const candidateId = '22222222-2222-4222-8222-222222222222'
const profileId = '33333333-3333-4333-8333-333333333333'

const input = {
  version: 1, product_id: 'p1', action: 'free_task', objective: 'Pinned objective',
  verification: 'Pinned verification', response_format: 'Markdown',
  requirements: { access: 'read', environment_keys: ['logs.max2'] },
  publish: 'artifact', reply_to: 'mac:jp',
}
const profileConfig = { version: 1, runtime: 'CLAUDE', actions: ['free_task'], image_digest: 'sha256:abc' }

function managedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-managed-1', kind: 'QUEUE_TASK', source: 'COPILOT', status: 'CLAIMED', runtime: 'CLAUDE',
    product_id: 'p1', task_id: null, required_capability: 'review',
    requested_model: 'claude-opus-4-5', requested_thinking_budget: 8000, requested_permission_mode: 'plan',
    dispatch_request_id: requestId, dispatch_candidate_id: candidateId,
    ...overrides,
  }
}

function pinnedDispatchRows() {
  mock.queueDispatchRequest.findUnique.mockResolvedValue({
    id: requestId, user_id: 'u1', product_id: 'p1', input, input_hash: 'f'.repeat(64),
    snapshot: { implementation_plan: 'pinned plan' }, state: 'CLAIMED',
  })
  mock.queueDispatchCandidate.findUnique.mockResolvedValue({
    id: candidateId, generation: 1, route: 'job', profile_revision_id: profileId,
    profile: { config: profileConfig, sha256: 'a'.repeat(64) },
  })
  mock.queueDispatchArtifact.findMany.mockResolvedValue([
    { id: '44444444-4444-4444-8444-444444444444', key: 'plan.md', sha256: 'b'.repeat(64) },
  ])
}

describe('getFullJobContext — managed dispatch branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.claudeJob.findUnique.mockResolvedValue(managedJob())
    pinnedDispatchRows()
  })

  it('builds a managed job context from the pinned dispatch data only', async () => {
    const context = await getFullJobContext('job-managed-1', 'CLAUDE', null, { managed: true })

    expect(context).toMatchObject({
      job_id: 'job-managed-1', kind: 'QUEUE_TASK', source: 'COPILOT', status: 'claimed', managed: true,
      dispatch: {
        request_id: requestId, candidate_id: candidateId, generation: 1, route: 'job',
        profile_revision_id: profileId, profile: profileConfig, profile_sha256: 'a'.repeat(64),
        input, input_hash: 'f'.repeat(64), snapshot: { implementation_plan: 'pinned plan' },
        source_artifacts: [{ key: 'plan.md', artifact_id: '44444444-4444-4444-8444-444444444444', sha256: 'b'.repeat(64) }],
      },
      // Copied into the job row at enqueue time, not re-resolved against today's product settings.
      model_config: { model: 'claude-opus-4-5', thinking_budget: 8000, permission_mode: 'plan', runtime: 'CLAUDE' },
      product: { id: 'p1' },
      prompt_text: getKindPromptText('QUEUE_TASK', 'CLAUDE'),
    })
    expect((context as Record<string, unknown>).prompt_text).not.toBe('')
  })

  it('reads no Task, Story, Idea or doc index — a free managed job has none', async () => {
    const context = await getFullJobContext('job-managed-1', 'CLAUDE', null, { managed: true }) as Record<string, unknown>

    for (const key of ['task', 'story', 'pbi', 'sprint', 'idea', 'doc_index', 'plan_snapshot']) {
      expect(context[key]).toBeUndefined()
    }
    // The single job lookup must not pull the latest Task/Idea/doc graph along.
    expect(mock.claudeJob.findUnique).toHaveBeenCalledTimes(1)
    expect(mock.claudeJob.findUnique.mock.calls[0][0].include).toBeUndefined()
  })

  it('gives the CODEX runtime its own prompt for the same pinned request', async () => {
    mock.claudeJob.findUnique.mockResolvedValue(managedJob({ kind: 'QUEUE_REVIEW', runtime: 'CODEX' }))
    const context = await getFullJobContext('job-managed-1', 'CODEX', null, { managed: true }) as Record<string, unknown>

    expect(context.prompt_text).toBe(getKindPromptText('QUEUE_REVIEW', 'CODEX'))
    expect(context.prompt_text).not.toBe(getKindPromptText('QUEUE_REVIEW', 'CLAUDE'))
  })

  it('fails an unbound managed job kind before anything can start a model', async () => {
    mock.claudeJob.findUnique.mockResolvedValue(managedJob({ dispatch_request_id: null, dispatch_candidate_id: null }))
    await expect(getFullJobContext('job-managed-1', 'CLAUDE', null, { managed: true })).rejects.toThrow('DISPATCH_UNBOUND_JOB')
    expect(mock.queueDispatchRequest.findUnique).not.toHaveBeenCalled()
  })

  it('fails when the binding points at a request that is not there', async () => {
    mock.queueDispatchRequest.findUnique.mockResolvedValue(null)
    await expect(getFullJobContext('job-managed-1', 'CLAUDE', null, { managed: true })).rejects.toThrow('DISPATCH_UNBOUND_JOB')
  })

  // The ordinary worker's database role may not read the dispatch tables at
  // all, so the refusal has to happen without reaching for them — which is also
  // what __tests__/dispatch/legacy-jobs.integration.test.ts proves against a
  // real restricted role.
  it('refuses a managed job for a caller that did not ask for the managed path', async () => {
    await expect(getFullJobContext('job-managed-1', 'CLAUDE')).rejects.toThrow('DISPATCH_MANAGED_ROW')
    expect(mock.queueDispatchRequest.findUnique).not.toHaveBeenCalled()
    expect(mock.queueDispatchCandidate.findUnique).not.toHaveBeenCalled()
    expect(mock.queueDispatchArtifact.findMany).not.toHaveBeenCalled()
  })

  it('leaves an ordinary job on the ordinary path', async () => {
    mock.claudeJob.findUnique.mockResolvedValue(null)
    expect(await getFullJobContext('job-ordinary-1', 'CLAUDE', null, { managed: true })).toBeNull()
    expect(mock.queueDispatchRequest.findUnique).not.toHaveBeenCalled()
  })
})

describe('managed prompts', () => {
  it('tells the task child where its output manifest goes', () => {
    for (const runtime of ['CLAUDE', 'CODEX'] as const) {
      const prompt = getKindPromptText('QUEUE_TASK', runtime)
      expect(prompt).toContain('/output/result.json')
      expect(prompt).toContain('DispatchResult')
    }
  })

  it('makes the reviewer name every pinned source and return exactly one verdict', () => {
    for (const runtime of ['CLAUDE', 'CODEX'] as const) {
      const prompt = getKindPromptText('QUEUE_REVIEW', runtime)
      expect(prompt).toContain('/output/result.json')
      expect(prompt).toMatch(/sha256/i)
      expect(prompt).toMatch(/exactly one/i)
      expect(prompt).toMatch(/GO \| NO-GO \| COMMENT|'GO', 'NO-GO' or 'COMMENT'/)
    }
  })

  it('promises the child no auto-fix, no host actions and no completion tool', () => {
    for (const kind of ['QUEUE_TASK', 'QUEUE_REVIEW'] as const) {
      for (const runtime of ['CLAUDE', 'CODEX'] as const) {
        const prompt = getKindPromptText(kind, runtime)
        expect(prompt).toMatch(/no MCP|no Scrum4Me tool|completion tool/i)
        expect(prompt).toMatch(/\/work|\/output/)
      }
    }
    expect(getKindPromptText('QUEUE_REVIEW', 'CLAUDE')).toMatch(/do not fix|never fix|no fix/i)
  })
})
