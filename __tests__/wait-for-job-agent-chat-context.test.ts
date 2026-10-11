// M50-1a (Taak 3, stap 2 en 3): een geclaimde AGENT_CHAT-job. getFullJobContext geeft de chatpayload (en de MANUAL-tak
// rolt hem niet terug, want een chatjob heeft geen draft). Een verwijderde chat zet de job atomair op SKIPPED; de
// handler geeft dan geen payload en geen toolfout, maar wacht verder op een volgende job.
// De handler draait echt (tryClaimJob, resetStaleClaimedJobs, getFullJobContext); de database en LISTEN zijn nagebootst.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { toolText } from './helpers/tool-result.js'

const authMocks = vi.hoisted(() => ({ requireWriteAccess: vi.fn(), getTokenScopedProducts: vi.fn() }))
const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  claudeJob: { findUnique: vi.fn() },
  agentChatJob: { findUnique: vi.fn() },
  agentChatMessage: { findMany: vi.fn() },
}))
const pgClient = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))
const worktreeMocks = vi.hoisted(() => ({ createWorktreeForJob: vi.fn(), removeWorktreeForJob: vi.fn() }))

vi.mock('../src/auth.js', async () => ({
  ...(await vi.importActual<typeof import('../src/auth.js')>('../src/auth.js')),
  requireWriteAccess: authMocks.requireWriteAccess,
  getTokenScopedProducts: authMocks.getTokenScopedProducts,
}))
vi.mock('pg', () => ({ Client: vi.fn(function Client() { return pgClient }) }))
vi.mock('../src/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    claudeJob: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    jobKindConfig: { findUnique: vi.fn() },
    productHarnessChoice: { findUnique: vi.fn() },
  },
}))
vi.mock('../src/lib/doc-index.js', () => ({ buildDocIndex: vi.fn().mockResolvedValue(null) }))
vi.mock('../src/git/worktree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/git/worktree.js')>()),
  ...worktreeMocks,
}))

import { prisma } from '../src/prisma.js'
import { getFullJobContext, registerWaitForJobTool } from '../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  $queryRaw: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
  $transaction: ReturnType<typeof vi.fn>
  claudeJob: {
    findUnique: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
  jobKindConfig: { findUnique: ReturnType<typeof vi.fn> }
  productHarnessChoice: { findUnique: ReturnType<typeof vi.fn> }
}

const USER_ID = 'user-1'
const TOKEN_ID = 'token-A'
const INSTANCE_ID = 'worker-A'
const JOB_ID = 'job-chat-0001'
const OWNER = { jobId: JOB_ID, instanceId: INSTANCE_ID, tokenId: TOKEN_ID }
const CONFIG = { runtime: 'HARNESS', model: 'gsq-lokaal', max_cost_usd: '0.05' }

type Handler = (input: { wait_seconds: number }) => Promise<CallToolResult>
let handler: Handler
/** De kandidaten die tryClaimJob achtereenvolgens ziet: [] is "geen job", een rij is de te claimen job. */
let claimQueue: Array<Array<Record<string, unknown>>>

const sqlText = (strings: readonly string[]) => strings.join('?')
/** De lease-verlenging van een rollback (QUEUED terug). pg_notify van de skip telt niet mee. */
const leaseBumps = () => mockPrisma.$executeRaw.mock.calls.filter(([strings]) => sqlText(strings as readonly string[]).includes('lease_until'))

function candidateRow() {
  return { id: JOB_ID, implementation_plan: null, sprint_run_id: null, kind: 'AGENT_CHAT', idea_id: null }
}

/** Een AGENT_CHAT/MANUAL-job zoals getFullJobContext hem leest: zonder draft, zonder taak, zonder idee. */
function chatJob(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    kind: 'AGENT_CHAT',
    source: 'MANUAL',
    status: 'CLAIMED',
    runtime: 'HARNESS',
    user_id: USER_ID,
    product_id: 'prod-1',
    requested_model: 'gsq-lokaal',
    requested_thinking_budget: null,
    requested_permission_mode: null,
    required_capability: null,
    sprint_run_id: null,
    task_id: null,
    idea_id: null,
    branch: null,
    created_at: new Date('2026-10-11T10:00:00.000Z'),
    manual_drafts: [],
    idea: null,
    task: null,
    product: {
      id: 'prod-1',
      code: 'SCRUM4ME',
      name: 'Scrum4Me',
      repo_url: 'https://git.example/scrum4me.git',
      definition_of_done: 'Tests groen.',
      preferred_model: null,
      thinking_budget_default: null,
      preferred_permission_mode: null,
      auto_deploy: false,
      deploy_flow: null,
    },
    ...overrides,
  }
}

/** De koppelrij en de berichten van een chat met één pending-bericht van deze job. */
function chatRows({ chatId = 'chat-1' }: { chatId?: string | null } = {}) {
  return {
    link: {
      chat: chatId === null ? null : { id: chatId, product: { id: 'prod-1', name: 'Scrum4Me', code: 'SCRUM4ME' } },
      prompt_version: { content: 'Je bent de chat-agent.' },
    },
    messages: [
      { id: 'u0', role: 'USER', content: 'eerdere vraag', job_id: 'job-old' },
      { id: 'a0', role: 'ASSISTANT', content: 'eerder antwoord', job_id: 'job-old' },
      { id: 'pending', role: 'USER', content: 'nieuwe vraag', job_id: JOB_ID },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SCRUM4ME_WORKER_INSTANCE_ID', INSTANCE_ID)
  vi.stubEnv('SCRUM4ME_WORKER_RUNTIME', 'HARNESS')
  authMocks.requireWriteAccess.mockResolvedValue({ userId: USER_ID, tokenId: TOKEN_ID, username: 'jan', isDemo: false })
  authMocks.getTokenScopedProducts.mockResolvedValue([])

  claimQueue = []
  mockPrisma.$queryRaw.mockResolvedValue([])
  mockPrisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
  tx.$queryRaw.mockImplementation(async (strings: readonly string[]) => {
    const sql = sqlText(strings)
    if (sql.includes('SKIP LOCKED')) return claimQueue.shift() ?? []
    if (sql.includes('RETURNING id, task_id')) return []
    throw new Error(`onverwachte tx.$queryRaw: ${sql}`)
  })
  tx.$executeRaw.mockResolvedValue(1)
  tx.claudeJob.findUnique.mockResolvedValue(null)
  tx.agentChatJob.findUnique.mockResolvedValue(chatRows().link)
  tx.agentChatMessage.findMany.mockResolvedValue(chatRows().messages)

  pgClient.connect.mockResolvedValue(undefined)
  pgClient.query.mockResolvedValue({ rows: [] })
  pgClient.end.mockResolvedValue(undefined)
  pgClient.on.mockImplementation((event: string, listener: (message: { payload?: string }) => void) => {
    if (event === 'notification') {
      queueMicrotask(() => listener({ payload: JSON.stringify({ type: 'claude_job_enqueued', user_id: USER_ID }) }))
    }
  })

  mockPrisma.claudeJob.findUnique.mockResolvedValue(chatJob())
  mockPrisma.claudeJob.findFirst.mockResolvedValue(null)
  mockPrisma.claudeJob.update.mockResolvedValue({})
  mockPrisma.claudeJob.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.jobKindConfig.findUnique.mockResolvedValue(null)
  mockPrisma.productHarnessChoice.findUnique.mockResolvedValue(null)

  const server = { registerTool: vi.fn((_name: string, _meta: unknown, fn: Handler) => { handler = fn }) }
  registerWaitForJobTool(server as unknown as McpServer)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getFullJobContext: een AGENT_CHAT-job krijgt de chatpayload', () => {
  it('geeft de payload met de config van de resolver, de geschiedenis en het pending-bericht, en rolt de claim niet terug', async () => {
    const context = await getFullJobContext(JOB_ID, 'HARNESS', OWNER)

    expect(context).toEqual({
      kind: 'AGENT_CHAT',
      job_id: JOB_ID,
      config: CONFIG,
      chat: { id: 'chat-1', product: { id: 'prod-1', name: 'Scrum4Me', code: 'SCRUM4ME' } },
      history: [
        { role: 'user', content: 'eerdere vraag' },
        { role: 'assistant', content: 'eerder antwoord' },
      ],
      pending: { message_id: 'pending', content: 'nieuwe vraag' },
      system_prompt: 'Je bent de chat-agent.',
    })
    // Geen rollback naar QUEUED (de MANUAL-tak zou dat doen zonder draft), en geen plafondkeuze van het product.
    expect(leaseBumps()).toHaveLength(0)
    expect(mockPrisma.productHarnessChoice.findUnique).not.toHaveBeenCalled()
  })
})

describe('een verwijderde chat: de job wordt SKIPPED en er gaat geen payload weg', () => {
  const skipped = { where: expect.objectContaining({ id: JOB_ID, status: 'CLAIMED', claimed_by_token_id: TOKEN_ID, worker_instance_id: INSTANCE_ID }), data: expect.objectContaining({ status: 'SKIPPED', error: 'AGENT_CHAT_CHAT_DELETED' }) }

  it('getFullJobContext zet CLAIMED → SKIPPED atomair met finished_at en gooit de skip-uitkomst', async () => {
    tx.agentChatJob.findUnique.mockResolvedValue(chatRows({ chatId: null }).link)

    await expect(getFullJobContext(JOB_ID, 'HARNESS', OWNER)).rejects.toMatchObject({ name: 'AgentChatSkippedError', reason: 'AGENT_CHAT_CHAT_DELETED' })

    expect(mockPrisma.claudeJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: JOB_ID, status: 'CLAIMED' }),
      data: expect.objectContaining({ status: 'SKIPPED', error: 'AGENT_CHAT_CHAT_DELETED', finished_at: expect.any(Date) }),
    })
    expect(mockPrisma.claudeJob.updateMany.mock.calls[0][0]).toEqual(skipped)
    expect(leaseBumps()).toHaveLength(0)
  })

  it('bij een koppelrij die ontbreekt: dezelfde skip', async () => {
    tx.agentChatJob.findUnique.mockResolvedValue(null)

    await expect(getFullJobContext(JOB_ID, 'HARNESS', OWNER)).rejects.toMatchObject({ reason: 'AGENT_CHAT_CHAT_DELETED' })
    expect(mockPrisma.claudeJob.updateMany).toHaveBeenCalledTimes(1)
  })

  it.each([['direct', false], ['wait', true]] as const)(
    'de handler op het %s-claimpad geeft geen payload en geen toolfout, maar wacht verder (de wachtlus eindigt op timeout)',
    async (_path, waitFirst) => {
      tx.agentChatJob.findUnique.mockResolvedValue(chatRows({ chatId: null }).link)
      claimQueue = waitFirst ? [[], [candidateRow()]] : [[candidateRow()]]

      const result = await handler({ wait_seconds: 1 })

      expect(result.isError).toBeFalsy()
      const body = JSON.parse(toolText(result))
      expect(body).toEqual({ status: 'timeout', message: 'No job available within wait window' })
      expect(mockPrisma.claudeJob.updateMany).toHaveBeenCalledTimes(1)
      expect(mockPrisma.claudeJob.updateMany.mock.calls[0][0]).toEqual(skipped)
    },
  )
})

describe('een AGENT_CHAT-job via de handler', () => {
  it('geeft de chatpayload als JSON, zonder worktree en zonder toolfout', async () => {
    claimQueue = [[candidateRow()]]

    const result = await handler({ wait_seconds: 1 })

    expect(result.isError).toBeFalsy()
    expect(worktreeMocks.createWorktreeForJob).not.toHaveBeenCalled()
    const body = JSON.parse(toolText(result))
    expect(body).toMatchObject({ kind: 'AGENT_CHAT', job_id: JOB_ID, config: CONFIG, pending: { content: 'nieuwe vraag' } })
    expect(body).not.toHaveProperty('worktree_path')
  })
})

describe('een AGENT_CHAT-job die niet op HARNESS draait (M50-1a, MINOR 7)', () => {
  it('een verkeerd geclaimde rij (runtime CLAUDE) wordt FAILED met AGENT_CHAT_REQUIRES_HARNESS, en blijft niet op CLAIMED hangen', async () => {
    vi.stubEnv('SCRUM4ME_WORKER_RUNTIME', 'CLAUDE')
    mockPrisma.claudeJob.findUnique.mockResolvedValue(chatJob({ runtime: 'CLAUDE', requested_model: null }))
    claimQueue = [[candidateRow()]]

    const result = await handler({ wait_seconds: 1 })

    expect(result.isError).toBe(true)
    expect(toolText(result)).toBe('AGENT_CHAT_REQUIRES_HARNESS')
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith({
      where: { id: JOB_ID },
      data: expect.objectContaining({ status: 'FAILED', error: 'AGENT_CHAT_REQUIRES_HARNESS' }),
    })
  })
})

describe('na een skip probeert de claimlus direct opnieuw, begrensd (M50-1a, MINOR 4)', () => {
  it('acht verwijderde chats achter elkaar: één directe poging en vijf herhalingen zonder wachten, daarna één wachtstap', async () => {
    tx.agentChatJob.findUnique.mockResolvedValue(chatRows({ chatId: null }).link)
    claimQueue = Array.from({ length: 8 }, () => [candidateRow()])
    // Geen notificaties: een wachtlus blijft op de poll van 5 s hangen. De herhalingen mogen niet wachten.
    pgClient.on.mockImplementation(() => undefined)

    const result = await handler({ wait_seconds: 1 })

    expect(JSON.parse(toolText(result))).toEqual({ status: 'timeout', message: 'No job available within wait window' })
    // 1 directe poging + 5 herhalingen; daarna één wachtstap, en een zevende poging erna. Dan is de deadline voorbij.
    expect(mockPrisma.claudeJob.updateMany).toHaveBeenCalledTimes(7)
    const waits = pgClient.on.mock.calls.filter(([event]) => event === 'notification')
    expect(waits).toHaveLength(1)
    expect(claimQueue).toHaveLength(1)
  }, 20_000)
})

describe('een AGENT_CHAT-job buiten de scoped_products van het token (ISS-16)', () => {
  it('getFullJobContext gooit AGENT_CHAT_PRODUCT_OUT_OF_SCOPE en bouwt de payload niet', async () => {
    authMocks.getTokenScopedProducts.mockResolvedValue(['prod-andere'])

    await expect(getFullJobContext(JOB_ID, 'HARNESS', OWNER)).rejects.toMatchObject({
      name: 'HarnessJobConfigError',
      reason: expect.stringMatching(/^AGENT_CHAT_PRODUCT_OUT_OF_SCOPE/),
    })

    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(tx.agentChatJob.findUnique).not.toHaveBeenCalled()
    expect(tx.agentChatMessage.findMany).not.toHaveBeenCalled()
  })

  it('de handler zet de job FAILED met die reden en geeft een toolfout zonder payload', async () => {
    authMocks.getTokenScopedProducts.mockResolvedValue(['prod-andere'])
    claimQueue = [[candidateRow()]]

    const result = await handler({ wait_seconds: 1 })

    expect(result.isError).toBe(true)
    expect(toolText(result)).toMatch(/^AGENT_CHAT_PRODUCT_OUT_OF_SCOPE/)
    expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith({
      where: { id: JOB_ID },
      data: expect.objectContaining({ status: 'FAILED', error: expect.stringMatching(/^AGENT_CHAT_PRODUCT_OUT_OF_SCOPE/) }),
    })
    expect(tx.agentChatJob.findUnique).not.toHaveBeenCalled() // geen payload gebouwd
  })

  it.each([
    ['een token zonder scope ([])', []],
    ['een token waarvan de scope het product bevat', ['prod-andere', 'prod-1']],
  ])('%s: de payload komt zoals voorheen', async (_naam, scoped) => {
    authMocks.getTokenScopedProducts.mockResolvedValue(scoped)

    const context = await getFullJobContext(JOB_ID, 'HARNESS', OWNER)

    expect(context).toMatchObject({ kind: 'AGENT_CHAT', job_id: JOB_ID, pending: { message_id: 'pending' } })
    expect(tx.agentChatJob.findUnique).toHaveBeenCalledTimes(1)
  })
})
