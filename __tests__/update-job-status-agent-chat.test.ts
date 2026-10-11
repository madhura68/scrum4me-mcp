// M50-1a (Taak 3, stap 4 en 5): update_job_status voor een AGENT_CHAT-job (chat-agent-spec §5.4). Een chatjob heeft geen
// worktree, verify of push. running, done en failed zijn atomaire overgangen: de guarded updateMany wint, en bij nul
// rijen leest de transactie de rij opnieuw en bepaalt de uitkomst (test e, de racetak). done met antwoord schrijft één
// ASSISTANT-bericht met job_id; een verwijderde chat krijgt DONE met tokens en kosten, zonder bericht. De kostenmelding
// (stap 5) gaat op dezelfde manier als bij HARNESS-soorten.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toolText } from './helpers/tool-result.js'

const authMocks = vi.hoisted(() => ({
  requireWriteAccess: vi.fn(),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
const pgMocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }))
const pushMocks = vi.hoisted(() => ({ pushBranchForJob: vi.fn(), triggerPush: vi.fn() }))
const worktreeQueueMocks = vi.hoisted(() => ({
  markWorktreeCleanupPending: vi.fn(),
  isWorktreeCleanupPending: vi.fn(),
  clearWorktreeCleanupPending: vi.fn(),
}))
const jobLockMocks = vi.hoisted(() => ({ releaseLocksOnTerminal: vi.fn() }))

vi.mock('../src/auth.js', () => authMocks)
vi.mock('../src/git/job-locks.js', () => jobLockMocks)
vi.mock('../src/git/push.js', () => ({ pushBranchForJob: pushMocks.pushBranchForJob }))
vi.mock('../src/lib/push-trigger.js', () => ({ triggerPush: pushMocks.triggerPush }))
vi.mock('../src/git/worktree-cleanup-queue.js', () => worktreeQueueMocks)
vi.mock('pg', () => ({
  Client: vi.fn(function Client() {
    return { connect: pgMocks.connect, query: pgMocks.query, end: pgMocks.end }
  }),
}))

// De transactie: één object dat de callback ontvangt, zoals Prisma een interactieve transactie doet.
const txMock = vi.hoisted(() => ({
  claudeJob: { updateMany: vi.fn(), findUnique: vi.fn() },
  jobCostReport: { upsert: vi.fn() },
  agentChatJob: { findUnique: vi.fn() },
  agentChatMessage: { create: vi.fn() },
  agentChat: { update: vi.fn() },
  $queryRaw: vi.fn(),
}))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    jobCostReport: { upsert: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}))

import { prisma } from '../src/prisma.js'
import { registerUpdateJobStatusTool } from '../src/tools/update-job-status.js'

const mockPrisma = prisma as unknown as {
  claudeJob: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> }
  jobCostReport: { upsert: ReturnType<typeof vi.fn> }
  $executeRaw: ReturnType<typeof vi.fn>
  $transaction: ReturnType<typeof vi.fn>
}

const JOB_ID = 'job-chat-1'
const CHAT_ID = 'chat-1'
const CANCELLED_TEXT = 'JOB_CANCELLED: This job was cancelled by the PBI fail-cascade. Discard your local changes and call wait_for_job for the next item.'

type Handler = (input: {
  job_id: string
  status: 'running' | 'done' | 'failed' | 'skipped'
  summary?: string
  error?: string
  cost?: { reported_cost_usd: string | null; cost_source: string; provider?: string }
}) => Promise<{ isError?: boolean; content: [{ text: string }]; structuredContent?: Record<string, unknown> }>

function registerHandler(): Handler {
  let handler: Handler | null = null
  registerUpdateJobStatusTool({
    registerTool: (_n: string, _c: unknown, cb: Handler) => { handler = cb },
  } as never)
  return handler!
}

/** Prisma geeft alleen de geselecteerde velden terug, zoals in update-job-status-harness-cost.test.ts. */
function installJobFixture(fixture: Record<string, unknown> & { id: string }) {
  mockPrisma.claudeJob.findUnique.mockImplementation((async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
    if (args.where.id !== fixture.id) return null
    if (!args.select) return fixture
    return Object.fromEntries(Object.keys(args.select).filter((key) => key in fixture).map((key) => [key, fixture[key]]))
  }) as never)
}

/** Een AGENT_CHAT/MANUAL-job: geen taak, geen idee, geen draft, runtime HARNESS. */
function chatFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    status: 'CLAIMED',
    claimed_at: new Date('2026-10-11T09:00:00Z'),
    started_at: null,
    claimed_by_token_id: 'token-1',
    user_id: 'user-1',
    product_id: 'prod-1',
    task_id: null,
    idea_id: null,
    sprint_run_id: null,
    kind: 'AGENT_CHAT',
    runtime: 'HARNESS',
    source: 'MANUAL',
    verify_result: null,
    created_at: new Date('2026-10-11T08:59:00Z'),
    chat_cutoff_message_id: null,
    chat_cutoff_at: null,
    required_capability: null,
    requested_model: 'gsq-lokaal',
    dispatch_request_id: null,
    dispatch_candidate_id: null,
    task_executions: [],
    task: null,
    branch: null,
    pr_url: null,
    ...overrides,
  }
}

/** De rij zoals de transactie hem na een geslaagde overgang of een herlezing ziet. */
const row = (status: string, extra: Record<string, unknown> = {}) => ({
  id: JOB_ID,
  status,
  claimed_by_token_id: 'token-1',
  branch: null,
  pushed_at: null,
  pr_url: null,
  verify_result: null,
  summary: null,
  error: null,
  started_at: new Date('2026-10-11T09:00:01Z'),
  finished_at: null,
  head_sha: null,
  ...extra,
})

const COST = { reported_cost_usd: '0.000313', cost_source: 'provider_reported', provider: 'openrouter' } as const

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SCRUM4ME_AGENT_WORKTREE_DIR = '/wt'
  authMocks.requireWriteAccess.mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' })
  pgMocks.connect.mockResolvedValue(undefined)
  pgMocks.query.mockResolvedValue({ rows: [] })
  pgMocks.end.mockResolvedValue(undefined)
  jobLockMocks.releaseLocksOnTerminal.mockResolvedValue(undefined)
  pushMocks.triggerPush.mockResolvedValue(undefined)
  worktreeQueueMocks.isWorktreeCleanupPending.mockResolvedValue(false)
  mockPrisma.claudeJob.count.mockResolvedValue(0)

  // Standaard: de overgang slaagt, de chat bestaat, en het antwoord wordt geschreven.
  txMock.claudeJob.updateMany.mockResolvedValue({ count: 1 })
  txMock.claudeJob.findUnique.mockResolvedValue(row('DONE'))
  txMock.jobCostReport.upsert.mockResolvedValue({ job_id: JOB_ID })
  txMock.agentChatJob.findUnique.mockResolvedValue({ chat_id: CHAT_ID })
  txMock.$queryRaw.mockResolvedValue([{ id: CHAT_ID }])
  txMock.agentChatMessage.create.mockResolvedValue({ id: 'msg-1' })
  txMock.agentChat.update.mockResolvedValue({ id: CHAT_ID })
  mockPrisma.$transaction.mockImplementation((async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (client: typeof txMock) => unknown)(txMock) : Promise.all(arg as Promise<unknown>[])) as never)
  mockPrisma.$executeRaw.mockResolvedValue(1)
  installJobFixture(chatFixture())
})

describe('update_job_status: de overgang van een AGENT_CHAT-job (de eigen tak, niet de MANUAL-route)', () => {
  it('done met antwoord: één transactie met de overgang, het ASSISTANT-bericht met job_id en agent_chats.updated_at; geen worktree, geen push', async () => {
    const result = await registerHandler()({ job_id: JOB_ID, status: 'done', summary: 'Het antwoord.' })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ job_id: JOB_ID, status: 'done' })
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(txMock.claudeJob.updateMany).toHaveBeenCalledWith({
      where: { id: JOB_ID, claimed_by_token_id: 'token-1', status: { in: ['CLAIMED', 'RUNNING'] } },
      data: expect.objectContaining({ status: 'DONE', summary: 'Het antwoord.', finished_at: expect.any(Date) }),
    })
    expect(txMock.agentChatMessage.create).toHaveBeenCalledWith({
      data: { chat_id: CHAT_ID, role: 'ASSISTANT', content: 'Het antwoord.', job_id: JOB_ID },
    })
    expect(txMock.agentChat.update).toHaveBeenCalledWith({ where: { id: CHAT_ID }, data: { updated_at: expect.any(Date) } })
    // Niet de snelle MANUAL-route (die schrijft via claudeJob.update), en geen push of verify.
    expect(mockPrisma.claudeJob.update).not.toHaveBeenCalled()
    expect(pushMocks.pushBranchForJob).not.toHaveBeenCalled()
    expect(worktreeQueueMocks.markWorktreeCleanupPending).not.toHaveBeenCalled()
  })

  it('het bericht hoort bij de chat van de job en vergrendelt die chat (FOR KEY SHARE) vóór het schrijven', async () => {
    await registerHandler()({ job_id: JOB_ID, status: 'done', summary: 'Het antwoord.' })

    const lockOrder = txMock.$queryRaw.mock.invocationCallOrder[0]
    const messageOrder = txMock.agentChatMessage.create.mock.invocationCallOrder[0]
    expect(lockOrder).toBeLessThan(messageOrder)
    const lockSql = (txMock.$queryRaw.mock.calls[0][0] as readonly string[]).join('?')
    expect(lockSql).toContain('FOR KEY SHARE')
    expect(lockSql).toContain('agent_chats')
  })

  it('done met een lege summary wordt geweigerd, zonder enige schrijfactie', async () => {
    const result = await registerHandler()({ job_id: JOB_ID, status: 'done', summary: '   ' })

    expect(result.isError).toBe(true)
    expect(toolText(result as never)).toContain('AGENT_CHAT done vereist een non-empty summary')
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('done zonder summary wordt ook geweigerd', async () => {
    const result = await registerHandler()({ job_id: JOB_ID, status: 'done' })

    expect(result.isError).toBe(true)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('failed schrijft de overgang zonder bericht in de chat', async () => {
    txMock.claudeJob.findUnique.mockResolvedValue(row('FAILED'))

    const result = await registerHandler()({ job_id: JOB_ID, status: 'failed', summary: undefined })

    expect(result.isError).toBeFalsy()
    expect(txMock.claudeJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }))
    expect(txMock.agentChatMessage.create).not.toHaveBeenCalled()
  })

  it('running gaat via een guarded updateMany op CLAIMED, zet started_at en schrijft geen bericht', async () => {
    txMock.claudeJob.findUnique.mockResolvedValue(row('RUNNING'))

    const result = await registerHandler()({ job_id: JOB_ID, status: 'running' })

    expect(result.isError).toBeFalsy()
    expect(txMock.claudeJob.updateMany).toHaveBeenCalledWith({
      where: { id: JOB_ID, claimed_by_token_id: 'token-1', status: { in: ['CLAIMED'] } },
      data: expect.objectContaining({ status: 'RUNNING', started_at: expect.any(Date) }),
    })
    expect(txMock.agentChatMessage.create).not.toHaveBeenCalled()
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1) // alleen de notify
  })

  it('skipped wordt geweigerd door de generieke gate, met de exacte tekst; geen transactie', async () => {
    const result = await registerHandler()({ job_id: JOB_ID, status: 'skipped', summary: undefined, cost: undefined })

    expect(result.isError).toBe(true)
    expect(toolText(result as never)).toBe("'skipped' is alleen toegestaan voor TASK_IMPLEMENTATION of DEPLOY (kind=AGENT_CHAT)")
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('de racetak: nul rijen bij de overgang, de herlezing in dezelfde transactie bepaalt de uitkomst (test e)', () => {
  beforeEach(() => {
    txMock.claudeJob.updateMany.mockResolvedValue({ count: 0 })
  })

  it.each(['done', 'failed'] as const)('CANCELLED bij %s: JOB_CANCELLED, geen bericht, geen kostenrij', async (status) => {
    txMock.claudeJob.findUnique.mockResolvedValue(row('CANCELLED'))

    const result = await registerHandler()({ job_id: JOB_ID, status, summary: 'Het antwoord.', cost: COST })

    expect(result.isError).toBe(true)
    expect(toolText(result as never)).toBe(CANCELLED_TEXT)
    expect(txMock.agentChatMessage.create).not.toHaveBeenCalled()
    expect(txMock.jobCostReport.upsert).not.toHaveBeenCalled()
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled() // geen notify na een mislukte overgang
  })

  it('CANCELLED bij running: JOB_CANCELLED', async () => {
    txMock.claudeJob.findUnique.mockResolvedValue(row('CANCELLED'))

    const result = await registerHandler()({ job_id: JOB_ID, status: 'running' })

    expect(result.isError).toBe(true)
    expect(toolText(result as never)).toBe(CANCELLED_TEXT)
  })

  it('RUNNING door het eigen token bij running: ok zonder schrijfactie en zonder notify', async () => {
    txMock.claudeJob.findUnique.mockResolvedValue(row('RUNNING'))

    const result = await registerHandler()({ job_id: JOB_ID, status: 'running' })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ job_id: JOB_ID, status: 'running' })
    expect(txMock.claudeJob.updateMany).toHaveBeenCalledTimes(1)
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
  })

  it('DONE bij done: "Job is already in terminal state", geen tweede bericht', async () => {
    txMock.claudeJob.findUnique.mockResolvedValue(row('DONE'))

    const result = await registerHandler()({ job_id: JOB_ID, status: 'done', summary: 'Tweede antwoord.' })

    expect(result.isError).toBe(true)
    expect(toolText(result as never)).toContain('Job is already in terminal state: done')
    expect(txMock.agentChatMessage.create).not.toHaveBeenCalled()
  })

  it('een job die van een ander token is: PERMISSION_DENIED', async () => {
    txMock.claudeJob.findUnique.mockResolvedValue(row('CLAIMED', { claimed_by_token_id: 'token-B' }))

    const result = await registerHandler()({ job_id: JOB_ID, status: 'done', summary: 'Antwoord.' })

    expect(result.isError).toBe(true)
    expect(toolText(result as never)).toContain('PERMISSION_DENIED')
    expect(txMock.agentChatMessage.create).not.toHaveBeenCalled()
  })
})

describe('bewaking: de eerste lezing van update_job_status blijft zoals die was', () => {
  it('een job die al CANCELLED is bij de eerste lezing: JOB_CANCELLED, zonder transactie', async () => {
    installJobFixture(chatFixture({ status: 'CANCELLED' }))

    const result = await registerHandler()({ job_id: JOB_ID, status: 'done', summary: 'Antwoord.' })

    expect(result.isError).toBe(true)
    expect(toolText(result as never)).toBe(CANCELLED_TEXT)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('een herhaalde running op een RUNNING-job: ok', async () => {
    installJobFixture(chatFixture({ status: 'RUNNING', started_at: new Date('2026-10-11T09:00:01Z') }))
    txMock.claudeJob.updateMany.mockResolvedValue({ count: 0 })
    txMock.claudeJob.findUnique.mockResolvedValue(row('RUNNING'))

    const result = await registerHandler()({ job_id: JOB_ID, status: 'running' })

    expect(result.isError).toBeFalsy()
  })
})

describe('de verwijderde chat: DONE met tokens en kosten, zonder bericht', () => {
  it('done met kosten, zonder chat (FOR KEY SHARE vindt geen rij): de overgang en de kostenrij slagen, geen bericht', async () => {
    txMock.$queryRaw.mockResolvedValue([])

    const result = await registerHandler()({ job_id: JOB_ID, status: 'done', summary: 'Antwoord.', cost: COST })

    expect(result.isError).toBeFalsy()
    expect(txMock.claudeJob.updateMany).toHaveBeenCalledTimes(1)
    expect(txMock.jobCostReport.upsert).toHaveBeenCalledTimes(1)
    expect(txMock.agentChatMessage.create).not.toHaveBeenCalled()
    expect(txMock.agentChat.update).not.toHaveBeenCalled()
  })

  it('done zonder koppelrij naar een chat: idem, geen bericht', async () => {
    txMock.agentChatJob.findUnique.mockResolvedValue(null)

    const result = await registerHandler()({ job_id: JOB_ID, status: 'done', summary: 'Antwoord.' })

    expect(result.isError).toBeFalsy()
    expect(txMock.agentChatMessage.create).not.toHaveBeenCalled()
  })
})

describe('stap 5: de kostenmelding van een AGENT_CHAT-job (dezelfde regels als de HARNESS-soorten)', () => {
  it('done met bron local en bedrag 0 schrijft één kostenrij in dezelfde transactie als de overgang', async () => {
    const result = await registerHandler()({
      job_id: JOB_ID,
      status: 'done',
      summary: 'Antwoord.',
      cost: { reported_cost_usd: '0', cost_source: 'local' },
    })

    expect(result.isError).toBeFalsy()
    expect(txMock.jobCostReport.upsert).toHaveBeenCalledTimes(1)
    expect(txMock.jobCostReport.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { job_id: JOB_ID },
      create: expect.objectContaining({ job_id: JOB_ID, reported_cost_usd: '0', cost_source: 'local', configuration: 'gsq-lokaal' }),
    }))
  })

  it('failed met provider_reported schrijft één kostenrij, zonder bericht', async () => {
    txMock.claudeJob.findUnique.mockResolvedValue(row('FAILED'))

    const result = await registerHandler()({ job_id: JOB_ID, status: 'failed', error: 'model timeout', cost: COST })

    expect(result.isError).toBeFalsy()
    expect(txMock.jobCostReport.upsert).toHaveBeenCalledTimes(1)
    expect(txMock.agentChatMessage.create).not.toHaveBeenCalled()
  })

  it('running met kosten wordt geweigerd: kosten horen bij de eindstatus', async () => {
    const result = await registerHandler()({ job_id: JOB_ID, status: 'running', cost: COST })

    expect(result.isError).toBe(true)
    expect(toolText(result as never)).toContain('COST_REPORT_NOT_ALLOWED')
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })
})
