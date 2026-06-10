import { beforeEach, describe, expect, it, vi } from 'vitest'

// Must be called before imports that touch the mocked modules.
vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
  },
}))

vi.mock('../../src/git/pr.js', () => ({
  fetchPrDiff: vi.fn(),
  getPullRequestState: vi.fn(),
}))

vi.mock('../../src/lib/pr-linked-plan.js', () => ({
  resolvePrLinkedPlan: vi.fn(),
}))

// parseForgejoPrUrl is kept REAL (actual implementation) so index=42 is genuinely parsed.
// We use vi.importActual spread for this.
vi.mock('../../src/git/forgejo-rest.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/git/forgejo-rest.js')>()
  return { ...actual }
})

// doc-index: best-effort, return null so it doesn't interfere.
vi.mock('../../src/lib/doc-index.js', () => ({
  buildDocIndex: vi.fn().mockResolvedValue(null),
}))

// job-config: return a stable minimal config object.
vi.mock('../../src/lib/job-config.js', () => ({
  resolveJobConfig: vi.fn().mockReturnValue({
    model: 'claude-sonnet-4-5-20251001',
    thinking_budget: null,
    permission_mode: 'default',
  }),
}))

import { prisma } from '../../src/prisma.js'
import { fetchPrDiff, getPullRequestState } from '../../src/git/pr.js'
import { resolvePrLinkedPlan } from '../../src/lib/pr-linked-plan.js'
import { getFullJobContext } from '../../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
  $executeRaw: ReturnType<typeof vi.fn>
}

const mockFetchPrDiff = fetchPrDiff as ReturnType<typeof vi.fn>
const mockGetPrState = getPullRequestState as ReturnType<typeof vi.fn>
const mockResolvePrLinkedPlan = resolvePrLinkedPlan as ReturnType<typeof vi.fn>

const PR = 'https://git.jp-visser.nl/janpeter/scrum4me-mcp/pulls/42'

const BASE_JOB = {
  id: 'job1',
  kind: 'PR_REVIEW',
  source: 'MANUAL',
  status: 'CLAIMED',
  requested_model: null,
  requested_thinking_budget: null,
  requested_permission_mode: null,
  task: null,
  idea: null,
  sprint_run_id: null,
  pr_url: PR,
  manual_drafts: [
    {
      id: 'd',
      title: 'Review',
      adapter: 'claude_messages_api',
      required_capability: null,
      prompt_md: 'review grondig',
      launch_preview_json: {},
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
}

describe('getFullJobContext PR_REVIEW', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default env so parseForgejoPrUrl passes the host whitelist
    process.env['FORGEJO_HOSTS'] = 'git.jp-visser.nl'

    // Default mocks
    mockPrisma.claudeJob.findUnique.mockResolvedValue(BASE_JOB)
    mockPrisma.$executeRaw.mockResolvedValue(1)
    mockFetchPrDiff.mockResolvedValue('diff --git a b\n--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new')
    mockGetPrState.mockResolvedValue({
      state: 'OPEN',
      title: 'T',
      baseRefName: 'main',
      headSha: 'sha1',
      mergeCommit: null,
    })
    mockResolvePrLinkedPlan.mockResolvedValue({ source: 'job', plan_snapshot: 'P' })
  })

  it('MANUAL PR_REVIEW → pr/pr_diff/linked_plan-payload (niet de generieke manual-payload)', async () => {
    const ctx: any = await getFullJobContext('job1')

    expect(ctx).not.toBeNull()
    expect(ctx.kind).toBe('PR_REVIEW')
    expect(ctx.source).toBe('MANUAL')
    expect(ctx.status).toBe('claimed')

    // pr-object met juiste velden
    expect(ctx.pr).toMatchObject({
      url: PR,
      owner: 'janpeter',
      repo: 'scrum4me-mcp',
      index: 42,
      host: 'git.jp-visser.nl',
      title: 'T',
      base_ref: 'main',
      head_sha: 'sha1',
    })

    // pr_diff is een string die de diff bevat
    expect(typeof ctx.pr_diff).toBe('string')
    expect(ctx.pr_diff).toContain('diff --git')

    // linked_plan aanwezig
    expect(ctx.linked_plan).toMatchObject({ source: 'job' })

    // instruction komt uit de draft
    expect(ctx.instruction).toBe('review grondig')

    // product-block
    expect(ctx.product).toMatchObject({
      id: 'prod-1',
      name: 'Scrum4Me',
    })

    // Cruciale check: GEEN manual_job-veld (niet de generieke manual-payload)
    expect(ctx).not.toHaveProperty('manual_job')
    expect(ctx).not.toHaveProperty('manual_draft')

    // config en doc_index aanwezig (van vóór de branch)
    expect(ctx).toHaveProperty('config')
    expect(ctx).toHaveProperty('doc_index')
  })

  it('PR_REVIEW zonder pr_url → rollbackClaim + null', async () => {
    // findUnique wordt tweemaal aangeroepen: één keer door getFullJobContext,
    // één keer door rollbackClaim (om kind/product_id/task.repo_url op te halen).
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce({ ...BASE_JOB, pr_url: null })
      // rollbackClaim's interne findUnique
      .mockResolvedValueOnce({ kind: 'PR_REVIEW', product_id: 'prod-1', task: null })

    const ctx = await getFullJobContext('job1')

    expect(ctx).toBeNull()

    // rollbackClaim heeft $executeRaw aangeroepen (de DB-UPDATE naar QUEUED)
    expect(mockPrisma.$executeRaw).toHaveBeenCalled()
  })

  it('PR_REVIEW met onparseerbare pr_url → rollbackClaim + null', async () => {
    // findUnique wordt tweemaal aangeroepen: één keer door getFullJobContext,
    // één keer door rollbackClaim (om kind/product_id/task.repo_url op te halen).
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce({ ...BASE_JOB, pr_url: 'https://github.com/x/y/pulls/1' })
      // rollbackClaim's interne findUnique
      .mockResolvedValueOnce({ kind: 'PR_REVIEW', product_id: 'prod-1', task: null })

    const ctx = await getFullJobContext('job1')

    expect(ctx).toBeNull()

    // rollbackClaim heeft $executeRaw aangeroepen (de DB-UPDATE naar QUEUED)
    expect(mockPrisma.$executeRaw).toHaveBeenCalled()
  })
})
