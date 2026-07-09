import { beforeEach, describe, expect, it, vi } from 'vitest'

// Must be called before imports that touch the mocked modules.
vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn() },
    task: { findUnique: vi.fn() },
    jobKindConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    $executeRaw: vi.fn(),
  },
}))

vi.mock('../../src/git/pr.js', () => ({
  fetchCompareDiff: vi.fn(),
  fetchPrDiff: vi.fn(),
  getPullRequestState: vi.fn(),
}))

vi.mock('../../src/lib/task-review-context.js', () => ({
  resolveTaskImplContext: vi.fn(),
}))

vi.mock('../../src/lib/pr-linked-plan.js', () => ({
  resolvePrLinkedPlan: vi.fn(),
}))

vi.mock('../../src/git/forgejo-rest.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/git/forgejo-rest.js')>()
  return { ...actual }
})

// doc-index: best-effort, return null so it doesn't interfere.
vi.mock('../../src/lib/doc-index.js', () => ({
  buildDocIndex: vi.fn().mockResolvedValue(null),
}))

import { prisma } from '../../src/prisma.js'
import { fetchCompareDiff, fetchPrDiff } from '../../src/git/pr.js'
import { resolveTaskImplContext } from '../../src/lib/task-review-context.js'
import { getFullJobContext } from '../../src/tools/wait-for-job.js'
import { TerminalJobError } from '../../src/git/on-demand-clone.js'

const mockPrisma = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
  task: { findUnique: ReturnType<typeof vi.fn> }
  $executeRaw: ReturnType<typeof vi.fn>
}

const mockFetchCompareDiff = fetchCompareDiff as ReturnType<typeof vi.fn>
const mockFetchPrDiff = fetchPrDiff as ReturnType<typeof vi.fn>
const mockResolveTaskImplContext = resolveTaskImplContext as ReturnType<typeof vi.fn>

const TASK_REPO_URL = 'https://git.jp-visser.nl/acme/task-repo.git'
const PRODUCT_REPO_URL = 'https://git.jp-visser.nl/acme/main-repo.git'

const BASE_JOB = {
  id: 'job-task-review-1',
  kind: 'TASK_REVIEW',
  source: 'MANUAL',
  status: 'CLAIMED',
  requested_model: null,
  requested_thinking_budget: null,
  requested_permission_mode: null,
  task_id: 'task-1',
  task: null,
  idea: null,
  sprint_run_id: null,
  pr_url: null,
  doc_id: null,
  manual_drafts: [
    {
      id: 'draft-1',
      title: 'Review task',
      adapter: 'claude_messages_api',
      required_capability: null,
      prompt_md: 'review de task-implementatie',
      launch_preview_json: {},
    },
  ],
  product: {
    id: 'prod-1',
    name: 'Scrum4Me',
    repo_url: PRODUCT_REPO_URL,
    definition_of_done: 'Tests groen.',
    preferred_model: null,
    thinking_budget_default: null,
    preferred_permission_mode: null,
  },
}

const BASE_TASK = {
  id: 'task-1',
  title: 'Implement feature X',
  status: 'DONE',
  implementation_plan: 'Plan text here',
  repo_url: null,
  story: {
    acceptance_criteria: 'Must pass all tests.',
  },
}

const BASE_IMPL = {
  plan_snapshot: 'SNAP_PLAN',
  base_sha: 'base-sha-001',
  head_sha: 'head-sha-002',
  pr_url: 'https://git.jp-visser.nl/acme/main-repo/pulls/5',
  execution_id: 'exec-1',
}

describe('getFullJobContext TASK_REVIEW', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env['FORGEJO_HOSTS'] = 'git.jp-visser.nl'

    // Default mocks: job, task, impl context, compare diff
    mockPrisma.claudeJob.findUnique.mockResolvedValue(BASE_JOB)
    mockPrisma.task.findUnique.mockResolvedValue(BASE_TASK)
    mockPrisma.$executeRaw.mockResolvedValue(1)
    mockResolveTaskImplContext.mockResolvedValue(BASE_IMPL)
    mockFetchCompareDiff.mockResolvedValue('diff --git a b\n--- a\n+++ b')
    mockFetchPrDiff.mockResolvedValue(null)
  })

  // Structureel onherstelbaar → TerminalJobError, GEEN rollbackClaim. Zou de
  // code hier requeuen, dan claimt de volgende worker dezelfde job en faalt
  // identiek: de poison-loop die de fleet UNHEALTHY maakte (2026-07-09).
  it('TASK_REVIEW with task_id null → TerminalJobError, geen rollback', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({ ...BASE_JOB, task_id: null })

    await expect(getFullJobContext('job-task-review-1', 'CLAUDE')).rejects.toThrow(
      TerminalJobError,
    )
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
  })

  it('task.findUnique → null → TerminalJobError, geen rollback', async () => {
    mockPrisma.task.findUnique.mockResolvedValue(null)
    mockPrisma.claudeJob.findUnique.mockResolvedValue(BASE_JOB)

    await expect(getFullJobContext('job-task-review-1', 'CLAUDE')).rejects.toThrow(
      TerminalJobError,
    )
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
  })

  it('shas present (base≠head) + fetchCompareDiff returns string → diff_source compare, uses product repo_url when task.repo_url is null', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(BASE_JOB)
    mockPrisma.task.findUnique.mockResolvedValue({ ...BASE_TASK, repo_url: null })
    mockFetchCompareDiff.mockResolvedValue('diff --git a b\n')

    const ctx: any = await getFullJobContext('job-task-review-1', 'CLAUDE')

    expect(ctx).not.toBeNull()
    expect(ctx.impl.diff_source).toBe('compare')
    expect(ctx.task_diff).toBe('diff --git a b\n')
    // should use product.repo_url because task.repo_url is null
    expect(mockFetchCompareDiff).toHaveBeenCalledWith({
      repoUrl: PRODUCT_REPO_URL,
      baseSha: BASE_IMPL.base_sha,
      headSha: BASE_IMPL.head_sha,
    })
  })

  it('shas present + fetchCompareDiff uses task.repo_url when set (cross-repo)', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(BASE_JOB)
    mockPrisma.task.findUnique.mockResolvedValue({ ...BASE_TASK, repo_url: TASK_REPO_URL })
    mockFetchCompareDiff.mockResolvedValue('diff --git a b\n')

    const ctx: any = await getFullJobContext('job-task-review-1', 'CLAUDE')

    expect(ctx).not.toBeNull()
    expect(ctx.impl.diff_source).toBe('compare')
    // should use task.repo_url (cross-repo)
    expect(mockFetchCompareDiff).toHaveBeenCalledWith({
      repoUrl: TASK_REPO_URL,
      baseSha: BASE_IMPL.base_sha,
      headSha: BASE_IMPL.head_sha,
    })
  })

  it('base_sha === head_sha → fetchCompareDiff NOT called; pr_url present + fetchPrDiff returns string → diff_source pr', async () => {
    mockResolveTaskImplContext.mockResolvedValue({
      ...BASE_IMPL,
      base_sha: 'same-sha',
      head_sha: 'same-sha',
      pr_url: 'https://git.jp-visser.nl/acme/main-repo/pulls/5',
    })
    mockFetchPrDiff.mockResolvedValue('diff --git pr\n')

    const ctx: any = await getFullJobContext('job-task-review-1', 'CLAUDE')

    expect(ctx).not.toBeNull()
    expect(mockFetchCompareDiff).not.toHaveBeenCalled()
    expect(ctx.impl.diff_source).toBe('pr')
    expect(ctx.task_diff).toBe('diff --git pr\n')
  })

  it('fetchCompareDiff returns error + pr_url present + fetchPrDiff returns string → diff_source pr', async () => {
    mockFetchCompareDiff.mockResolvedValue({ error: 'compare failed' })
    mockFetchPrDiff.mockResolvedValue('diff --git fallback\n')

    const ctx: any = await getFullJobContext('job-task-review-1', 'CLAUDE')

    expect(ctx).not.toBeNull()
    expect(ctx.impl.diff_source).toBe('pr')
    expect(ctx.task_diff).toBe('diff --git fallback\n')
  })

  // Geen enkele diff-BRON → structureel → terminaal. Er is nooit een fetch
  // geprobeerd, dus herhalen kan het nooit oplossen.
  it('no diff source at all (no shas, no pr_url) → TerminalJobError, geen fetch, geen rollback', async () => {
    mockResolveTaskImplContext.mockResolvedValue({
      plan_snapshot: null,
      base_sha: null,
      head_sha: null,
      pr_url: null,
      execution_id: null,
    })
    mockPrisma.claudeJob.findUnique.mockResolvedValue(BASE_JOB)

    await expect(getFullJobContext('job-task-review-1', 'CLAUDE')).rejects.toThrow(
      TerminalJobError,
    )
    expect(mockFetchCompareDiff).not.toHaveBeenCalled()
    expect(mockFetchPrDiff).not.toHaveBeenCalled()
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
  })

  // Bronnen bestaan, maar de fetch faalt: Forgejo down, timeout, of de
  // reviewer-account mist repo-toegang. Dat is buiten de job om op te lossen →
  // requeue, NIET terminaal. Anders vernietigt één storing alle open reviews.
  it('both fetchers fail (sources present) → rollbackClaim + null, GEEN TerminalJobError', async () => {
    mockFetchCompareDiff.mockResolvedValue({ error: 'compare failed: HTTP 503' })
    mockFetchPrDiff.mockResolvedValue({ error: 'pr diff failed: HTTP 503' })
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce(BASE_JOB)
      .mockResolvedValueOnce({ kind: 'TASK_REVIEW', product_id: 'prod-1', task: null })

    const ctx = await getFullJobContext('job-task-review-1', 'CLAUDE')

    expect(ctx).toBeNull()
    expect(mockPrisma.$executeRaw).toHaveBeenCalled()
  })

  // Regressie-vangnet voor de 2026-07-09-storing: een 404 van de compare-API
  // (repo bestaat, maar het reviewer-account is geen collaborator) mag de job
  // NIET vernietigen — die is oplosbaar door rechten te geven.
  it('compare 404 + geen pr_url → rollbackClaim + null, GEEN TerminalJobError', async () => {
    mockResolveTaskImplContext.mockResolvedValue({ ...BASE_IMPL, pr_url: null })
    mockFetchCompareDiff.mockResolvedValue({ error: 'compare failed: HTTP 404' })
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce(BASE_JOB)
      .mockResolvedValueOnce({ kind: 'TASK_REVIEW', product_id: 'prod-1', task: null })

    const ctx = await getFullJobContext('job-task-review-1', 'CLAUDE')

    expect(ctx).toBeNull()
    expect(mockFetchPrDiff).not.toHaveBeenCalled()
    expect(mockPrisma.$executeRaw).toHaveBeenCalled()
  })

  it('happy path payload shape', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({ ...BASE_TASK, repo_url: null })
    mockFetchCompareDiff.mockResolvedValue('diff --git a b\n--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new')

    const ctx: any = await getFullJobContext('job-task-review-1', 'CLAUDE')

    expect(ctx).not.toBeNull()
    expect(ctx.kind).toBe('TASK_REVIEW')
    expect(ctx.source).toBe('MANUAL')
    expect(ctx.status).toBe('claimed')

    // task block
    expect(ctx.task).toMatchObject({
      id: 'task-1',
      title: 'Implement feature X',
      status: 'DONE',
      implementation_plan: 'Plan text here',
      acceptance_criteria: 'Must pass all tests.',
    })

    // impl block
    expect(ctx.impl).toMatchObject({
      plan_snapshot: BASE_IMPL.plan_snapshot,
      base_sha: BASE_IMPL.base_sha,
      head_sha: BASE_IMPL.head_sha,
      pr_url: BASE_IMPL.pr_url,
      execution_id: BASE_IMPL.execution_id,
      diff_source: 'compare',
    })

    // task_diff present
    expect(typeof ctx.task_diff).toBe('string')
    expect(ctx.task_diff).toContain('diff --git')

    // instruction from manual_drafts[0].prompt_md
    expect(ctx.instruction).toBe('review de task-implementatie')

    // product block
    expect(ctx.product).toMatchObject({
      id: 'prod-1',
      name: 'Scrum4Me',
      repo_url: PRODUCT_REPO_URL,
      definition_of_done: 'Tests groen.',
    })

    // repo_url = diff repo (product.repo_url when task.repo_url is null)
    expect(ctx.repo_url).toBe(PRODUCT_REPO_URL)

    // prompt_text is empty string
    expect(ctx.prompt_text).toBe('')

    // config and doc_index present
    expect(ctx).toHaveProperty('config')
    expect(ctx).toHaveProperty('doc_index')

    // NOT the generic manual payload
    expect(ctx).not.toHaveProperty('manual_job')
    expect(ctx).not.toHaveProperty('manual_draft')
  })
})
