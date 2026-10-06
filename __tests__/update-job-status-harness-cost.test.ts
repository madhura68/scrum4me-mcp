import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// M45-2b Taak 4 (spec §6.2): een HARNESS-job meldt bij zijn eindstatus (done, failed, skipped) zijn kosten in het
// optionele veld `cost` van update_job_status; de MCP legt dat vast in job_cost_reports, in dezelfde transactie als de
// statusupdate. Dit bestand test de bedrading in de ECHTE handler op het gewone pad (losse taak, TASK_IMPLEMENTATION):
//   - het hele cost-object is gevalideerd vóór elk neveneffect (de verify-gate en de push van prepareDoneUpdate), zodat
//     een weigering geen gepushte branch achterlaat bij een job die RUNNING blijft;
//   - met kosten gaan de update en de upsert als één $transaction-array; zonder kosten blijft het de losse update;
//   - de regels zelf (per bron, het bedrag) staan in harness-cost.test.ts; het idee-chat-pad staat in
//     update-job-status-idea-chat.test.ts.
//
// De job-select van de handler wordt hier gevolgd (alleen de geselecteerde velden komen terug, zoals bij Prisma): een
// handler die `requested_model` niet selecteert, ziet dan geen configuratie en weigert elke melding.

const authMocks = vi.hoisted(() => ({
  requireWriteAccess: vi.fn(),
  // withToolErrors vergelijkt een gegooide fout met deze klasse.
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
const pgMocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }))
const jobLockMocks = vi.hoisted(() => ({ releaseLocksOnTerminal: vi.fn() }))
const pushMocks = vi.hoisted(() => ({ pushBranchForJob: vi.fn(), triggerPush: vi.fn() }))
const worktreeQueueMocks = vi.hoisted(() => ({
  markWorktreeCleanupPending: vi.fn(),
  isWorktreeCleanupPending: vi.fn(),
  clearWorktreeCleanupPending: vi.fn(),
}))
const prMocks = vi.hoisted(() => ({
  createPullRequest: vi.fn(),
  markPullRequestReady: vi.fn(),
  listPullRequestFiles: vi.fn(),
  getPullRequestState: vi.fn(),
}))
const propagateMocks = vi.hoisted(() => ({ propagateStatusUpwards: vi.fn() }))
const cascadeMocks = vi.hoisted(() => ({ cancelPbiOnFailure: vi.fn() }))
const effectsMocks = vi.hoisted(() => ({ executeEffects: vi.fn() }))
const deployJobMocks = vi.hoisted(() => ({ maybeEnqueueDeployJob: vi.fn() }))

vi.mock('../src/auth.js', () => authMocks)
vi.mock('../src/git/job-locks.js', () => jobLockMocks)
vi.mock('../src/git/push.js', () => ({ pushBranchForJob: pushMocks.pushBranchForJob }))
vi.mock('../src/lib/push-trigger.js', () => ({ triggerPush: pushMocks.triggerPush }))
vi.mock('../src/git/worktree-cleanup-queue.js', () => worktreeQueueMocks)
vi.mock('../src/git/pr.js', () => prMocks)
vi.mock('../src/lib/tasks-status-update.js', () => propagateMocks)
vi.mock('../src/cancel/pbi-cascade.js', () => cascadeMocks)
vi.mock('../src/flow/effects.js', () => effectsMocks)
vi.mock('../src/lib/dispatch/deploy-job.js', () => deployJobMocks)
vi.mock('pg', () => ({
  Client: vi.fn(function Client() {
    return { connect: pgMocks.connect, query: pgMocks.query, end: pgMocks.end }
  }),
}))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    jobCostReport: { upsert: vi.fn() },
    product: { findUnique: vi.fn() },
    task: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}))

import { prisma } from '../src/prisma.js'
import { registerUpdateJobStatusTool } from '../src/tools/update-job-status.js'

const mockPrisma = prisma as unknown as {
  claudeJob: {
    findUnique: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
    count: ReturnType<typeof vi.fn>
  }
  jobCostReport: { upsert: ReturnType<typeof vi.fn> }
  product: { findUnique: ReturnType<typeof vi.fn> }
  task: { findUnique: ReturnType<typeof vi.fn> }
  $transaction: ReturnType<typeof vi.fn>
}

const NOT_ALLOWED = 'VALIDATION_ERROR: COST_REPORT_NOT_ALLOWED'
const INVALID = 'VALIDATION_ERROR: COST_REPORT_INVALID'

const COST = { reported_cost_usd: '0.000313', cost_source: 'provider_reported', provider: 'openrouter' } as const

type Handler = (input: {
  job_id: string
  status: 'running' | 'done' | 'failed' | 'skipped'
  summary?: string
  error?: string
  branch?: string
  model_id?: string
  cost?: { reported_cost_usd: string | null; cost_source: string; provider?: string }
}) => Promise<{ isError?: boolean; content: [{ text: string }]; structuredContent?: Record<string, unknown> }>

function registerHandler(): Handler {
  let handler: Handler | null = null
  registerUpdateJobStatusTool({
    registerTool: (_n: string, _c: unknown, cb: Handler) => {
      handler = cb
    },
  } as never)
  return handler!
}

// Het inputschema zoals de MCP-SDK het ziet: de SDK valideert de argumenten ermee vóór de handler draait.
function registerInputSchema(): { safeParse: (input: unknown) => { success: boolean } } {
  let schema: { safeParse: (input: unknown) => { success: boolean } } | null = null
  registerUpdateJobStatusTool({
    registerTool: (_n: string, config: { inputSchema: typeof schema }) => {
      schema = config.inputSchema
    },
  } as never)
  return schema!
}

// Prisma geeft alleen de geselecteerde velden terug. Elke findUnique in de keten (de job-select van de handler,
// assertUnmanagedJob*, isHarnessJob, prepareDoneUpdate) vraagt hetzelfde job.id met een eigen select.
function installJobFixture(fixture: Record<string, unknown> & { id: string }) {
  mockPrisma.claudeJob.findUnique.mockImplementation((async (args: {
    where: { id: string }
    select?: Record<string, unknown>
  }) => {
    if (args.where.id !== fixture.id) return null
    if (!args.select) return fixture
    return Object.fromEntries(
      Object.keys(args.select)
        .filter((key) => key in fixture)
        .map((key) => [key, fixture[key]]),
    )
  }) as never)
}

function jobFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-h1',
    status: 'RUNNING',
    claimed_at: new Date('2026-10-06T09:00:00Z'),
    started_at: new Date('2026-10-06T09:00:00Z'),
    claimed_by_token_id: 'token-1',
    user_id: 'user-1',
    product_id: 'prod-1',
    task_id: 'task-1',
    idea_id: null,
    sprint_run_id: null,
    kind: 'TASK_IMPLEMENTATION',
    runtime: 'HARNESS',
    source: 'COPILOT',
    verify_result: 'ALIGNED',
    created_at: new Date('2026-10-06T08:59:00Z'),
    chat_cutoff_message_id: null,
    chat_cutoff_at: null,
    required_capability: null,
    requested_model: 'gsq-lokaal',
    dispatch_request_id: null,
    dispatch_candidate_id: null,
    task_executions: [],
    task: {
      verify_only: false,
      verify_required: 'ALIGNED_OR_PARTIAL',
      dispatch_request_id: null,
      title: 'Harness-taak',
      repo_url: null,
      story: { id: 'story-1', code: 'SCRUM-1', title: 'Story title' },
    },
    branch: 'feat/job-h1',
    pr_url: null,
    ...overrides,
  }
}

const updatedRow = (status: 'DONE' | 'FAILED' | 'SKIPPED' | 'RUNNING') => ({
  id: 'job-h1',
  status,
  branch: null,
  pushed_at: null,
  pr_url: null,
  verify_result: 'ALIGNED',
  summary: null,
  error: null,
  started_at: new Date('2026-10-06T09:00:00Z'),
  finished_at: new Date('2026-10-06T09:05:00Z'),
  head_sha: null,
})

function updateData(): Record<string, unknown> {
  return mockPrisma.claudeJob.update.mock.calls[0][0].data
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
  authMocks.requireWriteAccess.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' })
  pgMocks.connect.mockResolvedValue(undefined)
  pgMocks.query.mockResolvedValue({ rows: [] })
  pgMocks.end.mockResolvedValue(undefined)
  jobLockMocks.releaseLocksOnTerminal.mockResolvedValue(undefined)
  // Geen wijzigingen te pushen: de done-route draait zonder de post-push rev-parse in een worktree die hier niet bestaat.
  pushMocks.pushBranchForJob.mockResolvedValue({ pushed: false, reason: 'no-changes', stderr: '' })
  pushMocks.triggerPush.mockResolvedValue(undefined)
  worktreeQueueMocks.markWorktreeCleanupPending.mockResolvedValue(undefined)
  worktreeQueueMocks.isWorktreeCleanupPending.mockResolvedValue(false)
  worktreeQueueMocks.clearWorktreeCleanupPending.mockResolvedValue(undefined)
  prMocks.createPullRequest.mockResolvedValue({ url: 'https://git.example/org/repo/pulls/9' })
  prMocks.markPullRequestReady.mockResolvedValue({ ok: true })
  prMocks.listPullRequestFiles.mockResolvedValue([])
  prMocks.getPullRequestState.mockResolvedValue({ error: 'not used' })
  propagateMocks.propagateStatusUpwards.mockResolvedValue({
    task: { id: 'task-1', title: 't', status: 'DONE', story_id: 'story-1', implementation_plan: null },
    storyId: 'story-1',
    storyChanged: false,
    pbiChanged: false,
    sprintChanged: false,
    sprintRunChanged: false,
  })
  cascadeMocks.cancelPbiOnFailure.mockResolvedValue({
    cancelled_job_ids: [],
    closed_prs: [],
    reverted_prs: [],
    deleted_branches: [],
    warnings: [],
  })
  effectsMocks.executeEffects.mockResolvedValue([])
  deployJobMocks.maybeEnqueueDeployJob.mockResolvedValue('enqueued')
  mockPrisma.claudeJob.count.mockResolvedValue(0)
  mockPrisma.claudeJob.findMany.mockResolvedValue([])
  mockPrisma.claudeJob.update.mockResolvedValue(updatedRow('DONE'))
  mockPrisma.jobCostReport.upsert.mockResolvedValue({ job_id: 'job-h1' })
  // Zoals Prisma: de operaties van de array-vorm zijn thenables die in één transactie draaien.
  mockPrisma.$transaction.mockImplementation((async (operations: Promise<unknown>[]) => Promise.all(operations)) as never)
  mockPrisma.product.findUnique.mockResolvedValue({ auto_pr: true, repo_url: null })
  mockPrisma.task.findUnique.mockResolvedValue({
    title: 'Harness-taak',
    repo_url: null,
    story: { id: 'story-1', code: 'SCRUM-1', title: 'Story title' },
  })
})

afterEach(() => {
  delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
  vi.useRealTimers()
})

function expectNothingWritten() {
  expect(mockPrisma.claudeJob.update).not.toHaveBeenCalled()
  expect(mockPrisma.jobCostReport.upsert).not.toHaveBeenCalled()
  expect(mockPrisma.$transaction).not.toHaveBeenCalled()
}

// Een HARNESS-job van een soort met een eigen eindpad (DOCS_AUDIT, DEPLOY): zonder taak, bron SYSTEM, geen verify.
function ownEndPathJob(kind: string) {
  return jobFixture({ kind, runtime: 'HARNESS', task_id: null, source: 'SYSTEM', verify_result: null, task: null })
}

// Laat de eigen eindpaden van DOCS_AUDIT (updateMany) en DEPLOY (een callback-transactie met een eigen tx) slagen.
function letOwnEndPathsSucceed() {
  mockPrisma.claudeJob.updateMany.mockResolvedValue({ count: 1 })
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    claudeJob: {
      update: vi.fn().mockResolvedValue({ id: 'job-h1', status: 'DONE', summary: 'Klaar.', error: null, pr_url: null }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  }
  mockPrisma.$transaction.mockImplementation((async (arg: unknown) =>
    typeof arg === 'function' ? arg(tx) : Promise.all(arg as Promise<unknown>[])) as never)
  return tx
}

describe('update_job_status: kostenmelding van een HARNESS-job op het gewone pad', () => {
  it('done + cost: de statusupdate en de kostenrij zijn twee operaties van één $transaction, met alle velden', async () => {
    installJobFixture(jobFixture())
    const result = await registerHandler()({ job_id: 'job-h1', status: 'done', summary: 'Klaar.', cost: COST })

    expect(result).not.toMatchObject({ isError: true })
    expect(result.structuredContent).toMatchObject({ job_id: 'job-h1', status: 'done' })

    // Eén transactie met precies de update en de upsert: dezelfde operaties die de handler daarvoor aanriep.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    const [operations] = mockPrisma.$transaction.mock.calls[0]
    expect(operations).toHaveLength(2)
    expect(operations[0]).toBe(mockPrisma.claudeJob.update.mock.results[0].value)
    expect(operations[1]).toBe(mockPrisma.jobCostReport.upsert.mock.results[0].value)

    expect(mockPrisma.claudeJob.update).toHaveBeenCalledTimes(1)
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-h1' },
      data: expect.objectContaining({ status: 'DONE', summary: 'Klaar.' }),
    }))
    const row = {
      reported_cost_usd: '0.000313',
      cost_source: 'provider_reported',
      provider: 'openrouter',
      configuration: 'gsq-lokaal',
      reported_at: expect.any(Date),
    }
    expect(mockPrisma.jobCostReport.upsert).toHaveBeenCalledTimes(1)
    expect(mockPrisma.jobCostReport.upsert).toHaveBeenCalledWith({
      where: { job_id: 'job-h1' },
      create: { job_id: 'job-h1', ...row },
      update: row,
    })
  })

  it.each([
    { status: 'failed', error: 'model faalde ergens', dbStatus: 'FAILED' },
    { status: 'skipped', error: 'no_op_changes_already_in_main', dbStatus: 'SKIPPED' },
  ] as const)('$status + cost: ook dan gaat de kostenrij mee in de transactie', async ({ status, error, dbStatus }) => {
    installJobFixture(jobFixture({ status: 'CLAIMED', branch: null }))
    mockPrisma.claudeJob.update.mockResolvedValue(updatedRow(dbStatus))
    const result = await registerHandler()({ job_id: 'job-h1', status, error, cost: COST })

    expect(result).not.toMatchObject({ isError: true })
    expect(result.structuredContent).toMatchObject({ job_id: 'job-h1', status })
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    const [operations] = mockPrisma.$transaction.mock.calls[0]
    expect(operations).toHaveLength(2)
    expect(operations[0]).toBe(mockPrisma.claudeJob.update.mock.results[0].value)
    expect(operations[1]).toBe(mockPrisma.jobCostReport.upsert.mock.results[0].value)
    expect(updateData()).toMatchObject({ status: dbStatus })
    expect(mockPrisma.jobCostReport.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { job_id: 'job-h1' },
      create: expect.objectContaining({ cost_source: 'provider_reported', configuration: 'gsq-lokaal' }),
    }))
  })

  it('done wordt FAILED omdat de push mislukt: de kosten zijn dan toch gemaakt en gaan mee in de transactie', async () => {
    installJobFixture(jobFixture())
    pushMocks.pushBranchForJob.mockResolvedValue({ pushed: false, reason: 'conflict', stderr: 'rejected' })
    mockPrisma.claudeJob.update.mockResolvedValue(updatedRow('FAILED'))
    const result = await registerHandler()({ job_id: 'job-h1', status: 'done', summary: 'Klaar.', cost: COST })

    expect(result.structuredContent).toMatchObject({ job_id: 'job-h1', status: 'failed' })
    expect(updateData()).toMatchObject({ status: 'FAILED' })
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mockPrisma.jobCostReport.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { job_id: 'job-h1' },
      create: expect.objectContaining({ reported_cost_usd: '0.000313', configuration: 'gsq-lokaal' }),
    }))
  })

  it('schrijft een bron zonder bedrag als null (none) en een nul als 0 (local)', async () => {
    installJobFixture(jobFixture())
    await registerHandler()({
      job_id: 'job-h1', status: 'done', summary: 'Klaar.',
      cost: { reported_cost_usd: null, cost_source: 'none' },
    })
    expect(mockPrisma.jobCostReport.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      create: expect.objectContaining({ reported_cost_usd: null, cost_source: 'none', provider: null }),
    }))

    installJobFixture(jobFixture({ id: 'job-h2' }))
    mockPrisma.claudeJob.update.mockResolvedValue({ ...updatedRow('DONE'), id: 'job-h2' })
    await registerHandler()({
      job_id: 'job-h2', status: 'done', summary: 'Klaar.',
      cost: { reported_cost_usd: '0.00', cost_source: 'local' },
    })
    expect(mockPrisma.jobCostReport.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { job_id: 'job-h2' },
      create: expect.objectContaining({ job_id: 'job-h2', reported_cost_usd: '0', cost_source: 'local' }),
    }))
  })

  it('de configuratie komt uit de job (requested_model), niet uit model_id van de melding', async () => {
    installJobFixture(jobFixture({ requested_model: 'qwen3-coder' }))
    await registerHandler()({
      job_id: 'job-h1', status: 'done', summary: 'Klaar.', model_id: 'een-ander-model', cost: COST,
    })
    expect(mockPrisma.jobCostReport.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ configuration: 'qwen3-coder' }),
      update: expect.objectContaining({ configuration: 'qwen3-coder' }),
    }))
  })

  it('reported_at is het moment van de statusupdate (nu), in create én update', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-06T12:34:56.000Z'))
    installJobFixture(jobFixture())
    await registerHandler()({ job_id: 'job-h1', status: 'done', summary: 'Klaar.', cost: COST })

    const now = new Date('2026-10-06T12:34:56.000Z')
    expect(mockPrisma.jobCostReport.upsert).toHaveBeenCalledTimes(1)
    const args = mockPrisma.jobCostReport.upsert.mock.calls[0][0]
    expect(args.create.reported_at).toEqual(now)
    expect(args.update.reported_at).toEqual(now)
    // Hetzelfde moment als de eindtijd van de job: één `nu` voor de hele statusupdate.
    expect(updateData().finished_at).toEqual(now)
  })

  it('zonder cost blijft het de losse update: geen $transaction en geen upsert', async () => {
    installJobFixture(jobFixture())
    const result = await registerHandler()({ job_id: 'job-h1', status: 'done', summary: 'Klaar.' })

    expect(result).not.toMatchObject({ isError: true })
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledTimes(1)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockPrisma.jobCostReport.upsert).not.toHaveBeenCalled()
  })
})

describe('update_job_status: een kostenmelding die niet mag, wordt geweigerd zonder schrijven', () => {
  it.each([
    { label: 'een Claude-job', overrides: { runtime: 'CLAUDE' } },
    // Een local_llm-job heeft runtime CLAUDE en een capability: hij meldt geen kosten (niet isHarnessJobRow).
    { label: 'een local_llm-job', overrides: { runtime: 'CLAUDE', required_capability: 'local_llm' } },
  ])('$label met done + cost → COST_REPORT_NOT_ALLOWED', async ({ overrides }) => {
    installJobFixture(jobFixture(overrides))
    const result = await registerHandler()({ job_id: 'job-h1', status: 'done', summary: 'Klaar.', cost: COST })

    expect(result).toMatchObject({ isError: true })
    expect(result.content[0].text).toBe(NOT_ALLOWED)
    expectNothingWritten()
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
  })

  it('een HARNESS-job met een running-melding + cost → COST_REPORT_NOT_ALLOWED', async () => {
    installJobFixture(jobFixture({ status: 'CLAIMED' }))
    const result = await registerHandler()({ job_id: 'job-h1', status: 'running', cost: COST })

    expect(result).toMatchObject({ isError: true })
    expect(result.content[0].text).toBe(NOT_ALLOWED)
    expectNothingWritten()
  })

  // DOCS_AUDIT en DEPLOY hebben een eigen eindpad dat nooit een kostenrij schrijft. Een HARNESS-job van zo'n soort (die
  // bestaat vandaag niet, maar de handler hoort er niet op te rekenen) mag dus geen kosten melden: een melding die de
  // runtimecontrole doorstaat, zou daar stil verdwijnen. De fixture heeft runtime HARNESS en een geldige melding, zodat
  // alleen de soortcontrole van checkCostReport de handler nog tegenhoudt; de eigen eindpaden slagen hier (zie
  // letOwnEndPathsSucceed), dus zonder die controle komt de job gewoon op DONE en verdwijnt de melding.
  it.each(['DOCS_AUDIT', 'DEPLOY'])(
    'een HARNESS-job van soort %s heeft een eigen eindpad zonder kostenrij: cost wordt geweigerd, niet stil genegeerd',
    async (kind) => {
      installJobFixture(ownEndPathJob(kind))
      letOwnEndPathsSucceed()
      const result = await registerHandler()({ job_id: 'job-h1', status: 'done', summary: 'Klaar.', cost: COST })

      expect(result).toMatchObject({ isError: true })
      expect(result.content[0].text).toBe(NOT_ALLOWED)
      expectNothingWritten()
      expect(mockPrisma.claudeJob.updateMany).not.toHaveBeenCalled()
    },
  )

  // Controle op de fixture: zonder cost slaagt dezelfde job op zijn eigen eindpad. De weigering hierboven komt dus van
  // de kostenmelding en de soort, niet van een fixture die het eindpad toch al zou breken.
  it.each(['DOCS_AUDIT', 'DEPLOY'])(
    'controle: dezelfde HARNESS-job van soort %s zonder cost slaagt op zijn eigen eindpad',
    async (kind) => {
      installJobFixture(ownEndPathJob(kind))
      const tx = letOwnEndPathsSucceed()
      const result = await registerHandler()({ job_id: 'job-h1', status: 'done', summary: 'Klaar.' })

      expect(result).not.toMatchObject({ isError: true })
      // DOCS_AUDIT geeft de databasestatus terug (DONE), DEPLOY de toolstatus (done): beide zijn "klaar".
      expect(result.structuredContent).toMatchObject({ job_id: 'job-h1' })
      expect(String(result.structuredContent?.status).toLowerCase()).toBe('done')
      expect(kind === 'DOCS_AUDIT' ? mockPrisma.claudeJob.updateMany : tx.claudeJob.update).toHaveBeenCalledTimes(1)
      expect(mockPrisma.jobCostReport.upsert).not.toHaveBeenCalled()
    },
  )

  it('een ongeldige melding (local met een bedrag) → COST_REPORT_INVALID, en de push is dan nog niet gebeurd', async () => {
    installJobFixture(jobFixture())
    const result = await registerHandler()({
      job_id: 'job-h1', status: 'done', summary: 'Klaar.',
      cost: { reported_cost_usd: '0.5', cost_source: 'local' },
    })

    expect(result).toMatchObject({ isError: true })
    expect(result.content[0].text).toBe(INVALID)
    // Vóór elk neveneffect: geen push (een gepushte branch bij een job die RUNNING blijft), geen schrijven.
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
    expectNothingWritten()
  })

  it('de weigering komt vóór de verify-gate: de agent ziet de kostenfout, niet de gate', async () => {
    installJobFixture(jobFixture({ verify_result: null }))
    const result = await registerHandler()({
      job_id: 'job-h1', status: 'done', summary: 'Klaar.',
      cost: { reported_cost_usd: '1e-5', cost_source: 'provider_reported' },
    })

    expect(result).toMatchObject({ isError: true })
    expect(result.content[0].text).toBe(INVALID)
    expect(result.content[0].text).not.toMatch(/verify_task_against_plan/)
  })

  it('een HARNESS-job zonder requested_model → COST_REPORT_INVALID: de MCP verzint geen configuratie', async () => {
    installJobFixture(jobFixture({ requested_model: null }))
    const result = await registerHandler()({ job_id: 'job-h1', status: 'done', summary: 'Klaar.', cost: COST })

    expect(result).toMatchObject({ isError: true })
    expect(result.content[0].text).toBe(INVALID)
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
    expectNothingWritten()
  })

})

describe('update_job_status: de kostenrij en de statusupdate slagen of mislukken samen', () => {
  it('een mislukte transactie wordt niet stil afgevangen: de handler meldt de fout', async () => {
    installJobFixture(jobFixture())
    mockPrisma.$transaction.mockRejectedValue(new Error('upsert faalde'))
    const result = await registerHandler()({ job_id: 'job-h1', status: 'done', summary: 'Klaar.', cost: COST })

    expect(result).toMatchObject({ isError: true })
    expect(result.content[0].text).toBe('upsert faalde')
    expect(pgMocks.query).not.toHaveBeenCalled()
  })
})

describe('update_job_status: het cost-veld van het inputschema', () => {
  const base = { job_id: 'job-h1', status: 'done' } as const
  const accepts = (cost: unknown) => registerInputSchema().safeParse({ ...base, cost }).success

  it('cost is optioneel: een aanroep zonder cost blijft geldig', () => {
    expect(registerInputSchema().safeParse(base).success).toBe(true)
  })

  it.each([
    { label: 'een bedrag met een aanbieder', cost: { reported_cost_usd: '0.000313', cost_source: 'provider_reported', provider: 'openrouter' } },
    { label: 'geen bedrag (null) bij de bron none', cost: { reported_cost_usd: null, cost_source: 'none' } },
    { label: 'elke bron uit de vaste lijst: litellm_computed', cost: { reported_cost_usd: '0.1', cost_source: 'litellm_computed' } },
    { label: 'elke bron uit de vaste lijst: local', cost: { reported_cost_usd: '0', cost_source: 'local' } },
    { label: 'een aanbieder van 200 tekens', cost: { reported_cost_usd: '1', cost_source: 'provider_reported', provider: 'x'.repeat(200) } },
  ])('accepteert $label', ({ cost }) => {
    expect(accepts(cost)).toBe(true)
  })

  it.each([
    { label: 'een onbekende sleutel (het object is strikt)', cost: { reported_cost_usd: '1', cost_source: 'none', configuration: 'ander' } },
    { label: 'een onbekende bron', cost: { reported_cost_usd: '1', cost_source: 'gokje' } },
    { label: 'een bedrag als number', cost: { reported_cost_usd: 1, cost_source: 'provider_reported' } },
    { label: 'een ontbrekend bedrag (het veld is verplicht, wel null toegestaan)', cost: { cost_source: 'none' } },
    { label: 'een ontbrekende bron', cost: { reported_cost_usd: '1' } },
    { label: 'een lege aanbieder', cost: { reported_cost_usd: '1', cost_source: 'provider_reported', provider: '' } },
    { label: 'een aanbieder van 201 tekens', cost: { reported_cost_usd: '1', cost_source: 'provider_reported', provider: 'x'.repeat(201) } },
  ])('weigert $label', ({ cost }) => {
    expect(accepts(cost)).toBe(false)
  })
})
