import { beforeEach, describe, expect, it, vi } from 'vitest'

// Must be called before imports that touch the mocked modules.
vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn() },
    productDoc: { findUnique: vi.fn() },
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
import { getFullJobContext } from '../../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
  productDoc: { findUnique: ReturnType<typeof vi.fn> }
  $executeRaw: ReturnType<typeof vi.fn>
}

const BASE_JOB = {
  id: 'job-spec-1',
  kind: 'SPEC_REVIEW',
  source: 'MANUAL',
  status: 'CLAIMED',
  requested_model: null,
  requested_thinking_budget: null,
  requested_permission_mode: null,
  task: null,
  idea: null,
  sprint_run_id: null,
  pr_url: null,
  doc_id: 'doc-1',
  manual_drafts: [
    {
      id: 'draft-1',
      title: 'Review spec',
      adapter: 'claude_messages_api',
      required_capability: null,
      prompt_md: 'review deze spec grondig',
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

const BASE_DOC = {
  id: 'doc-1',
  slug: 'my-feature-spec',
  folder: 'SPECS',
  title: 'My Feature Spec',
  status: 'ACTIVE',
  current_revision: {
    id: 'rev-1',
    revision: 3,
    content_md: '# My Feature Spec\n\nSpec content here.',
  },
}

// NB: de claim-lijst zelf (CLAIMABLE_STANDALONE_KINDS incl. beide nieuwe kinds)
// wordt geasserteerd in wait-for-job-runtime-claim.test.ts op het SQL-fragment
// dat daadwerkelijk de DB raakt — geen brontekst-scan hier (kwaliteitsreview).

describe('getFullJobContext SPEC_REVIEW', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env['FORGEJO_HOSTS'] = 'git.jp-visser.nl'

    // Default mocks
    mockPrisma.claudeJob.findUnique.mockResolvedValue(BASE_JOB)
    mockPrisma.productDoc.findUnique.mockResolvedValue(BASE_DOC)
    mockPrisma.$executeRaw.mockResolvedValue(1)
  })

  it('SPEC_REVIEW zonder doc_id → rollbackClaim aangeroepen + null', async () => {
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce({ ...BASE_JOB, doc_id: null })
      // rollbackClaim's interne findUnique
      .mockResolvedValueOnce({ kind: 'SPEC_REVIEW', product_id: 'prod-1', task: null })

    const ctx = await getFullJobContext('job-spec-1')

    expect(ctx).toBeNull()
    expect(mockPrisma.$executeRaw).toHaveBeenCalled()
  })

  it('SPEC_REVIEW met doc_id maar doc niet gevonden → rollbackClaim + null', async () => {
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce(BASE_JOB)
      // rollbackClaim's interne findUnique
      .mockResolvedValueOnce({ kind: 'SPEC_REVIEW', product_id: 'prod-1', task: null })
    mockPrisma.productDoc.findUnique.mockResolvedValue(null)

    const ctx = await getFullJobContext('job-spec-1')

    expect(ctx).toBeNull()
    expect(mockPrisma.$executeRaw).toHaveBeenCalled()
  })

  it('SPEC_REVIEW met doc.folder !== SPECS → rollbackClaim + null', async () => {
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce(BASE_JOB)
      // rollbackClaim's interne findUnique
      .mockResolvedValueOnce({ kind: 'SPEC_REVIEW', product_id: 'prod-1', task: null })
    mockPrisma.productDoc.findUnique.mockResolvedValue({ ...BASE_DOC, folder: 'PLANS' })

    const ctx = await getFullJobContext('job-spec-1')

    expect(ctx).toBeNull()
    expect(mockPrisma.$executeRaw).toHaveBeenCalled()
  })

  it('SPEC_REVIEW met doc zonder current_revision → rollbackClaim + null', async () => {
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce(BASE_JOB)
      // rollbackClaim's interne findUnique
      .mockResolvedValueOnce({ kind: 'SPEC_REVIEW', product_id: 'prod-1', task: null })
    mockPrisma.productDoc.findUnique.mockResolvedValue({ ...BASE_DOC, current_revision: null })

    const ctx = await getFullJobContext('job-spec-1')

    expect(ctx).toBeNull()
    expect(mockPrisma.$executeRaw).toHaveBeenCalled()
  })

  it('SPEC_REVIEW met current_revision maar leeg content_md → rollbackClaim + null', async () => {
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce(BASE_JOB)
      // rollbackClaim's interne findUnique
      .mockResolvedValueOnce({ kind: 'SPEC_REVIEW', product_id: 'prod-1', task: null })
    mockPrisma.productDoc.findUnique.mockResolvedValue({
      ...BASE_DOC,
      current_revision: { id: 'rev-1', revision: 1, content_md: '' },
    })

    const ctx = await getFullJobContext('job-spec-1')

    expect(ctx).toBeNull()
    expect(mockPrisma.$executeRaw).toHaveBeenCalled()
  })

  it('SPEC_REVIEW happy path → correcte payload met kind SPEC_REVIEW', async () => {
    const ctx: any = await getFullJobContext('job-spec-1')

    expect(ctx).not.toBeNull()
    expect(ctx.kind).toBe('SPEC_REVIEW')
    expect(ctx.source).toBe('MANUAL')
    expect(ctx.status).toBe('claimed')

    // spec_doc met alle velden
    expect(ctx.spec_doc).toMatchObject({
      id: 'doc-1',
      slug: 'my-feature-spec',
      folder: 'SPECS',
      title: 'My Feature Spec',
      status: 'ACTIVE',
      revision_id: 'rev-1',
      revision: 3,
      content_md: '# My Feature Spec\n\nSpec content here.',
    })

    // instruction uit de draft
    expect(ctx.instruction).toBe('review deze spec grondig')

    // doc_index passthrough (null in tests)
    expect(ctx).toHaveProperty('doc_index')

    // product-block
    expect(ctx.product).toMatchObject({
      id: 'prod-1',
      name: 'Scrum4Me',
      repo_url: 'https://github.com/acme/scrum4me.git',
      definition_of_done: 'Tests groen.',
    })

    // prompt_text leeg (runner is gezaghebbend)
    expect(ctx.prompt_text).toBe('')

    // config aanwezig
    expect(ctx).toHaveProperty('config')

    // Geen manual_job/manual_draft veld (niet de generieke manual-payload)
    expect(ctx).not.toHaveProperty('manual_job')
    expect(ctx).not.toHaveProperty('manual_draft')
  })
})
