import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    product: { findUnique: vi.fn() },
    task: { findUnique: vi.fn() },
    claudeJob: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  },
}))

vi.mock('../src/git/pr.js', () => ({
  createPullRequest: vi.fn(),
  markPullRequestReady: vi.fn(),
  getPullRequestState: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { createPullRequest, getPullRequestState } from '../src/git/pr.js'
import { maybeCreateAutoPr } from '../src/tools/update-job-status.js'

const mockPrisma = prisma as unknown as {
  product: { findUnique: ReturnType<typeof vi.fn> }
  task: { findUnique: ReturnType<typeof vi.fn> }
  claudeJob: {
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    findUnique: ReturnType<typeof vi.fn>
  }
}
const mockCreatePr = createPullRequest as ReturnType<typeof vi.fn>
const mockPrState = getPullRequestState as ReturnType<typeof vi.fn>

const BASE_OPTS = {
  jobId: 'job-abc',
  productId: 'prod-1',
  taskId: 'task-1',
  worktreePath: '/wt/job-abc',
  branchName: 'feat/job-abc',
  summary: 'Implemented the feature',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.product.findUnique.mockResolvedValue({ auto_pr: true })
  mockPrisma.task.findUnique.mockResolvedValue({
    title: 'Add feature',
    repo_url: null,
    story: { id: 'story-1', code: 'SCRUM-42', title: 'Story title' },
  })
  mockPrisma.claudeJob.findMany.mockResolvedValue([]) // no sibling PRs by default
  // Default: legacy job zonder sprint_run (STORY-mode pad).
  mockPrisma.claudeJob.findUnique.mockResolvedValue({ sprint_run_id: null, sprint_run: null })
  mockCreatePr.mockResolvedValue({ url: 'https://github.com/org/repo/pull/99' })
  // Default: sibling-PR's staan nog OPEN — hergebruik-tests behouden zo hun
  // oorspronkelijke semantiek; de merged/closed-paden overriden dit expliciet.
  mockPrState.mockResolvedValue({
    state: 'OPEN',
    mergeCommit: null,
    baseRefName: 'main',
    title: 'Sibling PR',
    headSha: 'abc123',
  })
})

describe('maybeCreateAutoPr', () => {
  it('returns PR URL when auto_pr=true and gh succeeds (story-scoped title)', async () => {
    const url = await maybeCreateAutoPr(BASE_OPTS)
    expect(url).toBe('https://github.com/org/repo/pull/99')
    expect(mockCreatePr).toHaveBeenCalledWith({
      worktreePath: BASE_OPTS.worktreePath,
      branchName: BASE_OPTS.branchName,
      title: 'SCRUM-42: Story title',
      body: expect.stringContaining(BASE_OPTS.summary),
    })
  })

  it('reuses sibling pr_url when another job in same story already opened a PR', async () => {
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      { pr_url: 'https://github.com/org/repo/pull/77', task: { repo_url: null } },
    ])
    const url = await maybeCreateAutoPr(BASE_OPTS)
    expect(url).toBe('https://github.com/org/repo/pull/77')
    expect(mockCreatePr).not.toHaveBeenCalled()
  })

  it('does NOT reuse a sibling PR from a different repo (cross-repo story)', async () => {
    // Sibling targeted another repo via task.repo_url — its PR must not leak in.
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      {
        pr_url: 'https://github.com/org/other-repo/pull/12',
        task: { repo_url: 'https://github.com/org/other-repo' },
      },
    ])
    const url = await maybeCreateAutoPr(BASE_OPTS)
    expect(url).toBe('https://github.com/org/repo/pull/99') // fresh PR, not the sibling's
    expect(mockCreatePr).toHaveBeenCalledOnce()
  })

  it('returns null when auto_pr=false', async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ auto_pr: false })
    const url = await maybeCreateAutoPr(BASE_OPTS)
    expect(url).toBeNull()
    expect(mockCreatePr).not.toHaveBeenCalled()
  })

  it('uses story title without code prefix when story has no code', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      title: 'Add feature',
      repo_url: null,
      story: { id: 'story-1', code: null, title: 'Story title' },
    })
    await maybeCreateAutoPr(BASE_OPTS)
    expect(mockCreatePr).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Story title' }),
    )
  })

  it('SPRINT-mode: maakt een draft-PR aan met sprint-titel, geen auto-merge', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      sprint_run_id: 'run-1',
      sprint_run: {
        id: 'run-1',
        pr_strategy: 'SPRINT',
        sprint: { sprint_goal: 'Cascade-flow live' },
      },
    })

    const url = await maybeCreateAutoPr(BASE_OPTS)

    expect(url).toBe('https://github.com/org/repo/pull/99')
    expect(mockCreatePr).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Sprint: Cascade-flow live',
        draft: true,
        enableAutoMerge: false,
      }),
    )
  })

  it('SPRINT-mode: hergebruikt sibling-PR binnen dezelfde SprintRun', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      sprint_run_id: 'run-1',
      sprint_run: { id: 'run-1', pr_strategy: 'SPRINT', sprint: { sprint_goal: 'Goal' } },
    })
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      { pr_url: 'https://github.com/org/repo/pull/55', task: { repo_url: null } },
    ])

    const url = await maybeCreateAutoPr(BASE_OPTS)

    expect(url).toBe('https://github.com/org/repo/pull/55')
    expect(mockCreatePr).not.toHaveBeenCalled()
  })

  it('SPRINT-mode: cross-repo — sibling-PR van ander repo wordt niet hergebruikt', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({
      sprint_run_id: 'run-1',
      sprint_run: { id: 'run-1', pr_strategy: 'SPRINT', sprint: { sprint_goal: 'Goal' } },
    })
    // Deze job target een ander repo via task.repo_url.
    mockPrisma.task.findUnique.mockResolvedValue({
      title: 'MCP-taak',
      repo_url: 'https://github.com/org/scrum4me-mcp',
      story: { id: 'story-1', code: 'SCRUM-9', title: 'Story title' },
    })
    // Sibling met pr_url hoort bij het product-repo (repo_url null) → andere bucket.
    mockPrisma.claudeJob.findMany.mockResolvedValue([
      { pr_url: 'https://github.com/org/repo/pull/201', task: { repo_url: null } },
    ])

    const url = await maybeCreateAutoPr(BASE_OPTS)

    // Geen hergebruik van de product-repo PR → eigen draft-PR voor het mcp-repo.
    expect(url).toBe('https://github.com/org/repo/pull/99')
    expect(mockCreatePr).toHaveBeenCalledOnce()
  })

  it('returns null and does not throw when gh fails', async () => {
    mockCreatePr.mockResolvedValue({ error: 'gh CLI not found' })
    const url = await maybeCreateAutoPr(BASE_OPTS)
    expect(url).toBeNull()
  })

  // M17 E2E-bevinding #5: hergebruik van een GEMERGDE/dichte sibling-PR
  // strandde de commit van een latere taak (T-1382 op gemergde #105) en
  // brak de auto-review→auto-merge→deploy-keten.
  describe('sibling-PR-hergebruik alleen bij OPEN (bevinding #5)', () => {
    it('STORY-mode: gemergde sibling-PR wordt NIET hergebruikt → nieuwe PR', async () => {
      mockPrisma.claudeJob.findMany.mockResolvedValue([
        { pr_url: 'https://github.com/org/repo/pull/77', task: { repo_url: null } },
      ])
      mockPrState.mockResolvedValue({
        state: 'MERGED',
        mergeCommit: 'deadbeef',
        baseRefName: 'main',
        title: 'Oude story-PR',
        headSha: 'abc123',
      })
      const url = await maybeCreateAutoPr(BASE_OPTS)
      expect(mockPrState).toHaveBeenCalledWith({ prUrl: 'https://github.com/org/repo/pull/77' })
      expect(url).toBe('https://github.com/org/repo/pull/99')
      expect(mockCreatePr).toHaveBeenCalledOnce()
    })

    it('STORY-mode: eerste OPEN kandidaat wint bij meerdere siblings (geen PR-stapeling)', async () => {
      mockPrisma.claudeJob.findMany.mockResolvedValue([
        { pr_url: 'https://github.com/org/repo/pull/77', task: { repo_url: null } },
        { pr_url: 'https://github.com/org/repo/pull/78', task: { repo_url: null } },
      ])
      mockPrState
        .mockResolvedValueOnce({ state: 'MERGED', mergeCommit: 'x', baseRefName: 'main', title: 't', headSha: 'a' })
        .mockResolvedValueOnce({ state: 'OPEN', mergeCommit: null, baseRefName: 'main', title: 't', headSha: 'b' })
      const url = await maybeCreateAutoPr(BASE_OPTS)
      expect(url).toBe('https://github.com/org/repo/pull/78')
      expect(mockCreatePr).not.toHaveBeenCalled()
    })

    it('STORY-mode: dubbele sibling-URLs worden maar één keer gecheckt', async () => {
      mockPrisma.claudeJob.findMany.mockResolvedValue([
        { pr_url: 'https://github.com/org/repo/pull/77', task: { repo_url: null } },
        { pr_url: 'https://github.com/org/repo/pull/77', task: { repo_url: null } },
      ])
      mockPrState.mockResolvedValue({ state: 'MERGED', mergeCommit: 'x', baseRefName: 'main', title: 't', headSha: 'a' })
      await maybeCreateAutoPr(BASE_OPTS)
      expect(mockPrState).toHaveBeenCalledTimes(1)
    })

    it('lookup-fout ⇒ hergebruik op oud gedrag (geen PR-spam bij haperende Forgejo)', async () => {
      mockPrisma.claudeJob.findMany.mockResolvedValue([
        { pr_url: 'https://github.com/org/repo/pull/77', task: { repo_url: null } },
      ])
      mockPrState.mockResolvedValue({ error: 'Forgejo pr-get failed: 503' })
      const url = await maybeCreateAutoPr(BASE_OPTS)
      expect(url).toBe('https://github.com/org/repo/pull/77')
      expect(mockCreatePr).not.toHaveBeenCalled()
    })

    it('SPRINT-mode: gemergde sibling-PR wordt NIET hergebruikt → nieuwe draft-PR', async () => {
      mockPrisma.claudeJob.findUnique.mockResolvedValue({
        sprint_run_id: 'run-1',
        sprint_run: { id: 'run-1', pr_strategy: 'SPRINT', sprint: { sprint_goal: 'Goal' } },
      })
      mockPrisma.claudeJob.findMany.mockResolvedValue([
        { pr_url: 'https://github.com/org/repo/pull/55', task: { repo_url: null } },
      ])
      mockPrState.mockResolvedValue({
        state: 'MERGED',
        mergeCommit: 'x',
        baseRefName: 'main',
        title: 't',
        headSha: 'a',
      })
      const url = await maybeCreateAutoPr(BASE_OPTS)
      expect(url).toBe('https://github.com/org/repo/pull/99')
      expect(mockCreatePr).toHaveBeenCalledWith(expect.objectContaining({ draft: true }))
    })
  })

  it('returns null when product not found', async () => {
    mockPrisma.product.findUnique.mockResolvedValue(null)
    const url = await maybeCreateAutoPr(BASE_OPTS)
    expect(url).toBeNull()
    expect(mockCreatePr).not.toHaveBeenCalled()
  })
})
