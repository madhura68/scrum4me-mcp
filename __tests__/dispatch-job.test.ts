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
vi.mock('../src/lib/dispatch/deploy-dispatch.js', () => ({
  dispatchDeploy: vi.fn().mockResolvedValue({ job_id: 'job-6' }),
}))
vi.mock('../src/lib/dispatch/docs-audit-dispatch.js', () => ({
  dispatchDocsAudit: vi.fn().mockResolvedValue({ job_id: 'job-7' }),
}))

import { requireWriteAccess } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { handleDispatchJob, KIND_VALUES, registerDispatchJobTool } from '../src/tools/dispatch-job.js'
import { dispatchIdeaJob } from '../src/lib/dispatch/idea-jobs.js'
import { dispatchSprintRun } from '../src/lib/dispatch/sprint-run.js'
import { dispatchPrReview, dispatchSpecReview, dispatchTaskReview } from '../src/lib/dispatch/review-jobs.js'
import { dispatchTaskImplementation } from '../src/lib/dispatch/task-implementation.js'
import { dispatchDeploy } from '../src/lib/dispatch/deploy-dispatch.js'
import { dispatchDocsAudit } from '../src/lib/dispatch/docs-audit-dispatch.js'
import { toolText } from './helpers/tool-result.js'

const REFUSAL =
  'VALIDATION_ERROR: required_capability local_llm wordt niet meer aangenomen; kies per product een HARNESS-configuratie.'

const ALL_DISPATCHERS = [
  dispatchIdeaJob, dispatchSprintRun, dispatchPrReview, dispatchSpecReview, dispatchTaskReview,
  dispatchTaskImplementation, dispatchDeploy, dispatchDocsAudit,
]

beforeEach(() => {
  vi.clearAllMocks()
  ;(requireWriteAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'u1', isDemo: false })
  ;(userCanAccessProduct as ReturnType<typeof vi.fn>).mockResolvedValue(true)
})

it('IDEA_GRILL vereist idea_id (matrix)', async () => {
  const res = await handleDispatchJob({ kind: 'IDEA_GRILL', product_id: 'p1' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/idea_id/)
})

it('weigert overtollige refs (matrix is exact)', async () => {
  const res = await handleDispatchJob({
    kind: 'IDEA_GRILL', product_id: 'p1', idea_id: 'i1', task_id: 't1',
  })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/task_id/)
})

it('PLAN_CHAT is geen geldig kind', async () => {
  const res = await handleDispatchJob({ kind: 'PLAN_CHAT' as never, product_id: 'p1' })
  expect(res.isError).toBe(true)
})

it('IDEA_CHAT is geen geldig kind (interactief kanaal, niet dispatchbaar)', async () => {
  const res = await handleDispatchJob({ kind: 'IDEA_CHAT' as never, product_id: 'p1' })
  expect(res.isError).toBe(true)
})

it('DEPLOY vereist geen refs (matrix: required = [])', async () => {
  const res = await handleDispatchJob({ kind: 'DEPLOY', product_id: 'p1' })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(toolText(res))).toMatchObject({ job_id: 'job-6' })
})

it('DEPLOY weigert refs zoals pr_url (matrix is exact, géén refs toegestaan)', async () => {
  const res = await handleDispatchJob({ kind: 'DEPLOY', product_id: 'p1', pr_url: 'https://x/y/pulls/1' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/pr_url/)
})

it('DOCS_AUDIT vereist geen refs (matrix: required = [])', async () => {
  const res = await handleDispatchJob({ kind: 'DOCS_AUDIT', product_id: 'p1' })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(toolText(res))).toMatchObject({ job_id: 'job-7' })
})

it('DOCS_AUDIT weigert een task_id (matrix is exact, géén refs toegestaan)', async () => {
  const res = await handleDispatchJob({ kind: 'DOCS_AUDIT', product_id: 'p1', task_id: 't1' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/task_id/)
})

it('product buiten scope → 404-stijl, dispatcher niet aangeroepen', async () => {
  ;(userCanAccessProduct as ReturnType<typeof vi.fn>).mockResolvedValue(false)
  const res = await handleDispatchJob({ kind: 'IDEA_GRILL', product_id: 'p1', idea_id: 'i1' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/not found or not accessible/)
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
  expect(toolText(neither)).toMatch(/precies één/)
})

it('happy paths leveren job-ids', async () => {
  const grill = await handleDispatchJob({ kind: 'IDEA_GRILL', product_id: 'p1', idea_id: 'i1' })
  expect(JSON.parse(toolText(grill))).toMatchObject({ job_id: 'job-1' })
  const sprint = await handleDispatchJob({ kind: 'SPRINT_IMPLEMENTATION', product_id: 'p1', sprint_id: 's1' })
  expect(JSON.parse(toolText(sprint))).toMatchObject({ sprint_run_id: 'run-1' })
})

it('required_capability local_llm bij TASK_IMPLEMENTATION wordt geweigerd, vóór authenticatie en database, en dispatcht niets', async () => {
  // M45-2b: de local_llm-route is vervangen door een HARNESS-configuratie per product; de sleutel blijft in het schema
  // (een niet-strikt z.object zou hem anders stil weggooien) en elke waarde wordt geweigerd.
  const { dispatchTaskImplementation } = await import('../src/lib/dispatch/task-implementation.js')
  const res = await handleDispatchJob({
    kind: 'TASK_IMPLEMENTATION', product_id: 'p1', task_id: 't1', required_capability: 'local_llm',
  })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toBe(
    'VALIDATION_ERROR: required_capability local_llm wordt niet meer aangenomen; kies per product een HARNESS-configuratie.',
  )
  expect(dispatchTaskImplementation).not.toHaveBeenCalled()
  // Vóór authenticatie en database: geen auth-, toegangs- of dispatchaanroep.
  expect(requireWriteAccess).not.toHaveBeenCalled()
  expect(userCanAccessProduct).not.toHaveBeenCalled()
})

it('een andere waarde van required_capability wordt ook geweigerd: elke waarde, niet alleen local_llm', async () => {
  const { dispatchTaskImplementation } = await import('../src/lib/dispatch/task-implementation.js')
  const res = await handleDispatchJob({
    kind: 'TASK_IMPLEMENTATION', product_id: 'p1', task_id: 't1', required_capability: 'gpu' as never,
  })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/^VALIDATION_ERROR: /)
  expect(toolText(res)).toMatch(/required_capability/)
  expect(dispatchTaskImplementation).not.toHaveBeenCalled()
  expect(requireWriteAccess).not.toHaveBeenCalled()
})

it('TASK_IMPLEMENTATION zonder required_capability wordt gewoon gedispatcht', async () => {
  const { dispatchTaskImplementation } = await import('../src/lib/dispatch/task-implementation.js')
  const res = await handleDispatchJob({ kind: 'TASK_IMPLEMENTATION', product_id: 'p1', task_id: 't1' })
  expect(res.isError).toBeFalsy()
  expect(JSON.parse(toolText(res))).toMatchObject({ job_id: 'job-5' })
  expect(dispatchTaskImplementation).toHaveBeenCalledWith(expect.objectContaining({
    taskId: 't1', productId: 'p1', userId: 'u1',
  }))
})

it('required_capability bij een andere kind dan TASK_IMPLEMENTATION → validatiefout, geen dispatch', async () => {
  const { dispatchPrReview } = await import('../src/lib/dispatch/review-jobs.js')
  const res = await handleDispatchJob({
    kind: 'PR_REVIEW', product_id: 'p1', pr_url: 'https://x/y/pulls/1', required_capability: 'local_llm',
  } as never)
  expect(res.isError).toBe(true)
  expect(toolText(res)).toBe(REFUSAL)
  expect(dispatchPrReview).not.toHaveBeenCalled()
})

// M45-2b: één weigering voor elke soort. Een aanroeper krijgt dus nooit te horen dat het "alleen bij TASK_IMPLEMENTATION"
// mag (dat suggereert dat de route daar nog bestaat): de route bestaat niet meer, per product kies je een HARNESS-
// configuratie. De weigering komt vóór authenticatie en database, ook voor soorten die de sleutel nooit gebruikten.
const REFS_PER_KIND: Record<(typeof KIND_VALUES)[number], Record<string, string>> = {
  IDEA_GRILL: { idea_id: 'i1' },
  IDEA_MAKE_PLAN: { idea_id: 'i1' },
  IDEA_REVIEW_PLAN: { idea_id: 'i1' },
  IDEA_MAKE_SPEC: { idea_id: 'i1' },
  TASK_IMPLEMENTATION: { task_id: 't1' },
  SPRINT_IMPLEMENTATION: { sprint_id: 's1' },
  PR_REVIEW: { pr_url: 'https://x/y/pulls/1' },
  SPEC_REVIEW: { doc_slug: 's' },
  TASK_REVIEW: { task_id: 't1' },
  DEPLOY: {},
  DOCS_AUDIT: {},
}

it.each(KIND_VALUES)('required_capability bij %s geeft dezelfde weigering, vóór authenticatie en database, en dispatcht niets', async (kind) => {
  const res = await handleDispatchJob({
    kind, product_id: 'p1', ...REFS_PER_KIND[kind], required_capability: 'local_llm',
  } as never)

  expect(res.isError).toBe(true)
  expect(toolText(res)).toBe(REFUSAL)
  for (const dispatcher of ALL_DISPATCHERS) expect(dispatcher).not.toHaveBeenCalled()
  expect(requireWriteAccess).not.toHaveBeenCalled()
  expect(userCanAccessProduct).not.toHaveBeenCalled()
})

// De MCP-client ziet alleen het schema en de tooltekst: beide zeggen dat de sleutel niet meer wordt aangenomen en dat
// de keuze per product ligt, en de tooltekst noemt de HARNESS-routering van een losse TASK_IMPLEMENTATION en de bron.
it('het schema en de tooltekst leggen de weigering, de HARNESS-routering en de bron uit', () => {
  let registered: { description: string; inputSchema: { shape: { required_capability: { description?: string } } } } | null = null
  registerDispatchJobTool({
    registerTool: (_name: string, config: NonNullable<typeof registered>) => {
      registered = config
    },
  } as never)

  const keyDescription = registered!.inputSchema.shape.required_capability.description ?? ''
  expect(keyDescription).toMatch(/no longer accepted/i)
  expect(keyDescription).toMatch(/HARNESS configuration/)
  expect(keyDescription).toMatch(/per product/)

  const { description } = registered!
  expect(description).toMatch(/required_capability is no longer accepted/)
  expect(description).toMatch(/refused with a VALIDATION_ERROR/)
  expect(description).toMatch(/standalone TASK_IMPLEMENTATION/)
  expect(description).toMatch(/HARNESS configuration/)
  expect(description).toMatch(/source COPILOT, except DEPLOY and DOCS_AUDIT \(source MANUAL\)/)
})

it('DispatchError uit een dispatcher wordt een nette toolError', async () => {
  const { dispatchIdeaJob } = await import('../src/lib/dispatch/idea-jobs.js')
  const { DispatchError } = await import('../src/lib/dispatch/errors.js')
  ;(dispatchIdeaJob as ReturnType<typeof vi.fn>).mockRejectedValue(new DispatchError('Idea x not found in this product'))
  const res = await handleDispatchJob({ kind: 'IDEA_GRILL', product_id: 'p1', idea_id: 'x' })
  expect(res.isError).toBe(true)
  expect(toolText(res)).toMatch(/not found in this product/)
})
