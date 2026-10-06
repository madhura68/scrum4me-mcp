// M45-2b (Taak 2, deel 2): wat er direct na een claim met een HARNESS-job gebeurt.
//
// 1. getFullJobContext leest voor een HARNESS-job het plafond uit de productkeuze (readHarnessChoice, zonder .catch)
//    en geeft de resolveruitkomst als `config` in de payload van IDEA_CHAT en TASK_IMPLEMENTATION: de keuze '0.2000'
//    wordt '0.2', zonder rij geldt de standaard van de jobsoort, en een leesfout geeft nooit de standaard.
//    Onbruikbare configuratie (plafond 0, geen requested_model, een soort die HARNESS niet draait, een onbekende
//    runtime) wordt HarnessJobConfigError, een TerminalJobError met de code als reden.
// 2. De handler claimt op twee plekken: meteen, en na het wachten (LISTEN en poll). Beide roepen
//    getFullJobContext(jobId, runtime, ownerCtx) aan en vertalen de fouten ervan, en beide moeten dat op dezelfde
//    manier doen. Daarom draait elk handlergeval over beide claimpaden:
//    - RuntimeMismatchError wordt toolError('RUNTIME_MISMATCH'); de claim is dan al teruggegeven en de job blijft
//      QUEUED (de job wordt dus niet op FAILED gezet en er wordt geen worktree gemaakt);
//    - HarnessJobConfigError zet de job op FAILED met de code en geeft toolError(<code>), niet de repotekst van
//      de TerminalJobError-tak waar hij een subklasse van is;
//    - een leesfout op de keuze zet de job niet op FAILED en geeft de fout door.
// De handler draait hier echt (tryClaimJob, resetStaleClaimedJobs, getFullJobContext en de teruggave); alleen de
// database, de LISTEN-verbinding en git zijn nagebootst. De SQL zelf bewijst dispatch/harness-claim.integration.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { toolText } from '../helpers/tool-result.js'
import type { WorkerRuntime } from '../../src/worker-runtime.js'

const authMocks = vi.hoisted(() => ({ requireWriteAccess: vi.fn() }))
const tx = vi.hoisted(() => ({ $queryRaw: vi.fn(), $executeRaw: vi.fn() }))
const pgClient = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))
const worktreeMocks = vi.hoisted(() => ({ createWorktreeForJob: vi.fn(), removeWorktreeForJob: vi.fn() }))

vi.mock('../../src/auth.js', async () => ({
  ...(await vi.importActual<typeof import('../../src/auth.js')>('../../src/auth.js')),
  requireWriteAccess: authMocks.requireWriteAccess,
}))
vi.mock('pg', () => ({ Client: vi.fn(function Client() { return pgClient }) }))
vi.mock('../../src/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    claudeJob: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    jobKindConfig: { findUnique: vi.fn() },
    productHarnessChoice: { findUnique: vi.fn() },
    ideaChatMessage: { findMany: vi.fn() },
    claudeQuestion: { findMany: vi.fn() },
  },
}))
vi.mock('../../src/lib/doc-index.js', () => ({ buildDocIndex: vi.fn().mockResolvedValue(null) }))
// De echte resolver, als spy: alleen de test voor "een andere fout dan de vier codes" laat hem eenmalig anders gooien.
vi.mock('@shared/job-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/job-config.js')>()
  return { ...actual, resolveRuntimeJobConfig: vi.fn(actual.resolveRuntimeJobConfig) }
})
vi.mock('../../src/git/worktree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/git/worktree.js')>()),
  ...worktreeMocks,
}))

import { resolveRuntimeJobConfig } from '@shared/job-config.js'
import { prisma } from '../../src/prisma.js'
import { HarnessJobConfigError, TerminalJobError } from '../../src/git/on-demand-clone.js'
import { getFullJobContext, registerWaitForJobTool } from '../../src/tools/wait-for-job.js'

const mockResolve = resolveRuntimeJobConfig as unknown as ReturnType<typeof vi.fn>
const mockPrisma = prisma as unknown as {
  $queryRaw: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
  $transaction: ReturnType<typeof vi.fn>
  claudeJob: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  jobKindConfig: { findUnique: ReturnType<typeof vi.fn> }
  productHarnessChoice: { findUnique: ReturnType<typeof vi.fn> }
  ideaChatMessage: { findMany: ReturnType<typeof vi.fn> }
  claudeQuestion: { findMany: ReturnType<typeof vi.fn> }
}

const USER_ID = 'user-1'
const TOKEN_ID = 'token-A'
const INSTANCE_ID = 'worker-A'
const JOB_ID = 'job-after-claim-0001'
const OWNER = { jobId: JOB_ID, instanceId: INSTANCE_ID, tokenId: TOKEN_ID }
/** De jobrij zoals de teruggave hem onder de lock leest: nog van de claim van deze worker. */
const OWNED_ROW = { status: 'CLAIMED', claimed_by_token_id: TOKEN_ID, worker_instance_id: INSTANCE_ID }

type Handler = (input: { wait_seconds: number }) => Promise<CallToolResult>
let handler: Handler

/** De kandidaten die tryClaimJob achtereenvolgens ziet: [] is "geen job", een rij is de te claimen job. */
let claimQueue: Array<Array<Record<string, unknown>>>

function candidateRow(kind: string) {
  return { id: JOB_ID, implementation_plan: 'plan', sprint_run_id: null, kind, idea_id: null }
}

const sqlText = (strings: readonly string[]) => strings.join('?')

// ---------------------------------------------------------------------------------------------------------
// Jobs: een volledige taak-job, zodat de handler zonder de controle naar de worktree zou doorlopen
// ---------------------------------------------------------------------------------------------------------

function taskJob(runtime: WorkerRuntime, overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    kind: 'TASK_IMPLEMENTATION',
    source: 'COPILOT',
    status: 'CLAIMED',
    runtime,
    user_id: USER_ID,
    product_id: 'prod-1',
    requested_model: runtime === 'HARNESS' ? 'gsq-lokaal' : null,
    requested_thinking_budget: null,
    requested_permission_mode: null,
    required_capability: null,
    sprint_run_id: null,
    branch: null,
    manual_drafts: [],
    idea: null,
    task: {
      id: 'task-1',
      title: 'Een taak',
      description: null,
      implementation_plan: 'plan',
      priority: 2,
      repo_url: null,
      requires_opus: false,
      story: {
        id: 'story-1',
        title: 'Een story',
        description: null,
        acceptance_criteria: 'klaar',
        pbi: { id: 'pbi-1', title: 'Een PBI', priority: 2, status: 'READY' },
        sprint: null,
      },
    },
    product: {
      id: 'prod-1',
      name: 'Scrum4Me',
      repo_url: 'https://git.example/scrum4me.git',
      definition_of_done: 'Tests groen.',
      preferred_model: null,
      thinking_budget_default: null,
      preferred_permission_mode: null,
    },
    ...overrides,
  }
}

/** Een idee-chat-job: de soort waarvan de payload geen worktree nodig heeft, dus de handler geeft hem als JSON terug. */
function ideaChatJob(runtime: WorkerRuntime, overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    kind: 'IDEA_CHAT',
    source: 'SYSTEM',
    status: 'CLAIMED',
    runtime,
    user_id: USER_ID,
    product_id: 'prod-1',
    created_at: new Date('2026-07-03T10:00:00.000Z'),
    chat_cutoff_message_id: 'msg1',
    chat_cutoff_at: new Date('2026-07-03T09:59:00.000Z'),
    requested_model: runtime === 'HARNESS' ? 'gsq-lokaal' : null,
    requested_thinking_budget: null,
    requested_permission_mode: null,
    required_capability: null,
    task: null,
    sprint_run_id: null,
    manual_drafts: [],
    idea: {
      id: 'idea-1',
      code: 'IDEA-134',
      title: 'Idea chat channel',
      description: 'Chat per idee.',
      grill_md: 'Grill notes',
      plan_md: null,
      status: 'DRAFT',
      product_id: 'prod-1',
      pbi: null,
      secondary_products: [],
      plan_doc: null,
      grill_doc: null,
      user_questions: [],
    },
    product: {
      id: 'prod-1',
      name: 'Scrum4Me',
      repo_url: 'https://git.example/scrum4me.git',
      definition_of_done: 'Tests groen.',
      preferred_model: null,
      thinking_budget_default: null,
      preferred_permission_mode: null,
    },
    ...overrides,
  }
}

/** Een bestaande, niet-HARNESS foutsoort: een TASK_REVIEW zonder task_id is structureel onherstelbaar (TerminalJobError). */
function brokenTaskReviewJob() {
  return {
    ...ideaChatJob('CLAUDE'),
    kind: 'TASK_REVIEW',
    source: 'SYSTEM',
    idea: null,
    task: null,
    task_id: null,
    pr_url: null,
    doc_id: null,
  }
}

/** De rij uit product_harness_choices zoals Prisma hem geeft: het plafond is een Decimal. */
function choiceRow(maxCostUsd: string, configuration = 'gsq-lokaal') {
  return { configuration, max_cost_usd: new Prisma.Decimal(maxCostUsd) }
}

const HARNESS_CONFIG = { runtime: 'HARNESS', model: 'gsq-lokaal' }

// ---------------------------------------------------------------------------------------------------------
// De handler met nagebootste database en LISTEN-verbinding
// ---------------------------------------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('SCRUM4ME_WORKER_INSTANCE_ID', INSTANCE_ID)
  authMocks.requireWriteAccess.mockResolvedValue({ userId: USER_ID, tokenId: TOKEN_ID, username: 'jan', isDemo: false })

  claimQueue = []
  mockPrisma.$queryRaw.mockResolvedValue([])
  mockPrisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
  tx.$queryRaw.mockImplementation(async (strings: readonly string[]) => {
    const sql = sqlText(strings)
    if (sql.includes('SKIP LOCKED')) return claimQueue.shift() ?? [] // tryClaimJob: de kandidaat
    if (sql.includes('RETURNING id, task_id')) return [] // resetStaleClaimedJobs: de requeue
    if (sql.includes('FOR UPDATE')) return [OWNED_ROW] // releaseMismatchedClaim: de rij onder de lock
    throw new Error(`onverwachte tx.$queryRaw: ${sql}`)
  })
  tx.$executeRaw.mockResolvedValue(1)

  // De LISTEN-verbinding: de eerste luisteraar voor 'notification' krijgt meteen een passende melding, zodat
  // het wachten niet de pollinterval (5 s) uitzit.
  pgClient.connect.mockResolvedValue(undefined)
  pgClient.query.mockResolvedValue({ rows: [] })
  pgClient.end.mockResolvedValue(undefined)
  pgClient.on.mockImplementation((event: string, listener: (message: { payload?: string }) => void) => {
    if (event === 'notification') {
      queueMicrotask(() => listener({ payload: JSON.stringify({ type: 'claude_job_enqueued', user_id: USER_ID }) }))
    }
  })

  mockPrisma.claudeJob.findFirst.mockResolvedValue(null)
  mockPrisma.claudeJob.update.mockResolvedValue({})
  mockPrisma.jobKindConfig.findUnique.mockResolvedValue(null)
  mockPrisma.productHarnessChoice.findUnique.mockResolvedValue(null)
  mockPrisma.ideaChatMessage.findMany.mockResolvedValue([])
  mockPrisma.claudeQuestion.findMany.mockResolvedValue([])

  const server = { registerTool: vi.fn((_name: string, _meta: unknown, fn: Handler) => { handler = fn }) }
  registerWaitForJobTool(server as unknown as McpServer)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------------------------------------
// getFullJobContext: het plafond van een HARNESS-job
// ---------------------------------------------------------------------------------------------------------

const HARNESS_KINDS = [
  ['IDEA_CHAT', () => ideaChatJob('HARNESS'), '0.05'],
  ['TASK_IMPLEMENTATION', () => taskJob('HARNESS'), '0.50'],
] as const

describe('getFullJobContext — het plafond van een HARNESS-job komt uit de productkeuze', () => {
  it.each(HARNESS_KINDS)('%s met een keuze van 0.2000: config is { HARNESS, <naam>, "0.2" }', async (kind, job) => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(job())
    mockPrisma.productHarnessChoice.findUnique.mockResolvedValue(choiceRow('0.2000'))

    const context = await getFullJobContext(JOB_ID, 'HARNESS', OWNER)

    expect(context).toMatchObject({ kind, config: { ...HARNESS_CONFIG, max_cost_usd: '0.2' } })
    // Precies de drie sleutels van de HARNESS-config: geen Claude- of Codex-velden.
    expect(Object.keys((context as { config: object }).config).sort()).toEqual(['max_cost_usd', 'model', 'runtime'])
    expect(mockPrisma.productHarnessChoice.findUnique).toHaveBeenCalledTimes(1)
    expect(mockPrisma.productHarnessChoice.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { product_id_kind: { product_id: 'prod-1', kind } } }),
    )
  })

  it.each(HARNESS_KINDS)('%s zonder rij: de standaard van de soort', async (kind, job, defaultCost) => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(job())
    mockPrisma.productHarnessChoice.findUnique.mockResolvedValue(null)

    const context = await getFullJobContext(JOB_ID, 'HARNESS', OWNER)

    expect(context).toMatchObject({ kind, config: { ...HARNESS_CONFIG, max_cost_usd: defaultCost } })
  })

  it('de configuratienaam komt uit de job (de snapshot van de enqueue), niet uit de huidige keuze', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaChatJob('HARNESS', { requested_model: 'gsq-lokaal' }))
    mockPrisma.productHarnessChoice.findUnique.mockResolvedValue(choiceRow('0.3000', 'een-andere-naam'))

    const context = await getFullJobContext(JOB_ID, 'HARNESS', OWNER)

    expect(context).toMatchObject({ config: { runtime: 'HARNESS', model: 'gsq-lokaal', max_cost_usd: '0.3' } })
  })

  it('een leesfout op de keuze geeft geen standaard: de fout gaat omhoog en er is geen payload', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaChatJob('HARNESS'))
    const failure = new Error('connection terminated unexpectedly')
    mockPrisma.productHarnessChoice.findUnique.mockRejectedValue(failure)

    await expect(getFullJobContext(JOB_ID, 'HARNESS', OWNER)).rejects.toBe(failure)
  })

  it.each(['CLAUDE', 'CODEX'] as const)('een %s-job leest de keuze niet en houdt zijn eigen config', async (runtime) => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaChatJob(runtime))

    const context = await getFullJobContext(JOB_ID, runtime, OWNER)

    expect(mockPrisma.productHarnessChoice.findUnique).not.toHaveBeenCalled()
    const config = (context as { config: Record<string, unknown> }).config
    expect(config.runtime).toBe(runtime)
    expect(config).not.toHaveProperty('max_cost_usd')
  })

  it('zonder runtime-argument (het docker-pad) geldt de runtime van de job: een HARNESS-job leest de keuze', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaChatJob('HARNESS'))
    mockPrisma.productHarnessChoice.findUnique.mockResolvedValue(choiceRow('0.0700'))

    const context = await getFullJobContext(JOB_ID)

    expect(context).toMatchObject({ config: { ...HARNESS_CONFIG, max_cost_usd: '0.07' } })
  })
})

// ---------------------------------------------------------------------------------------------------------
// getFullJobContext: onbruikbare configuratie is terminaal
// ---------------------------------------------------------------------------------------------------------

describe('getFullJobContext — onbruikbare HARNESS-configuratie wordt een HarnessJobConfigError', () => {
  /** [wat er mis is, de job, de rij van de keuze, de code van de resolver] */
  const BROKEN = [
    ['een plafond van 0', () => ideaChatJob('HARNESS'), () => choiceRow('0'), 'HARNESS_COST_LIMIT_INVALID'],
    ['een job zonder requested_model', () => ideaChatJob('HARNESS', { requested_model: null }), () => null, 'HARNESS_CONFIGURATION_INVALID'],
    ['een ongeldige configuratienaam', () => ideaChatJob('HARNESS', { requested_model: 'GSQ Lokaal!' }), () => null, 'HARNESS_CONFIGURATION_INVALID'],
    ['een jobsoort die HARNESS niet draait', () => ({ ...ideaChatJob('HARNESS'), kind: 'IDEA_GRILL', source: 'COPILOT' }), () => null, 'HARNESS_KIND_UNSUPPORTED'],
  ] as const

  it.each(BROKEN)('%s: HarnessJobConfigError met de code als reden, een TerminalJobError', async (_titel, job, row, code) => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(job())
    mockPrisma.productHarnessChoice.findUnique.mockResolvedValue(row())

    const failure = await getFullJobContext(JOB_ID, 'HARNESS', OWNER).then(() => undefined, (err: unknown) => err)

    expect(failure).toBeInstanceOf(HarnessJobConfigError)
    expect(failure).toBeInstanceOf(TerminalJobError)
    expect(failure).toMatchObject({ name: 'HarnessJobConfigError', reason: code, message: code })
  })

  it('een plafond van 0 geeft nooit de standaard van de soort', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaChatJob('HARNESS'))
    mockPrisma.productHarnessChoice.findUnique.mockResolvedValue(choiceRow('0'))

    await expect(getFullJobContext(JOB_ID, 'HARNESS', OWNER)).rejects.toMatchObject({ reason: 'HARNESS_COST_LIMIT_INVALID' })
  })

  it('een soort die HARNESS niet draait leest de keuze niet eens', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue({ ...ideaChatJob('HARNESS'), kind: 'IDEA_GRILL', source: 'COPILOT' })

    await expect(getFullJobContext(JOB_ID, 'HARNESS', OWNER)).rejects.toMatchObject({ reason: 'HARNESS_KIND_UNSUPPORTED' })
    expect(mockPrisma.productHarnessChoice.findUnique).not.toHaveBeenCalled()
  })

  it('een onbekende runtime (UNKNOWN_AGENT_RUNTIME van de resolver) is ook terminaal', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaChatJob('CLAUDE', { runtime: 'GPT5' }))

    const failure = await getFullJobContext(JOB_ID, 'GPT5' as unknown as WorkerRuntime, OWNER).then(() => undefined, (err: unknown) => err)

    expect(failure).toBeInstanceOf(HarnessJobConfigError)
    expect(failure).toMatchObject({ reason: 'UNKNOWN_AGENT_RUNTIME' })
  })

  it('een andere fout van de resolver dan de vier codes wordt niet stil terminaal: ze gaat ongewijzigd omhoog', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaChatJob('CLAUDE'))
    const unexpected = new Error('DISPATCH_JOB_CONFIG_UNSAFE')
    mockResolve.mockImplementationOnce(() => {
      throw unexpected
    })

    await expect(getFullJobContext(JOB_ID, 'CLAUDE', OWNER)).rejects.toBe(unexpected)
  })
})

describe('HarnessJobConfigError', () => {
  it('is een TerminalJobError met de code als reden en als melding', () => {
    const error = new HarnessJobConfigError('HARNESS_COST_LIMIT_INVALID')

    expect(error).toBeInstanceOf(TerminalJobError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('HarnessJobConfigError')
    expect(error.reason).toBe('HARNESS_COST_LIMIT_INVALID')
    expect(error.message).toBe('HARNESS_COST_LIMIT_INVALID')
  })
})

// ---------------------------------------------------------------------------------------------------------
// Beide claimpaden
// ---------------------------------------------------------------------------------------------------------

/**
 * 'direct': tryClaimJob vindt de job meteen (stap 2 van de handler).
 * 'wait': er is eerst niets, en de job komt binnen terwijl de handler wacht (stap 3, LISTEN en poll).
 */
type ClaimPath = 'direct' | 'wait'
const CLAIM_PATHS: ReadonlyArray<[string, ClaimPath]> = [
  ['de directe claim', 'direct'],
  ['de claim na het wachten', 'wait'],
]

/** Laat de worker (runtime uit de omgeving) de job claimen via het gekozen pad en geeft de uitkomst van de handler. */
async function claimThrough(path: ClaimPath, workerRuntime: WorkerRuntime, job: Record<string, unknown>) {
  vi.stubEnv('SCRUM4ME_WORKER_RUNTIME', workerRuntime)
  mockPrisma.claudeJob.findUnique.mockResolvedValue(job)
  claimQueue = path === 'wait' ? [[], [candidateRow(String(job.kind))]] : [[candidateRow(String(job.kind))]]
  const result = await handler({ wait_seconds: 1 })
  // Het wachtpad moet echt over de LISTEN-verbinding zijn gelopen, het directe pad niet.
  expect(pgClient.connect).toHaveBeenCalledTimes(path === 'wait' ? 1 : 0)
  return result
}

describe.each(CLAIM_PATHS)('wait_for_job — %s', (_naam, path) => {
  describe('een claim met de verkeerde runtime', () => {
    // [runtime van de worker, runtime van de job]
    it.each([
      ['HARNESS', 'CLAUDE'],
      ['CLAUDE', 'HARNESS'],
    ] as const)('een %s-worker met een %s-job geeft toolError RUNTIME_MISMATCH', async (workerRuntime, jobRuntime) => {
      const result = await claimThrough(path, workerRuntime, taskJob(jobRuntime))

      expect(result.isError).toBe(true)
      expect(toolText(result)).toBe('RUNTIME_MISMATCH')
    })

    it.each([
      ['HARNESS', 'CLAUDE'],
      ['CLAUDE', 'HARNESS'],
    ] as const)('een %s-worker met een %s-job: de claim wordt teruggegeven, niet afgekeurd, en er komt geen worktree', async (workerRuntime, jobRuntime) => {
      await claimThrough(path, workerRuntime, taskJob(jobRuntime))

      // Teruggegeven met de eigenaar van deze claim: de lock-select, de taakreset en de requeue, in één transactie.
      const releaseCalls = tx.$queryRaw.mock.calls.filter(([strings]) => !sqlText(strings).includes('SKIP LOCKED') && sqlText(strings).includes('FOR UPDATE'))
      expect(releaseCalls).toHaveLength(1)
      expect(releaseCalls[0].slice(1)).toEqual([JOB_ID])
      const writes = tx.$executeRaw.mock.calls.map(([strings]) => sqlText(strings).replace(/\s+/g, ' ').trim())
      expect(writes.filter((sql) => sql.startsWith("UPDATE tasks t SET status = 'TO_DO'"))).toHaveLength(1)
      expect(writes.filter((sql) => sql.startsWith("UPDATE claude_jobs SET status = 'QUEUED'"))).toHaveLength(1)
      // De job staat weer klaar voor de juiste worker: hij wordt niet op FAILED gezet en rollbackClaim loopt niet.
      expect(mockPrisma.claudeJob.update).not.toHaveBeenCalled()
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
      // En de payload van de verkeerde job bereikt de worker nooit: geen worktree.
      expect(worktreeMocks.createWorktreeForJob).not.toHaveBeenCalled()
    })
  })

  describe('de payload van een HARNESS-job', () => {
    it('bevat het plafond van de productkeuze in config, en de claim blijft staan', async () => {
      mockPrisma.productHarnessChoice.findUnique.mockResolvedValue(choiceRow('0.2000'))

      const result = await claimThrough(path, 'HARNESS', ideaChatJob('HARNESS'))

      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({
        job_id: JOB_ID,
        kind: 'IDEA_CHAT',
        config: { runtime: 'HARNESS', model: 'gsq-lokaal', max_cost_usd: '0.2' },
        prompt_text: '',
      })
      expect(mockPrisma.claudeJob.update).not.toHaveBeenCalled()
      expect(tx.$executeRaw.mock.calls.some(([strings]) => sqlText(strings).includes("status = 'QUEUED'"))).toBe(false)
    })

    it('krijgt zonder keuze het standaardplafond van de soort', async () => {
      mockPrisma.productHarnessChoice.findUnique.mockResolvedValue(null)

      const result = await claimThrough(path, 'HARNESS', ideaChatJob('HARNESS'))

      expect(result.structuredContent).toMatchObject({ config: { runtime: 'HARNESS', model: 'gsq-lokaal', max_cost_usd: '0.05' } })
    })
  })

  describe('onbruikbare HARNESS-configuratie is terminaal', () => {
    // [wat er mis is, de job, de rij van de keuze, de code]
    const BROKEN = [
      ['een plafond van 0', () => ideaChatJob('HARNESS'), () => choiceRow('0'), 'HARNESS_COST_LIMIT_INVALID'],
      ['een job zonder requested_model', () => ideaChatJob('HARNESS', { requested_model: null }), () => null, 'HARNESS_CONFIGURATION_INVALID'],
      ['een jobsoort die HARNESS niet draait', () => ({ ...ideaChatJob('HARNESS'), kind: 'IDEA_GRILL', source: 'COPILOT' }), () => null, 'HARNESS_KIND_UNSUPPORTED'],
    ] as const

    it.each(BROKEN)('%s: de job wordt FAILED met de code en de handler geeft de kale code', async (_titel, job, row, code) => {
      mockPrisma.productHarnessChoice.findUnique.mockResolvedValue(row())

      const result = await claimThrough(path, 'HARNESS', job())

      expect(result.isError).toBe(true)
      // De kale code, niet de repotekst van de TerminalJobError-tak (HarnessJobConfigError is er een subklasse van).
      expect(toolText(result)).toBe(code)
      expect(mockPrisma.claudeJob.update).toHaveBeenCalledTimes(1)
      expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith({
        where: { id: JOB_ID },
        data: { status: 'FAILED', finished_at: expect.any(Date), error: code },
      })
      // Terminaal, dus niet teruggegeven: geen rollback en geen requeue.
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
      expect(tx.$executeRaw.mock.calls.some(([strings]) => sqlText(strings).includes("status = 'QUEUED'"))).toBe(false)
    })
  })

  describe('een leesfout op de productkeuze', () => {
    it('geeft geen standaard en laat de job staan: de fout gaat naar de aanroeper en de job wordt niet FAILED', async () => {
      mockPrisma.productHarnessChoice.findUnique.mockRejectedValue(new Error('connection terminated unexpectedly'))

      const result = await claimThrough(path, 'HARNESS', ideaChatJob('HARNESS'))

      expect(result.isError).toBe(true)
      expect(toolText(result)).toBe('connection terminated unexpectedly')
      expect(result.structuredContent).toBeUndefined()
      expect(mockPrisma.claudeJob.update).not.toHaveBeenCalled()
    })
  })

  describe('een gewone TerminalJobError', () => {
    it('houdt de bestaande afhandeling: de job wordt FAILED met de repotekst', async () => {
      const result = await claimThrough(path, 'CLAUDE', brokenTaskReviewJob())

      expect(result.isError).toBe(true)
      expect(toolText(result)).toBe(`Job failed (unresolvable repo): TASK_REVIEW job ${JOB_ID} heeft geen task_id`)
      expect(mockPrisma.claudeJob.update).toHaveBeenCalledWith({
        where: { id: JOB_ID },
        data: { status: 'FAILED', finished_at: expect.any(Date), error: `TASK_REVIEW job ${JOB_ID} heeft geen task_id` },
      })
    })
  })
})
