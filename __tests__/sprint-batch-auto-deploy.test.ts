import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted voor álle mock-fns (geen buitenliggende const in een vi.mock-
// factory). Aliassen daaronder houden de cases leesbaar.
const prismaMocks = vi.hoisted(() => ({
  product: { findUnique: vi.fn() },
  sprintRun: { findUnique: vi.fn() },
  claudeJob: { findMany: vi.fn() },
}))
const deployJobMocks = vi.hoisted(() => ({ checkDeployEligibility: vi.fn(), maybeEnqueueDeployJob: vi.fn() }))
const effectsMocks = vi.hoisted(() => ({ executeEffects: vi.fn() }))
const prMocks = vi.hoisted(() => ({ getPullRequestState: vi.fn() }))
const pushMocks = vi.hoisted(() => ({ triggerPush: vi.fn() }))

vi.mock('../src/prisma.js', () => ({ prisma: prismaMocks }))
vi.mock('../src/lib/dispatch/deploy-job.js', () => deployJobMocks)
vi.mock('../src/flow/effects.js', () => effectsMocks)
vi.mock('../src/git/pr.js', () => prMocks)
vi.mock('../src/lib/push-trigger.js', () => pushMocks)

import { maybeAutoDeploySprintBatchPr } from '../src/lib/dispatch/sprint-batch-deploy.js'

// Aliassen (ná de mocks; geen factory-referentie).
const mockProductFindUnique = prismaMocks.product.findUnique
const mockSprintRunFindUnique = prismaMocks.sprintRun.findUnique
const mockJobFindMany = prismaMocks.claudeJob.findMany
const mockCheckEligibility = deployJobMocks.checkDeployEligibility
const mockExecuteEffects = effectsMocks.executeEffects
const mockEnqueue = deployJobMocks.maybeEnqueueDeployJob
const mockGetPrState = prMocks.getPullRequestState
const mockTriggerPush = pushMocks.triggerPush

const BASE = { jobId: 'job-1', userId: 'u1', productId: 'p1', sprintRunId: 'sr1' }
const PR = 'https://git/janpeter/Scrum4Me/pulls/9'

beforeEach(() => {
  vi.clearAllMocks()
  mockProductFindUnique.mockResolvedValue({ repo_url: 'https://git/janpeter/Scrum4Me' })
  mockSprintRunFindUnique.mockResolvedValue({ status: 'DONE' })
  mockJobFindMany.mockResolvedValue([{ pr_url: PR, task: { repo_url: null }, head_sha: 'sha-head' }])
  mockGetPrState.mockResolvedValue({ state: 'OPEN', headSha: 'sha-head', mergeCommit: null, baseRefName: 'main', title: 't' })
  mockCheckEligibility.mockResolvedValue('eligible')
  mockExecuteEffects.mockResolvedValue([{ effect: 'ENABLE_AUTO_MERGE', ok: true }])
  mockEnqueue.mockResolvedValue('enqueued')
})

describe('maybeAutoDeploySprintBatchPr', () => {
  it('happy path: eligible → ENABLE_AUTO_MERGE → enqueue', async () => {
    await maybeAutoDeploySprintBatchPr(BASE)
    expect(mockExecuteEffects).toHaveBeenCalledWith([{ type: 'ENABLE_AUTO_MERGE', prUrl: PR, expectedHeadSha: 'sha-head' }])
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ prUrl: PR, headSha: 'sha-head' }))
  })

  it('level-trigger: SprintRun niet DONE → niets', async () => {
    mockSprintRunFindUnique.mockResolvedValue({ status: 'RUNNING' })
    await maybeAutoDeploySprintBatchPr(BASE)
    expect(mockCheckEligibility).not.toHaveBeenCalled()
    expect(mockExecuteEffects).not.toHaveBeenCalled()
  })

  it('opt-in-gate: not_configured → geen auto-merge, geen enqueue', async () => {
    mockCheckEligibility.mockResolvedValue('not_configured')
    await maybeAutoDeploySprintBatchPr(BASE)
    expect(mockExecuteEffects).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('blocked → geen auto-merge, wel web-push', async () => {
    mockCheckEligibility.mockResolvedValue('blocked')
    await maybeAutoDeploySprintBatchPr(BASE)
    expect(mockExecuteEffects).not.toHaveBeenCalled()
    expect(mockTriggerPush).toHaveBeenCalled()
  })

  it('enable-fail → GEEN enqueue (geen DEPLOY-job vóór geslaagde enable)', async () => {
    mockExecuteEffects.mockResolvedValue([{ effect: 'ENABLE_AUTO_MERGE', ok: false, reason: 'AUTO_MERGE_NOT_ALLOWED', stderr: '' }])
    await maybeAutoDeploySprintBatchPr(BASE)
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockTriggerPush).toHaveBeenCalled()
  })

  it('tweede-check-race: enable ok maar enqueue blocked → web-push', async () => {
    mockEnqueue.mockResolvedValue('blocked')
    await maybeAutoDeploySprintBatchPr(BASE)
    expect(mockTriggerPush).toHaveBeenCalled()
  })

  it('repo-bucket: cross-repo PR eerst → product-repo-PR wordt gekozen', async () => {
    mockJobFindMany.mockResolvedValue([
      { pr_url: 'https://git/janpeter/scrum4me-mcp/pulls/3', task: { repo_url: 'https://git/janpeter/scrum4me-mcp' }, head_sha: 'sha-mcp' },
      { pr_url: PR, task: { repo_url: null }, head_sha: 'sha-head' },
    ])
    await maybeAutoDeploySprintBatchPr(BASE)
    expect(mockExecuteEffects).toHaveBeenCalledWith([{ type: 'ENABLE_AUTO_MERGE', prUrl: PR, expectedHeadSha: 'sha-head' }])
  })

  it('geen product-repo-PR → skip', async () => {
    mockJobFindMany.mockResolvedValue([
      { pr_url: 'https://git/janpeter/scrum4me-mcp/pulls/3', task: { repo_url: 'https://git/janpeter/scrum4me-mcp' }, head_sha: 'sha-mcp' },
    ])
    await maybeAutoDeploySprintBatchPr(BASE)
    expect(mockExecuteEffects).not.toHaveBeenCalled()
  })

  it('head-sha: live PR-head onbereikbaar (getPullRequestState error) → skip', async () => {
    mockGetPrState.mockResolvedValue({ error: 'pr-get failed' })
    await maybeAutoDeploySprintBatchPr(BASE)
    expect(mockExecuteEffects).not.toHaveBeenCalled()
  })

  it('head-sha: live PR-head van Forgejo wordt gebruikt', async () => {
    mockGetPrState.mockResolvedValue({ state: 'OPEN', headSha: 'sha-from-forgejo', mergeCommit: null, baseRefName: 'main', title: 't' })
    await maybeAutoDeploySprintBatchPr(BASE)
    expect(mockExecuteEffects).toHaveBeenCalledWith([{ type: 'ENABLE_AUTO_MERGE', prUrl: PR, expectedHeadSha: 'sha-from-forgejo' }])
  })

  // Regressie tegen de adversariële-review-blocker: bij een multi-job SPRINT-batch
  // delen meerdere product-repo-taken één PR maar hebben ze elk een eigen (per-push)
  // head_sha. De helper mag NOOIT de DB head_sha van de oudste sibling gebruiken
  // (die is stale) — altijd de LIVE PR-head. Vóór de fix koos de helper 'sha-A-stale'
  // (oudste sibling) → ENABLE_AUTO_MERGE zou met een verkeerde expectedHeadSha vuren.
  it('stale sibling head_sha wordt genegeerd → live PR-head (regressie blocker M21)', async () => {
    mockJobFindMany.mockResolvedValue([
      { pr_url: PR, task: { repo_url: null }, head_sha: 'sha-A-stale' },
      { pr_url: PR, task: { repo_url: null }, head_sha: 'sha-B' },
    ])
    mockGetPrState.mockResolvedValue({ state: 'OPEN', headSha: 'sha-C-live', mergeCommit: null, baseRefName: 'main', title: 't' })
    await maybeAutoDeploySprintBatchPr(BASE)
    expect(mockExecuteEffects).toHaveBeenCalledWith([{ type: 'ENABLE_AUTO_MERGE', prUrl: PR, expectedHeadSha: 'sha-C-live' }])
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ headSha: 'sha-C-live' }))
  })
})
