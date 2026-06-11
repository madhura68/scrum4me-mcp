// __tests__/dispatch-job.test.ts
import { it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))
vi.mock('../src/lib/dispatch/idea-jobs.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dispatchIdeaJob: vi.fn().mockResolvedValue({ job_id: 'job-1' }),
}))
vi.mock('../src/lib/dispatch/sprint-run.js', () => ({
  dispatchSprintRun: vi.fn().mockResolvedValue({ sprint_run_id: 'run-1', jobs_count: 1 }),
}))
vi.mock('../src/lib/dispatch/review-jobs.js', () => ({
  dispatchPrReview: vi.fn().mockResolvedValue({ job_id: 'job-2' }),
  dispatchSpecReview: vi.fn().mockResolvedValue({ job_id: 'job-3' }),
  dispatchTaskReview: vi.fn().mockResolvedValue({ job_id: 'job-4' }),
}))
vi.mock('../src/lib/dispatch/task-implementation.js', () => ({
  dispatchTaskImplementation: vi.fn().mockResolvedValue({ job_id: 'job-5' }),
}))

import { requireWriteAccess } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { handleDispatchJob } from '../src/tools/dispatch-job.js'

beforeEach(() => {
  vi.clearAllMocks()
  ;(requireWriteAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'u1', isDemo: false })
  ;(userCanAccessProduct as ReturnType<typeof vi.fn>).mockResolvedValue(true)
})

it('IDEA_GRILL vereist idea_id (matrix)', async () => {
  const res = await handleDispatchJob({ kind: 'IDEA_GRILL', product_id: 'p1' })
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/idea_id/)
})

it('weigert overtollige refs (matrix is exact)', async () => {
  const res = await handleDispatchJob({
    kind: 'IDEA_GRILL', product_id: 'p1', idea_id: 'i1', task_id: 't1',
  })
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/task_id/)
})

it('PLAN_CHAT is geen geldig kind', async () => {
  const res = await handleDispatchJob({ kind: 'PLAN_CHAT' as never, product_id: 'p1' })
  expect(res.isError).toBe(true)
})

it('product buiten scope → 404-stijl, dispatcher niet aangeroepen', async () => {
  ;(userCanAccessProduct as ReturnType<typeof vi.fn>).mockResolvedValue(false)
  const res = await handleDispatchJob({ kind: 'IDEA_GRILL', product_id: 'p1', idea_id: 'i1' })
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/not found or not accessible/)
})

it('SPEC_REVIEW accepteert doc_slug óf doc_id, niet beide', async () => {
  const both = await handleDispatchJob({
    kind: 'SPEC_REVIEW', product_id: 'p1', doc_slug: 's', doc_id: 'd',
  })
  expect(both.isError).toBe(true)
  const ok = await handleDispatchJob({ kind: 'SPEC_REVIEW', product_id: 'p1', doc_slug: 's' })
  expect(ok.isError).toBeFalsy()
  const neither = await handleDispatchJob({ kind: 'SPEC_REVIEW', product_id: 'p1' })
  expect(neither.isError).toBe(true)
  expect(neither.content[0].text).toMatch(/precies één/)
})

it('happy paths leveren job-ids', async () => {
  const grill = await handleDispatchJob({ kind: 'IDEA_GRILL', product_id: 'p1', idea_id: 'i1' })
  expect(JSON.parse(grill.content[0].text as string)).toMatchObject({ job_id: 'job-1' })
  const sprint = await handleDispatchJob({ kind: 'SPRINT_IMPLEMENTATION', product_id: 'p1', sprint_id: 's1' })
  expect(JSON.parse(sprint.content[0].text as string)).toMatchObject({ sprint_run_id: 'run-1' })
})

it('DispatchError uit een dispatcher wordt een nette toolError', async () => {
  const { dispatchIdeaJob } = await import('../src/lib/dispatch/idea-jobs.js')
  const { DispatchError } = await import('../src/lib/dispatch/errors.js')
  ;(dispatchIdeaJob as ReturnType<typeof vi.fn>).mockRejectedValue(new DispatchError('Idea x not found in this product'))
  const res = await handleDispatchJob({ kind: 'IDEA_GRILL', product_id: 'p1', idea_id: 'x' })
  expect(res.isError).toBe(true)
  expect(res.content[0].text).toMatch(/not found in this product/)
})
