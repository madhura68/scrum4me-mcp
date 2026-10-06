// M45-2b (Taak 2, deel 2): wat wait_for_job doet direct na een claim.
//
// De handler claimt op twee plekken: meteen, en na het wachten (LISTEN en poll). Beide roepen
// getFullJobContext(jobId, runtime, ownerCtx) aan en vertalen de fouten ervan, en beide moeten dat op dezelfde
// manier doen. Daarom draait elk geval hieronder over beide claimpaden:
//   - RuntimeMismatchError wordt toolError('RUNTIME_MISMATCH'); de claim is dan al teruggegeven en de job blijft
//     QUEUED (de job wordt dus niet op FAILED gezet en er wordt geen worktree gemaakt).
// De handler draait hier echt (tryClaimJob, resetStaleClaimedJobs, getFullJobContext en de teruggave); alleen de
// database, de LISTEN-verbinding en git zijn nagebootst. De SQL zelf bewijst dispatch/harness-claim.integration.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    ideaChatMessage: { findMany: vi.fn() },
    claudeQuestion: { findMany: vi.fn() },
  },
}))
vi.mock('../../src/lib/doc-index.js', () => ({ buildDocIndex: vi.fn().mockResolvedValue(null) }))
vi.mock('../../src/git/worktree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/git/worktree.js')>()),
  ...worktreeMocks,
}))

import { prisma } from '../../src/prisma.js'
import { registerWaitForJobTool } from '../../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  $queryRaw: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
  $transaction: ReturnType<typeof vi.fn>
  claudeJob: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  jobKindConfig: { findUnique: ReturnType<typeof vi.fn> }
  ideaChatMessage: { findMany: ReturnType<typeof vi.fn> }
  claudeQuestion: { findMany: ReturnType<typeof vi.fn> }
}

const USER_ID = 'user-1'
const TOKEN_ID = 'token-A'
const INSTANCE_ID = 'worker-A'
const JOB_ID = 'job-after-claim-0001'
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
  mockPrisma.ideaChatMessage.findMany.mockResolvedValue([])
  mockPrisma.claudeQuestion.findMany.mockResolvedValue([])

  const server = { registerTool: vi.fn((_name: string, _meta: unknown, fn: Handler) => { handler = fn }) }
  registerWaitForJobTool(server as unknown as McpServer)
})

afterEach(() => {
  vi.unstubAllEnvs()
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
})
