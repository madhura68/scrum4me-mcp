import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn() },
    // rollbackClaim's QUEUED-reset (mis-config-gate-test hieronder).
    $executeRaw: vi.fn(async () => 1),
  },
}))

import { prisma } from '../src/prisma.js'
import { getFullJobContext } from '../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn> }
  $executeRaw: ReturnType<typeof vi.fn>
}

const BASE_PRODUCT = {
  id: 'prod-1',
  name: 'Scrum4Me',
  repo_url: 'https://git.jp-visser.nl/janpeter/Scrum4Me.git',
  definition_of_done: 'Tests groen.',
  preferred_model: null,
  thinking_budget_default: null,
  preferred_permission_mode: null,
  auto_deploy: true,
  deploy_flow: 'update_scrum4me_web',
}

const BASE_JOB = {
  id: 'job-deploy-1234',
  kind: 'DEPLOY',
  status: 'CLAIMED',
  requested_model: null,
  requested_thinking_budget: null,
  requested_permission_mode: null,
  task: null,
  idea: null,
  sprint_run_id: null,
  manual_drafts: [],
  orchestration_key: null,
  pr_url: null,
  head_sha: null,
  base_sha: null,
}

// M17 (spec §5): getFullJobContext-payload voor de deploy-agent. Volgt het
// PR_REVIEW/MANUAL-context-testpatroon (mock claudeJob.findUnique volledig,
// assert via toMatchObject).
describe('getFullJobContext DEPLOY jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('auto-mode (pr_url gezet, source SYSTEM): mode=auto + volledige deploy-payload', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      ...BASE_JOB,
      source: 'SYSTEM',
      pr_url: 'https://git.jp-visser.nl/janpeter/Scrum4Me/pulls/91',
      head_sha: 'abc123',
      base_sha: 'def456',
      orchestration_key: 'auto:deploy:janpeter/Scrum4Me#91@abc123',
      product: BASE_PRODUCT,
    })

    const context = await getFullJobContext('job-deploy-1234', 'CLAUDE')

    expect(context).toMatchObject({
      job_id: 'job-deploy-1234',
      kind: 'DEPLOY',
      source: 'SYSTEM',
      status: 'claimed',
      deploy: {
        mode: 'auto',
        pr_url: 'https://git.jp-visser.nl/janpeter/Scrum4Me/pulls/91',
        head_sha: 'abc123',
        base_sha: 'def456',
        orchestration_key: 'auto:deploy:janpeter/Scrum4Me#91@abc123',
        deploy_flow: 'update_scrum4me_web',
      },
      product: {
        id: 'prod-1',
        name: 'Scrum4Me',
        repo_url: 'https://git.jp-visser.nl/janpeter/Scrum4Me.git',
        definition_of_done: 'Tests groen.',
      },
      repo_url: 'https://git.jp-visser.nl/janpeter/Scrum4Me.git',
      prompt_text: '',
    })
    // Geen worktree/branch-suggestie voor DEPLOY (spec §5, plan Task 3.3-check).
    expect(context).not.toHaveProperty('worktree_path')
    expect(context).not.toHaveProperty('branch_suggestion')
  })

  it('manual-mode (geen pr_url, source MANUAL, geen manual_draft): mode=manual, MANUAL-branch niet getriggerd', async () => {
    // Bewijst de branch-plaatsing (plan self-review): een handmatige DEPLOY
    // via "Deploy nu" heeft source=MANUAL maar GEEN manual_drafts-rij. Als de
    // DEPLOY-branch ná de source==='MANUAL'-check zou staan, zou dit
    // rollbacken (return null) omdat draft ontbreekt.
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      ...BASE_JOB,
      source: 'MANUAL',
      manual_drafts: [],
      product: BASE_PRODUCT,
    })

    const context = await getFullJobContext('job-deploy-1234', 'CLAUDE')

    expect(context).not.toBeNull()
    expect(context).toMatchObject({
      kind: 'DEPLOY',
      source: 'MANUAL',
      status: 'claimed',
      deploy: {
        mode: 'manual',
        pr_url: null,
        head_sha: null,
        base_sha: null,
        orchestration_key: null,
        deploy_flow: 'update_scrum4me_web',
      },
    })
    expect(context).not.toHaveProperty('manual_job')
    expect(context).not.toHaveProperty('manual_draft')
  })

  it('mis-config (deploy_flow null): null + rollbackClaim reset naar QUEUED', async () => {
    // Gate-dekking (spec-review): zonder de !job.product.deploy_flow-gate
    // zou dit een payload met deploy_flow: null opleveren i.p.v. null.
    // Eerste findUnique = main-lookup van getFullJobContext; tweede =
    // rollbackClaim's cleanup-lookup (kind/product_id/task-select).
    // product_id: null slaat de worktree-cleanup-tak bewust over — de
    // QUEUED-reset ($executeRaw) is de te bewijzen kern.
    mockPrisma.claudeJob.findUnique
      .mockResolvedValueOnce({
        ...BASE_JOB,
        source: 'SYSTEM',
        product: { ...BASE_PRODUCT, auto_deploy: false, deploy_flow: null },
      })
      .mockResolvedValueOnce({ kind: 'DEPLOY', product_id: null, branch: null, task: null })

    const context = await getFullJobContext('job-deploy-1234', 'CLAUDE')

    expect(context).toBeNull()
    expect(mockPrisma.claudeJob.findUnique).toHaveBeenCalledTimes(2)
    // rollbackClaim's cleanup-lookup gebruikt de compacte select.
    expect(mockPrisma.claudeJob.findUnique).toHaveBeenNthCalledWith(2, {
      where: { id: 'job-deploy-1234' },
      select: {
        kind: true,
        product_id: true,
        branch: true,
        task: { select: { repo_url: true } },
      },
    })
    // De QUEUED-reset: tagged-template call → [strings, ...values].
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1)
    const [strings, ...values] = mockPrisma.$executeRaw.mock.calls[0] as [
      readonly string[],
      ...unknown[],
    ]
    const sql = strings.join('?')
    expect(sql).toContain("SET status = 'QUEUED'")
    expect(sql).toContain('claimed_by_token_id = NULL')
    expect(sql).toContain('lease_until = NULL')
    expect(values).toEqual(['job-deploy-1234'])
  })
})
