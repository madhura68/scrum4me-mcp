import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    product: { findUnique: vi.fn() },
    productDoc: { findFirst: vi.fn(), findUnique: vi.fn() },
    task: { findUnique: vi.fn() },
    claudeJob: { create: vi.fn().mockResolvedValue({ id: 'job-1' }) },
  },
}))
vi.mock('../src/lib/dispatch/snapshot.js', () => ({
  getJobConfigSnapshot: vi.fn().mockResolvedValue({}),
}))
vi.mock('../src/lib/dispatch/notify.js', () => ({ notifyJobEnqueued: vi.fn() }))
vi.mock('../src/lib/task-review-context.js', () => ({
  resolveTaskImplContext: vi.fn(),
}))

import { resolveTaskImplContext } from '../src/lib/task-review-context.js'
import { prisma } from '../src/prisma.js'
import {
  prUrlMatchesRepo,
  dispatchPrReview,
  dispatchSpecReview,
  dispatchTaskReview,
} from '../src/lib/dispatch/review-jobs.js'

const mockProduct = prisma.product.findUnique as ReturnType<typeof vi.fn>
const mockDocFirst = prisma.productDoc.findFirst as ReturnType<typeof vi.fn>
const mockDocUnique = prisma.productDoc.findUnique as ReturnType<typeof vi.fn>
const mockTask = prisma.task.findUnique as ReturnType<typeof vi.fn>
const mockCreate = prisma.claudeJob.create as ReturnType<typeof vi.fn>
const mockResolveImpl = resolveTaskImplContext as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mockCreate.mockResolvedValue({ id: 'job-1' })
  mockProduct.mockResolvedValue({ id: 'prod-1', repo_url: 'https://git.jp-visser.nl/janpeter/Repo.git' })
})

describe('prUrlMatchesRepo', () => {
  it('matcht met/zonder .git en case-insensitive host+pad', () => {
    expect(prUrlMatchesRepo(
      'https://git.jp-visser.nl/janpeter/Repo.git',
      'https://git.jp-visser.nl/janpeter/repo/pulls/7',
    )).toBe(true)
  })
  it('weigert een andere repo', () => {
    expect(prUrlMatchesRepo(
      'https://git.jp-visser.nl/janpeter/Repo',
      'https://git.jp-visser.nl/janpeter/Ander/pulls/7',
    )).toBe(false)
  })
  it('matcht bekende mirror-vormen in beide richtingen (spec v0.4)', () => {
    expect(prUrlMatchesRepo(
      'https://github.com/madhura68/Repo',
      'https://git.jp-visser.nl/janpeter/repo/pulls/7',
    )).toBe(true)
    expect(prUrlMatchesRepo(
      'https://git.jp-visser.nl/janpeter/repo.git',
      'https://github.com/madhura68/Repo/pull/7',
    )).toBe(true)
  })
  it('weigert een url zonder geldige PR-route', () => {
    expect(prUrlMatchesRepo(
      'https://git.jp-visser.nl/janpeter/repo',
      'https://git.jp-visser.nl/janpeter/repo/issues/7',
    )).toBe(false)
    expect(prUrlMatchesRepo(
      'https://git.jp-visser.nl/janpeter/repo',
      'https://git.jp-visser.nl/janpeter/repo/pulls/abc',
    )).toBe(false)
  })
  it('weigert ongeldige urls zonder exception', () => {
    expect(prUrlMatchesRepo('niet-een-url', 'https://git.jp-visser.nl/janpeter/repo/pulls/7')).toBe(false)
    expect(prUrlMatchesRepo('https://git.jp-visser.nl/janpeter/repo', 'niet-een-url')).toBe(false)
  })
})

it('PR_REVIEW: foreign pr_url → fout; eigen repo → job met pr_url + CODEX', async () => {
  await expect(
    dispatchPrReview({ productId: 'prod-1', prUrl: 'https://git.jp-visser.nl/janpeter/Ander/pulls/7', userId: 'u1' }),
  ).rejects.toThrow(/repo/)
  const res = await dispatchPrReview({ productId: 'prod-1', prUrl: 'https://git.jp-visser.nl/janpeter/repo/pulls/7', userId: 'u1' })
  expect(res).toEqual({ job_id: 'job-1' })
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      kind: 'PR_REVIEW', source: 'COPILOT', runtime: 'CODEX',
      required_capability: 'review', requested_model: 'codex-default',
    }),
  }))
})

it('SPEC_REVIEW via doc_id: same-product non-SPECS folder → fout (spec v0.4)', async () => {
  mockDocUnique.mockResolvedValue({ id: 'doc-1', product_id: 'prod-1', folder: 'PLANS' })
  await expect(
    dispatchSpecReview({ productId: 'prod-1', docId: 'doc-1', userId: 'u1' }),
  ).rejects.toThrow(/not found/)
})

it('SPEC_REVIEW via doc_slug resolvet binnen (product, SPECS)', async () => {
  mockDocFirst.mockResolvedValue({ id: 'doc-1' })
  await dispatchSpecReview({ productId: 'prod-1', docSlug: 'mijn-spec', userId: 'u1' })
  expect(mockDocFirst).toHaveBeenCalledWith(expect.objectContaining({
    where: { product_id: 'prod-1', folder: 'SPECS', slug: 'mijn-spec' },
  }))
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ kind: 'SPEC_REVIEW', doc_id: 'doc-1' }),
  }))
})

it('TASK_REVIEW: task van ander product → fout', async () => {
  mockTask.mockResolvedValue({ id: 't1', story: { product_id: 'prod-2' } })
  await expect(
    dispatchTaskReview({ productId: 'prod-1', taskId: 't1', userId: 'u1' }),
  ).rejects.toThrow(/not found/)
})

// Guard tegen de poison-job van 2026-07-09: zonder diff-bron kan de worker de
// review nooit uitvoeren (getFullJobContext gooit TerminalJobError). Maak zo'n
// job dus niet aan.
it('TASK_REVIEW: geen base/head-sha en geen pr_url → geweigerd, geen job aangemaakt', async () => {
  mockTask.mockResolvedValue({ id: 't1', repo_url: null, story: { product_id: 'prod-1' } })
  mockProduct.mockResolvedValue({ repo_url: 'https://git.jp-visser.nl/janpeter/DigiPlein' })
  mockResolveImpl.mockResolvedValue({
    plan_snapshot: null,
    base_sha: null,
    head_sha: null,
    pr_url: null,
    execution_id: null,
  })

  await expect(
    dispatchTaskReview({ productId: 'prod-1', taskId: 't1', userId: 'u1' }),
  ).rejects.toThrow(/geen implementatie-context/)
  expect(mockCreate).not.toHaveBeenCalled()
})

it('TASK_REVIEW: base===head maar pr_url aanwezig → toegestaan', async () => {
  mockTask.mockResolvedValue({ id: 't1', repo_url: null, story: { product_id: 'prod-1' } })
  mockProduct.mockResolvedValue({ repo_url: 'https://git.jp-visser.nl/janpeter/DigiPlein' })
  mockResolveImpl.mockResolvedValue({
    plan_snapshot: null,
    base_sha: 'same-sha',
    head_sha: 'same-sha',
    pr_url: 'https://git.jp-visser.nl/janpeter/DigiPlein/pulls/34',
    execution_id: null,
  })

  await expect(
    dispatchTaskReview({ productId: 'prod-1', taskId: 't1', userId: 'u1' }),
  ).resolves.toEqual({ job_id: 'job-1' })
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ kind: 'TASK_REVIEW', task_id: 't1' }),
  }))
})

it('TASK_REVIEW: base≠head + repo_url → toegestaan zonder pr_url', async () => {
  mockTask.mockResolvedValue({ id: 't1', repo_url: null, story: { product_id: 'prod-1' } })
  mockProduct.mockResolvedValue({ repo_url: 'https://git.jp-visser.nl/janpeter/DigiPlein' })
  mockResolveImpl.mockResolvedValue({
    plan_snapshot: null,
    base_sha: 'base-1',
    head_sha: 'head-2',
    pr_url: null,
    execution_id: 'exec-1',
  })

  await expect(
    dispatchTaskReview({ productId: 'prod-1', taskId: 't1', userId: 'u1' }),
  ).resolves.toEqual({ job_id: 'job-1' })
})

it('TASK_REVIEW: sha’s aanwezig maar geen enkele repo_url → geweigerd', async () => {
  mockTask.mockResolvedValue({ id: 't1', repo_url: null, story: { product_id: 'prod-1' } })
  mockProduct.mockResolvedValue({ repo_url: null })
  mockResolveImpl.mockResolvedValue({
    plan_snapshot: null,
    base_sha: 'base-1',
    head_sha: 'head-2',
    pr_url: null,
    execution_id: 'exec-1',
  })

  await expect(
    dispatchTaskReview({ productId: 'prod-1', taskId: 't1', userId: 'u1' }),
  ).rejects.toThrow(/geen implementatie-context/)
  expect(mockCreate).not.toHaveBeenCalled()
})
