import { beforeEach, describe, expect, it, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({
  requireWriteAccess: vi.fn(),
  // withToolErrors vergelijkt een gegooide fout met deze klasse (de leesfout- en upsertfout-tests).
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))

const pgMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}))

const jobLockMocks = vi.hoisted(() => ({
  releaseLocksOnTerminal: vi.fn(),
}))

const pushMocks = vi.hoisted(() => ({
  pushBranchForJob: vi.fn(),
  triggerPush: vi.fn(),
}))

// M17 idea-chat: de dedicated transactie krijgt een eigen tx-mock zodat we de
// lock-volgorde en de writes ín de tx kunnen asserten.
const txMocks = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  claudeJob: { update: vi.fn(), create: vi.fn() },
  ideaChatMessage: { create: vi.fn(), findFirst: vi.fn() },
  ideaLog: { create: vi.fn() },
  idea: { update: vi.fn() },
  // M45-2b: de vervolgjob leest de productkeuze (readHarnessChoice) en een HARNESS-job meldt zijn kosten.
  productHarnessChoice: { findUnique: vi.fn() },
  jobCostReport: { upsert: vi.fn() },
}))

vi.mock('../src/auth.js', () => authMocks)
vi.mock('../src/git/job-locks.js', () => jobLockMocks)
vi.mock('../src/git/push.js', () => ({ pushBranchForJob: pushMocks.pushBranchForJob }))
vi.mock('../src/lib/push-trigger.js', () => ({ triggerPush: pushMocks.triggerPush }))
vi.mock('pg', () => ({
  Client: vi.fn(function Client() {
    return {
      connect: pgMocks.connect,
      query: pgMocks.query,
      end: pgMocks.end,
    }
  }),
}))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: {
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    idea: { update: vi.fn() },
    jobCostReport: { upsert: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txMocks)),
    $executeRaw: vi.fn(),
  },
}))

import { prisma } from '../src/prisma.js'
import { registerUpdateJobStatusTool } from '../src/tools/update-job-status.js'

const mockPrisma = prisma as unknown as {
  claudeJob: {
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    count: ReturnType<typeof vi.fn>
  }
  idea: { update: ReturnType<typeof vi.fn> }
  jobCostReport: { upsert: ReturnType<typeof vi.fn> }
  $transaction: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
}

function registerHandler() {
  let handler:
    | ((input: {
        job_id: string
        status: 'running' | 'done' | 'failed'
        summary?: string
        error?: string
        cost?: { reported_cost_usd: string | null; cost_source: string; provider?: string }
      }) => Promise<unknown>)
    | null = null
  registerUpdateJobStatusTool({
    registerTool: (_name: string, _config: unknown, callback: typeof handler) => {
      handler = callback
    },
  } as never)
  return handler!
}

const CUTOFF_AT = new Date('2026-07-03T09:59:00.000Z')

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-ideachat',
    status: 'CLAIMED',
    claimed_at: new Date('2026-07-03T10:00:00.000Z'),
    started_at: null,
    claimed_by_token_id: 'token-1',
    user_id: 'user-1',
    product_id: 'prod-1',
    task_id: null,
    idea_id: 'idea-1',
    sprint_run_id: null,
    kind: 'IDEA_CHAT',
    runtime: 'CLAUDE',
    source: 'SYSTEM',
    verify_result: null,
    created_at: new Date('2026-07-03T09:58:00.000Z'),
    chat_cutoff_message_id: 'msg2',
    chat_cutoff_at: CUTOFF_AT,
    required_capability: null,
    task: null,
    ...overrides,
  }
}

const updatedRow = (status: 'DONE' | 'FAILED') => ({
  id: 'job-ideachat',
  status,
  branch: null,
  pushed_at: null,
  pr_url: null,
  verify_result: null,
  summary: status === 'DONE' ? 'Antwoord voor het kanaal.' : null,
  error: status === 'FAILED' ? 'iets mis' : null,
  started_at: new Date('2026-07-03T10:01:00.000Z'),
  finished_at: new Date('2026-07-03T10:02:00.000Z'),
  head_sha: null,
})

describe('update_job_status system IDEA_CHAT jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMocks.requireWriteAccess.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' })
    pgMocks.connect.mockResolvedValue(undefined)
    pgMocks.query.mockResolvedValue({ rows: [] })
    pgMocks.end.mockResolvedValue(undefined)
    jobLockMocks.releaseLocksOnTerminal.mockResolvedValue(undefined)
    pushMocks.pushBranchForJob.mockResolvedValue({ pushed: true })
    pushMocks.triggerPush.mockResolvedValue(undefined)
    mockPrisma.claudeJob.findUnique.mockResolvedValue(jobRow())
    mockPrisma.claudeJob.count.mockResolvedValue(0)
    txMocks.$queryRaw.mockResolvedValue([{ id: 'idea-1' }])
    txMocks.claudeJob.update.mockResolvedValue(updatedRow('DONE'))
    txMocks.claudeJob.create.mockResolvedValue({ id: 'job-followup' })
    txMocks.ideaChatMessage.create.mockResolvedValue({ id: 'msg-assistant' })
    txMocks.ideaChatMessage.findFirst.mockResolvedValue(null)
    txMocks.ideaLog.create.mockResolvedValue({ id: 'log-1' })
    txMocks.productHarnessChoice.findUnique.mockResolvedValue(null)
    txMocks.jobCostReport.upsert.mockResolvedValue({ job_id: 'job-ideachat' })
  })

  it('done: assistant-bericht + status-flip in één tx onder de per-idea lock, geen vervolg-job zonder nieuwe berichten', async () => {
    const handler = registerHandler()

    const result = await handler({
      job_id: 'job-ideachat',
      status: 'done',
      summary: 'Antwoord voor het kanaal.',
    })

    expect(result).toMatchObject({
      structuredContent: { job_id: 'job-ideachat', status: 'done' },
    })
    // Lock als eerste statement in de tx.
    expect(txMocks.$queryRaw).toHaveBeenCalled()
    const lockSql = txMocks.$queryRaw.mock.calls[0][0].join('?')
    expect(lockSql).toContain('FOR UPDATE')
    expect(lockSql).toContain('FROM ideas')
    // Flip + write ín de tx; de losse prisma.claudeJob.update wordt overgeslagen.
    expect(txMocks.claudeJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-ideachat' },
      data: expect.objectContaining({ status: 'DONE', summary: 'Antwoord voor het kanaal.' }),
    }))
    expect(mockPrisma.claudeJob.update).not.toHaveBeenCalled()
    expect(txMocks.ideaChatMessage.create).toHaveBeenCalledWith({
      data: {
        idea_id: 'idea-1',
        role: 'ASSISTANT',
        kind: 'TEXT',
        content: 'Antwoord voor het kanaal.',
        job_id: 'job-ideachat',
      },
    })
    // Coalescing gecheckt op de gepersisteerde cutoff, geen nieuwe berichten →
    // geen vervolg-job en geen enqueue-notify.
    expect(txMocks.ideaChatMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        idea_id: 'idea-1',
        role: 'USER',
        OR: [
          { created_at: { gt: CUTOFF_AT } },
          { created_at: CUTOFF_AT, id: { gt: 'msg2' } },
        ],
      }),
    }))
    expect(txMocks.claudeJob.create).not.toHaveBeenCalled()
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
  })

  it('done + USER-bericht ná de cutoff → precies één vervolg-job + enqueue-notify', async () => {
    txMocks.ideaChatMessage.findFirst.mockResolvedValue({ id: 'msg-nieuw' })
    const handler = registerHandler()

    await handler({
      job_id: 'job-ideachat',
      status: 'done',
      summary: 'Antwoord voor het kanaal.',
    })

    expect(txMocks.claudeJob.create).toHaveBeenCalledTimes(1)
    expect(txMocks.claudeJob.create).toHaveBeenCalledWith({
      data: {
        user_id: 'user-1',
        product_id: 'prod-1',
        idea_id: 'idea-1',
        kind: 'IDEA_CHAT',
        status: 'QUEUED',
      },
      select: { id: true },
    })
    // notifyJobEnqueued draait buiten de tx via prisma.$executeRaw.
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1)
  })

  it('done + required_capability op de job → vervolg-job erft required_capability', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValueOnce(jobRow({ required_capability: 'local_llm' }))
    txMocks.ideaChatMessage.findFirst.mockResolvedValue({ id: 'msg-nieuw' })
    const handler = registerHandler()

    await handler({
      job_id: 'job-ideachat',
      status: 'done',
      summary: 'Antwoord voor het kanaal.',
    })

    expect(txMocks.claudeJob.create).toHaveBeenCalledWith({
      data: {
        user_id: 'user-1',
        product_id: 'prod-1',
        idea_id: 'idea-1',
        kind: 'IDEA_CHAT',
        status: 'QUEUED',
        required_capability: 'local_llm',
      },
      select: { id: true },
    })
  })

  it('failed + required_capability op de job → vervolg-job erft required_capability (coalescing draait ook bij failed)', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValueOnce(jobRow({ required_capability: 'local_llm' }))
    txMocks.claudeJob.update.mockResolvedValue(updatedRow('FAILED'))
    txMocks.ideaChatMessage.findFirst.mockResolvedValue({ id: 'msg-nieuw' })
    const handler = registerHandler()

    await handler({
      job_id: 'job-ideachat',
      status: 'failed',
      error: 'iets mis',
    })

    expect(txMocks.claudeJob.create).toHaveBeenCalledWith({
      data: {
        user_id: 'user-1',
        product_id: 'prod-1',
        idea_id: 'idea-1',
        kind: 'IDEA_CHAT',
        status: 'QUEUED',
        required_capability: 'local_llm',
      },
      select: { id: true },
    })
  })

  it('failed: IdeaLog JOB_EVENT zonder Idea.status-mutatie, coalescing draait wél', async () => {
    txMocks.claudeJob.update.mockResolvedValue(updatedRow('FAILED'))
    txMocks.ideaChatMessage.findFirst.mockResolvedValue({ id: 'msg-nieuw' })
    const handler = registerHandler()

    const result = await handler({
      job_id: 'job-ideachat',
      status: 'failed',
      error: 'iets mis',
    })

    expect(result).toMatchObject({
      structuredContent: { job_id: 'job-ideachat', status: 'failed' },
    })
    expect(txMocks.ideaLog.create).toHaveBeenCalledWith({
      data: {
        idea_id: 'idea-1',
        type: 'JOB_EVENT',
        content: 'IDEA_CHAT failed',
        metadata: { job_id: 'job-ideachat', error: 'iets mis' },
      },
    })
    // Status-neutraal: geen Idea.status-mutatie, in of buiten de tx.
    expect(txMocks.idea.update).not.toHaveBeenCalled()
    expect(mockPrisma.idea.update).not.toHaveBeenCalled()
    expect(txMocks.ideaChatMessage.create).not.toHaveBeenCalled()
    // Coalescing ook bij failed (spec §4.5) → vervolg-job.
    expect(txMocks.claudeJob.create).toHaveBeenCalledTimes(1)
  })

  it('done met lege summary wordt geweigerd zonder writes', async () => {
    const handler = registerHandler()

    const result = await handler({
      job_id: 'job-ideachat',
      status: 'done',
      summary: '   ',
    })

    expect(result).toMatchObject({ isError: true })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(txMocks.claudeJob.update).not.toHaveBeenCalled()
    expect(txMocks.ideaChatMessage.create).not.toHaveBeenCalled()
  })

  // ── M45-2b Taak 4: de vervolgjob volgt de productkeuze ────────────────────────────────────────────────
  // Met een keuze voor (product, IDEA_CHAT) wordt de vervolgjob een HARNESS-job met de gekozen configuratie en nooit
  // met een required_capability (spec §5.2). Zonder keuze blijft de regel van vóór M45: de legacy-local_llm-erving.
  // Een HARNESS-voorganger zonder keuze geeft dus een gewone Claude-vervolgjob: de keuze is ook de toestemming.
  describe('vervolgjob: routering via de productkeuze', () => {
    const CHOICE = { configuration: 'nieuw-model', max_cost_usd: '0.0500' }

    it.each([
      { label: 'een gewone Claude-job', overrides: {} },
      { label: 'een local_llm-job (die zijn capability niet doorgeeft)', overrides: { required_capability: 'local_llm' } },
      { label: 'een HARNESS-job met een andere configuratie', overrides: { runtime: 'HARNESS', requested_model: 'oud-model' } },
    ])('met een keuze voor het product → HARNESS-vervolgjob met de gekozen configuratie, vanuit $label', async ({ overrides }) => {
      mockPrisma.claudeJob.findUnique.mockResolvedValueOnce(jobRow(overrides))
      txMocks.productHarnessChoice.findUnique.mockResolvedValue(CHOICE)
      txMocks.ideaChatMessage.findFirst.mockResolvedValue({ id: 'msg-nieuw' })
      const handler = registerHandler()

      await handler({ job_id: 'job-ideachat', status: 'done', summary: 'Antwoord voor het kanaal.' })

      // Exact: geen required_capability, geen source, geen Claude-snapshotvelden.
      expect(txMocks.claudeJob.create).toHaveBeenCalledTimes(1)
      expect(txMocks.claudeJob.create.mock.calls[0][0]).toStrictEqual({
        data: {
          user_id: 'user-1',
          product_id: 'prod-1',
          idea_id: 'idea-1',
          kind: 'IDEA_CHAT',
          status: 'QUEUED',
          runtime: 'HARNESS',
          requested_model: 'nieuw-model',
        },
        select: { id: true },
      })
    })

    it('ook na een failed-beurt volgt de vervolgjob de keuze', async () => {
      txMocks.claudeJob.update.mockResolvedValue(updatedRow('FAILED'))
      txMocks.productHarnessChoice.findUnique.mockResolvedValue(CHOICE)
      txMocks.ideaChatMessage.findFirst.mockResolvedValue({ id: 'msg-nieuw' })

      await registerHandler()({ job_id: 'job-ideachat', status: 'failed', error: 'iets mis' })

      expect(txMocks.claudeJob.create.mock.calls[0][0].data).toMatchObject({
        runtime: 'HARNESS',
        requested_model: 'nieuw-model',
      })
    })

    it('zonder keuze en met een HARNESS-voorganger → een gewone Claude-vervolgjob, zonder runtime', async () => {
      mockPrisma.claudeJob.findUnique.mockResolvedValueOnce(jobRow({ runtime: 'HARNESS', requested_model: 'oud-model' }))
      txMocks.ideaChatMessage.findFirst.mockResolvedValue({ id: 'msg-nieuw' })

      await registerHandler()({ job_id: 'job-ideachat', status: 'done', summary: 'Antwoord voor het kanaal.' })

      expect(txMocks.claudeJob.create.mock.calls[0][0]).toStrictEqual({
        data: {
          user_id: 'user-1',
          product_id: 'prod-1',
          idea_id: 'idea-1',
          kind: 'IDEA_CHAT',
          status: 'QUEUED',
        },
        select: { id: true },
      })
    })

    it('de keuze wordt in dezelfde transactie gelezen, na de coalescing-check en vóór de create, voor (product, IDEA_CHAT)', async () => {
      txMocks.ideaChatMessage.findFirst.mockResolvedValue({ id: 'msg-nieuw' })

      await registerHandler()({ job_id: 'job-ideachat', status: 'done', summary: 'Antwoord voor het kanaal.' })

      expect(txMocks.productHarnessChoice.findUnique).toHaveBeenCalledTimes(1)
      expect(txMocks.productHarnessChoice.findUnique).toHaveBeenCalledWith(expect.objectContaining({
        where: { product_id_kind: { product_id: 'prod-1', kind: 'IDEA_CHAT' } },
      }))
      const read = txMocks.productHarnessChoice.findUnique.mock.invocationCallOrder[0]
      expect(txMocks.ideaChatMessage.findFirst.mock.invocationCallOrder[0]).toBeLessThan(read)
      expect(read).toBeLessThan(txMocks.claudeJob.create.mock.invocationCallOrder[0])
      // En alleen binnen de transactie: de lock stond er al.
      expect(txMocks.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(read)
    })

    it('zonder nieuw bericht komt er geen vervolgjob en wordt de keuze niet gelezen', async () => {
      txMocks.ideaChatMessage.findFirst.mockResolvedValue(null)

      await registerHandler()({ job_id: 'job-ideachat', status: 'done', summary: 'Antwoord voor het kanaal.' })

      expect(txMocks.claudeJob.create).not.toHaveBeenCalled()
      expect(txMocks.productHarnessChoice.findUnique).not.toHaveBeenCalled()
    })

    it('een lege product_id leest geen keuze: de vervolgjob volgt dan de regel van vóór M45', async () => {
      mockPrisma.claudeJob.findUnique.mockResolvedValueOnce(jobRow({ product_id: '', required_capability: 'local_llm' }))
      txMocks.ideaChatMessage.findFirst.mockResolvedValue({ id: 'msg-nieuw' })

      await registerHandler()({ job_id: 'job-ideachat', status: 'done', summary: 'Antwoord voor het kanaal.' })

      expect(txMocks.productHarnessChoice.findUnique).not.toHaveBeenCalled()
      expect(txMocks.claudeJob.create.mock.calls[0][0].data).toMatchObject({ required_capability: 'local_llm' })
    })

    it('een leesfout van de keuze is geen "geen keuze": de afronding mislukt en er komt geen vervolgjob', async () => {
      txMocks.ideaChatMessage.findFirst.mockResolvedValue({ id: 'msg-nieuw' })
      txMocks.productHarnessChoice.findUnique.mockRejectedValue(new Error('READ_FAILED'))

      const result = (await registerHandler()({
        job_id: 'job-ideachat', status: 'done', summary: 'Antwoord voor het kanaal.',
      })) as { isError?: boolean; content: [{ text: string }] }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe('READ_FAILED')
      expect(txMocks.claudeJob.create).not.toHaveBeenCalled()
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
    })
  })

  // ── M45-2b Taak 4: de kostenmelding van een HARNESS-job op het idee-chat-pad ───────────────────────
  // De kostenrij gaat in de bestaande transactie, direct na de statusupdate, onder dezelfde per-idea lock.
  describe('kostenmelding van een HARNESS-job', () => {
    const COST = { reported_cost_usd: '0.0042', cost_source: 'litellm_computed', provider: 'openai' } as const
    const harnessChat = () => jobRow({ runtime: 'HARNESS', requested_model: 'gsq-lokaal' })
    const ROW = {
      reported_cost_usd: '0.0042',
      cost_source: 'litellm_computed',
      provider: 'openai',
      configuration: 'gsq-lokaal',
      reported_at: expect.any(Date),
    }

    it.each([
      { status: 'done', dbStatus: 'DONE', extra: { summary: 'Antwoord voor het kanaal.' } },
      { status: 'failed', dbStatus: 'FAILED', extra: { error: 'COST_LIMIT_EXCEEDED' } },
    ] as const)('$status + cost: de upsert staat in de tx, direct na de statusupdate', async ({ status, dbStatus, extra }) => {
      mockPrisma.claudeJob.findUnique.mockResolvedValueOnce(harnessChat())
      txMocks.claudeJob.update.mockResolvedValue(updatedRow(dbStatus))

      const result = await registerHandler()({ job_id: 'job-ideachat', status, ...extra, cost: COST })

      expect(result).toMatchObject({ structuredContent: { job_id: 'job-ideachat', status } })
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
      expect(txMocks.jobCostReport.upsert).toHaveBeenCalledTimes(1)
      expect(txMocks.jobCostReport.upsert).toHaveBeenCalledWith({
        where: { job_id: 'job-ideachat' },
        create: { job_id: 'job-ideachat', ...ROW },
        update: ROW,
      })
      // Na de update en vóór de rest van de afronding (assistant-bericht, IdeaLog, coalescing).
      const upsert = txMocks.jobCostReport.upsert.mock.invocationCallOrder[0]
      expect(txMocks.claudeJob.update.mock.invocationCallOrder[0]).toBeLessThan(upsert)
      expect(upsert).toBeLessThan(txMocks.ideaChatMessage.findFirst.mock.invocationCallOrder[0])
      // Niet erbuiten: de losse client schrijft niets.
      expect(mockPrisma.jobCostReport.upsert).not.toHaveBeenCalled()
      expect(mockPrisma.claudeJob.update).not.toHaveBeenCalled()
    })

    it('zonder cost schrijft de tx geen kostenrij', async () => {
      mockPrisma.claudeJob.findUnique.mockResolvedValueOnce(harnessChat())

      await registerHandler()({ job_id: 'job-ideachat', status: 'done', summary: 'Antwoord voor het kanaal.' })

      expect(txMocks.claudeJob.update).toHaveBeenCalledTimes(1)
      expect(txMocks.jobCostReport.upsert).not.toHaveBeenCalled()
    })

    it('een Claude-job met cost → COST_REPORT_NOT_ALLOWED, zonder transactie en zonder schrijven', async () => {
      const result = (await registerHandler()({
        job_id: 'job-ideachat', status: 'done', summary: 'Antwoord voor het kanaal.', cost: COST,
      })) as { isError?: boolean; content: [{ text: string }] }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe('VALIDATION_ERROR: COST_REPORT_NOT_ALLOWED')
      expect(mockPrisma.$transaction).not.toHaveBeenCalled()
      expect(txMocks.claudeJob.update).not.toHaveBeenCalled()
      expect(txMocks.jobCostReport.upsert).not.toHaveBeenCalled()
    })

    it('een ongeldige melding → COST_REPORT_INVALID, zonder transactie en zonder schrijven', async () => {
      mockPrisma.claudeJob.findUnique.mockResolvedValueOnce(harnessChat())

      const result = (await registerHandler()({
        job_id: 'job-ideachat', status: 'done', summary: 'Antwoord voor het kanaal.',
        cost: { reported_cost_usd: null, cost_source: 'provider_reported' },
      })) as { isError?: boolean; content: [{ text: string }] }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe('VALIDATION_ERROR: COST_REPORT_INVALID')
      expect(mockPrisma.$transaction).not.toHaveBeenCalled()
      expect(txMocks.claudeJob.update).not.toHaveBeenCalled()
      expect(txMocks.jobCostReport.upsert).not.toHaveBeenCalled()
    })

    it('een mislukte upsert breekt de hele afronding af: geen assistant-bericht, geen vervolgjob, geen melding', async () => {
      mockPrisma.claudeJob.findUnique.mockResolvedValueOnce(harnessChat())
      txMocks.ideaChatMessage.findFirst.mockResolvedValue({ id: 'msg-nieuw' })
      txMocks.jobCostReport.upsert.mockRejectedValue(new Error('upsert faalde'))

      const result = (await registerHandler()({
        job_id: 'job-ideachat', status: 'done', summary: 'Antwoord voor het kanaal.', cost: COST,
      })) as { isError?: boolean; content: [{ text: string }] }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe('upsert faalde')
      expect(txMocks.ideaChatMessage.create).not.toHaveBeenCalled()
      expect(txMocks.claudeJob.create).not.toHaveBeenCalled()
      expect(pgMocks.query).not.toHaveBeenCalled()
    })
  })
})
