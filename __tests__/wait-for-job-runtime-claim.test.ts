import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// De claimfilters hieronder zijn zuivere functies. De tests onderaan (M45-2b: de runtimecontrole direct na de
// claim) draaien getFullJobContext en releaseMismatchedClaim tegen deze mocks: één transactieclient waarvan de
// SQL-aanroepen zichtbaar zijn, en spies op alles wat een worktree of een idee-voorbereiding zou starten.
const tx = vi.hoisted(() => ({ $queryRaw: vi.fn(), $executeRaw: vi.fn(), claudeJob: { findUnique: vi.fn() } }))
const worktreeMocks = vi.hoisted(() => ({ createWorktreeForJob: vi.fn(), removeWorktreeForJob: vi.fn() }))
const cloneMocks = vi.hoisted(() => ({ cloneRepoOnDemand: vi.fn() }))
const jobLockMocks = vi.hoisted(() => ({ setupProductWorktrees: vi.fn(), releaseLocksOnTerminal: vi.fn() }))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    claudeJob: { findUnique: vi.fn(), update: vi.fn() },
    jobKindConfig: { findUnique: vi.fn() },
  },
}))
vi.mock('../src/lib/doc-index.js', () => ({ buildDocIndex: vi.fn().mockResolvedValue(null) }))
vi.mock('../src/git/worktree.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/git/worktree.js')>()),
  ...worktreeMocks,
}))
vi.mock('../src/git/on-demand-clone.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/git/on-demand-clone.js')>()),
  ...cloneMocks,
}))
vi.mock('../src/git/job-locks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/git/job-locks.js')>()),
  ...jobLockMocks,
}))

import { prisma } from '../src/prisma.js'
import { buildDocIndex } from '../src/lib/doc-index.js'
import { RuntimeMismatchError } from '../src/git/on-demand-clone.js'
import {
  buildClaimableJobWhereClause,
  buildClaimableJobWhereFragment,
  getFullJobContext,
  releaseMismatchedClaim,
} from '../src/tools/wait-for-job.js'
import { parseWorkerRuntime, type WorkerRuntime } from '../src/worker-runtime.js'
import { claimConditions, type ClaimJob } from '../src/dispatch/eligibility.js'

const mockPrisma = prisma as unknown as {
  $transaction: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
  claudeJob: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
  jobKindConfig: { findUnique: ReturnType<typeof vi.fn> }
}

function sqlText(fragment: { strings: readonly string[] }): string {
  return fragment.strings.join('')
}

function sqlValues(fragment: { values?: readonly unknown[] }): readonly unknown[] {
  return fragment.values ?? []
}

describe('runtime-aware claim filter', () => {
  it('parses SCRUM4ME_WORKER_RUNTIME case-insensitively and defaults to CLAUDE', () => {
    expect(parseWorkerRuntime('CODEX')).toBe('CODEX')
    expect(parseWorkerRuntime('codex')).toBe('CODEX')
    expect(parseWorkerRuntime(' claude ')).toBe('CLAUDE')
    expect(parseWorkerRuntime('')).toBe('CLAUDE')
    expect(parseWorkerRuntime(undefined)).toBe('CLAUDE')
    // Een onbekende waarde (bv. 'gpt-5') werd hier vroeger stil CLAUDE. Dat is een fout
    // geworden (UNKNOWN_AGENT_RUNTIME, M45-2b); zie __tests__/worker-runtime.test.ts.
  })

  it('filters by runtime', () => {
    expect(buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false })).toContain("cj.runtime = 'CLAUDE'")
  })

  it('builds Claude claim SQL that cannot match CODEX jobs', () => {
    const specSql = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false })
    const productionFragment = buildClaimableJobWhereFragment({
      userId: 'user-1',
      runtime: 'CLAUDE',
      hasProductScope: false,
    })

    expect(specSql).toContain("cj.runtime = 'CLAUDE'")
    expect(specSql).not.toContain("cj.runtime = 'CODEX'")
    expect(sqlText(productionFragment)).toContain('cj.runtime = ')
    expect(sqlValues(productionFragment)).toContain('CLAUDE')
    expect(sqlValues(productionFragment)).not.toContain('CODEX')
  })

  it('builds Codex claim SQL that cannot match CLAUDE jobs', () => {
    const specSql = buildClaimableJobWhereClause({ runtime: 'CODEX', hasProductScope: false })
    const productionFragment = buildClaimableJobWhereFragment({
      userId: 'user-1',
      runtime: 'CODEX',
      hasProductScope: false,
    })

    expect(specSql).toContain("cj.runtime = 'CODEX'")
    expect(specSql).not.toContain("cj.runtime = 'CLAUDE'")
    expect(sqlText(productionFragment)).toContain('cj.runtime = ')
    expect(sqlValues(productionFragment)).toContain('CODEX')
    expect(sqlValues(productionFragment)).not.toContain('CLAUDE')
  })

  // M45-2b (Taak 2, deel 1): HARNESS is een derde runtime met een eigen tak (zie
  // wait-for-job-harness-claim.test.ts). Hier staat de runtime-gelijkheid in beide richtingen.
  it('builds HARNESS claim SQL that cannot match CLAUDE or CODEX jobs', () => {
    const specSql = buildClaimableJobWhereClause({ runtime: 'HARNESS', hasProductScope: false })
    const productionFragment = buildClaimableJobWhereFragment({
      userId: 'user-1',
      runtime: 'HARNESS',
      hasProductScope: false,
    })

    expect(specSql).toContain("cj.runtime = 'HARNESS'")
    expect(specSql).not.toContain("cj.runtime = 'CLAUDE'")
    expect(specSql).not.toContain("cj.runtime = 'CODEX'")
    expect(sqlText(productionFragment)).toContain('cj.runtime = ')
    expect(sqlValues(productionFragment)).toContain('HARNESS')
    expect(sqlValues(productionFragment)).not.toContain('CLAUDE')
    expect(sqlValues(productionFragment)).not.toContain('CODEX')
  })

  it.each(['CLAUDE', 'CODEX'] as const)('builds %s claim SQL that cannot match HARNESS jobs, whatever the capabilities', (runtime) => {
    // Alle capability-takken: leeg, de dedicated workers (deploy, docs_audit) en het generieke pad.
    for (const capabilities of [[], ['deploy'], ['docs_audit'], ['review'], ['code_edit', 'planning']]) {
      for (const hasProductScope of [false, true]) {
        const productionFragment = buildClaimableJobWhereFragment(
          hasProductScope
            ? { userId: 'user-1', productId: 'product-1', runtime, hasProductScope, capabilities }
            : { userId: 'user-1', runtime, hasProductScope, capabilities },
        )
        // De enige gebonden runtime is de eigen runtime; geen HARNESS in waarden of tekst.
        expect(sqlValues(productionFragment)).toContain(runtime)
        expect(sqlValues(productionFragment).flat()).not.toContain('HARNESS')
        expect(sqlText(productionFragment)).not.toContain('HARNESS')
        const specSql = buildClaimableJobWhereClause({ runtime, hasProductScope, capabilities })
        expect(specSql).toContain(`cj.runtime = '${runtime}'`)
        expect(specSql).not.toContain('HARNESS')
      }
    }
  })

  // M45-3: de dedicated claimtak voor exact ['local_llm'] is weg. Zo'n worker valt op het generieke pad (NULL-
  // capability-jobs plus ANY(capabilities)), in alle spiegels: de SQL-string, het Prisma-fragment en het contract
  // predicaat ↔ SQL-conditie. Dit is test a van het M45-3-plan; hij bewijst dat de tak weg is.
  it.each(['CLAUDE', 'CODEX'] as const)('a %s worker with exactly [local_llm] gets the generic path (M45-3)', (runtime) => {
    const capabilities = ['local_llm']
    const specSql = buildClaimableJobWhereClause({ runtime, hasProductScope: false, capabilities })
    const fragment = buildClaimableJobWhereFragment({ userId: 'user-1', runtime, hasProductScope: false, capabilities })

    expect(specSql).toContain('AND (cj.required_capability IS NULL OR cj.required_capability = ANY(${capabilities}::text[]))')
    expect(specSql).not.toContain("cj.required_capability = 'local_llm'")
    expect(sqlText(fragment)).toContain('cj.required_capability IS NULL OR cj.required_capability = ANY(')
    expect(sqlText(fragment)).not.toContain("'local_llm'")

    const executor = {
      userId: 'user-1', productIds: [], runtime, capabilities, managed: false, profileRevisionIds: [], quotaPct: null,
      minQuotaPct: 0,
    }
    const job = (over: Partial<ClaimJob>): ClaimJob => ({
      userId: 'user-1', productId: 'product-1', runtime, status: 'QUEUED', kind: 'IDEA_GRILL', source: 'MANUAL',
      requiredCapability: null, dispatchRequestId: null, profileRevisionId: null, sprintRunId: null, sprintStatus: null,
      earlierSibling: false, taskId: null, ideaId: 'idea-1', ...over,
    })
    // Generiek: een job zonder capability (ook gewoon Claude-werk) en een job met precies die capability.
    expect(claimConditions.capability.evaluate(job({}), executor)).toBe(true)
    expect(claimConditions.capability.evaluate(job({ kind: 'IDEA_CHAT', source: 'SYSTEM' }), executor)).toBe(true)
    expect(claimConditions.capability.evaluate(job({ requiredCapability: 'review' }), executor)).toBe(false)
    expect(sqlText(claimConditions.capability.sql(executor))).toContain('cj.required_capability IS NULL OR cj.required_capability = ANY(')
  })

  it('a worker with the default capabilities claims IDEA_CHAT through the generic NULL/ANY branch', () => {
    const clause = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false, capabilities: ['code_edit', 'planning', 'review'] })
    expect(clause).toContain('cj.required_capability IS NULL OR cj.required_capability = ANY')
    expect(clause).toContain("'IDEA_CHAT'")
  })

  it('allows standalone task jobs through source MANUAL or COPILOT', () => {
    const sql = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false })

    // 2026-07-06: COPILOT single-task dispatch (dispatchTaskImplementation,
    // IDEA-118 §6.3) is door de DB-constraint toegestaan maar bleef eeuwig
    // QUEUED zolang de claim-filter alleen MANUAL toeliet.
    expect(sql).toContain("cj.kind = 'TASK_IMPLEMENTATION' AND cj.source IN ('MANUAL', 'COPILOT')")
    expect(sql).toContain('cj.sprint_run_id IS NOT NULL')
  })

  it('includes IDEA_REVIEW_PLAN in standalone idea jobs', () => {
    const sql = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false })

    expect(sql).toContain('IDEA_REVIEW_PLAN')
  })

  it('includes IDEA_CHAT in standalone idea jobs (M17 idea-chat)', () => {
    const sql = buildClaimableJobWhereClause({ runtime: 'CLAUDE', hasProductScope: false })

    expect(sql).toContain("'IDEA_CHAT'")
  })

  it('allows only PLAN_CHAT orchestrator follow-up jobs for the matching runtime and capability', () => {
    const sql = buildClaimableJobWhereClause({
      runtime: 'CLAUDE',
      hasProductScope: true,
      capabilities: ['review'],
    })

    expect(sql).toContain("cj.source = 'ORCHESTRATOR'")
    expect(sql).toContain("cj.kind = 'PLAN_CHAT'")
    expect(sql).toContain('cj.task_id IS NULL')
    expect(sql).toContain('cj.idea_id IS NULL')
    expect(sql).toContain('cj.sprint_run_id IS NULL')
    expect(sql).toContain('cj.required_capability IS NULL OR cj.required_capability = ANY')
  })

  it('preserves the orchestrator follow-up guard in the production claim fragment', () => {
    const productionSql = sqlText(
      buildClaimableJobWhereFragment({
        userId: 'user-1',
        productId: 'product-1',
        runtime: 'CLAUDE',
        hasProductScope: true,
        capabilities: ['queue_orchestration'],
      }),
    )

    expect(productionSql).toContain("cj.kind = 'PLAN_CHAT'")
    expect(productionSql).toContain("cj.source = 'ORCHESTRATOR'")
    expect(productionSql).toContain('cj.task_id IS NULL')
    expect(productionSql).toContain('cj.idea_id IS NULL')
    expect(productionSql).toContain('cj.sprint_run_id IS NULL')
    expect(productionSql).toContain('cj.required_capability IS NULL OR cj.required_capability = ANY')
  })

  it('keeps the production SQL fragment aligned with the exported spec clause', () => {
    const specSql = buildClaimableJobWhereClause({
      runtime: 'CODEX',
      hasProductScope: true,
      capabilities: ['planning'],
    })
    const productionSql = sqlText(
      buildClaimableJobWhereFragment({
        userId: 'user-1',
        productId: 'product-1',
        runtime: 'CODEX',
        hasProductScope: true,
        capabilities: ['planning'],
      }),
    )

    for (const expected of [
      'cj.product_id = ',
      "cj.kind IN ('IDEA_GRILL', 'IDEA_MAKE_PLAN', 'IDEA_REVIEW_PLAN', 'IDEA_MAKE_SPEC', 'IDEA_REVISE_SPEC', 'IDEA_CHAT', 'PLAN_CHAT', 'PR_REVIEW', 'SPEC_REVIEW', 'TASK_REVIEW')",
      "cj.kind = 'PLAN_CHAT'",
      "cj.source = 'ORCHESTRATOR'",
      "OR (cj.kind = 'TASK_IMPLEMENTATION' AND cj.source IN ('MANUAL', 'COPILOT'))",
      'cj.sprint_run_id IS NOT NULL',
      "sr.status IN ('QUEUED', 'RUNNING')",
      'cj.required_capability IS NULL',
      'cj.required_capability = ANY',
      '::text[]',
    ]) {
      expect(specSql).toContain(expected)
      expect(productionSql).toContain(expected)
    }

    expect(productionSql).toContain('cj.runtime = ')
    expect(productionSql).toContain('::"AgentRuntime"')
  })

  it('requires NULL required_capability when worker has no capabilities', () => {
    const specSql = buildClaimableJobWhereClause({
      runtime: 'CLAUDE',
      hasProductScope: false,
      capabilities: [],
    })
    const productionSql = sqlText(
      buildClaimableJobWhereFragment({
        userId: 'user-1',
        runtime: 'CLAUDE',
        hasProductScope: false,
        capabilities: [],
      }),
    )

    expect(specSql).toContain('cj.required_capability IS NULL')
    expect(specSql).not.toContain('ANY')
    expect(productionSql).toContain('cj.required_capability IS NULL')
    expect(productionSql).not.toContain('ANY')
  })

  it('lets workers with non-planning capabilities match only NULL or listed required capabilities', () => {
    const specSql = buildClaimableJobWhereClause({
      runtime: 'CLAUDE',
      hasProductScope: false,
      capabilities: ['review'],
    })
    const productionFragment = buildClaimableJobWhereFragment({
      userId: 'user-1',
      runtime: 'CLAUDE',
      hasProductScope: false,
      capabilities: ['review'],
    })

    expect(specSql).toContain('cj.required_capability IS NULL OR cj.required_capability = ANY')
    expect(sqlText(productionFragment)).toContain('cj.required_capability IS NULL OR cj.required_capability = ANY')
    expect(sqlValues(productionFragment)).toContainEqual(['review'])
    expect(sqlValues(productionFragment)).not.toContainEqual(['planning'])
  })
})

// ---------------------------------------------------------------------------------------------------------
// M45-2b (Taak 2, deel 2): de runtimecontrole direct na de claim
//
// Wijkt de runtime van de geclaimde job af van die van de worker (alleen mogelijk bij een fout in het
// claimfilter), dan geeft getFullJobContext de claim in één transactie terug en gooit RuntimeMismatchError,
// vóór er een worktree, een idee-voorbereiding of een payload bestaat. Het deel dat alleen een echte database
// kan bewijzen (de tijdstempelvergelijking en de lock) staat in dispatch/harness-claim.integration.test.ts.
// ---------------------------------------------------------------------------------------------------------

const JOB_ID = 'job-runtime-check-1'
const OWNER = { jobId: JOB_ID, instanceId: 'worker-A', tokenId: 'token-A' }
/** De jobrij zoals de teruggave hem onder de lock leest: nog van deze claim. */
const OWNED_ROW = { status: 'CLAIMED', claimed_by_token_id: 'token-A', worker_instance_id: 'worker-A' }

/**
 * Een IDEA_GRILL-job met een idee: zonder de controle zou getFullJobContext de product-worktrees van het idee
 * voorbereiden (setupProductWorktrees), dus dat een test dat niet ziet gebeuren is betekenisvol.
 */
function ideaGrillJob(runtime: WorkerRuntime) {
  return {
    id: JOB_ID,
    kind: 'IDEA_GRILL',
    source: 'SYSTEM',
    status: 'CLAIMED',
    runtime,
    product_id: 'prod-1',
    user_id: 'user-1',
    branch: null,
    requested_model: null,
    requested_thinking_budget: null,
    requested_permission_mode: null,
    created_by_job_id: null,
    orchestration_key: null,
    required_capability: null,
    summary: null,
    task: null,
    sprint_run_id: null,
    pr_url: null,
    doc_id: null,
    manual_drafts: [],
    idea: {
      id: 'idea-1',
      code: 'IDEA-1',
      title: 'Een idee',
      description: 'Beschrijving.',
      grill_md: null,
      plan_md: null,
      status: 'DRAFT',
      product_id: 'prod-1',
      pbi: null,
      secondary_products: [],
      plan_doc: null,
      grill_doc: null,
      spec_doc: null,
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
  }
}

/** De SQL van een tagged-template-aanroep: de statische delen met `?` op de plek van een gebonden waarde. */
function sqlOf(call: readonly unknown[]): string {
  return (call[0] as readonly string[]).join('?').replace(/\s+/g, ' ').trim()
}
const valuesOf = (call: readonly unknown[]) => call.slice(1)

/** Alle SQL-stappen van de transactieclient in de volgorde waarin ze draaiden. */
function txSteps(): Array<{ sql: string; values: unknown[] }> {
  const calls = [
    ...tx.$queryRaw.mock.calls.map((call, i) => ({ order: tx.$queryRaw.mock.invocationCallOrder[i], call })),
    ...tx.$executeRaw.mock.calls.map((call, i) => ({ order: tx.$executeRaw.mock.invocationCallOrder[i], call })),
  ].sort((a, b) => a.order - b.order)
  return calls.map(({ call }) => ({ sql: sqlOf(call), values: valuesOf(call) }))
}

/** Wat claimLog naar stderr schreef, als geparste regels. */
function claimLogLines(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.flatMap(([line]) => {
    try {
      return [JSON.parse(String(line)) as Record<string, unknown>]
    } catch {
      return []
    }
  })
}

const STEP_LOCK = /^SELECT .+ FROM claude_jobs WHERE id = \? FOR UPDATE$/
const STEP_TASK_RESET =
  "UPDATE tasks t SET status = 'TO_DO' FROM claude_jobs cj " +
  "WHERE cj.id = ? AND t.id = cj.task_id AND t.status = 'IN_PROGRESS' AND t.updated_at = cj.claimed_at"
const STEP_JOB_REQUEUE =
  "UPDATE claude_jobs SET status = 'QUEUED', claimed_by_token_id = NULL, claimed_at = NULL, " +
  'plan_snapshot = NULL, worker_instance_id = NULL, lease_until = NULL WHERE id = ?'
// IDEA-243: de jobnotify na de requeue, op de tx-client (vuurt dus bij COMMIT).
const STEP_NOTIFY = 'SELECT pg_notify(?, ?)'
const QUEUED_NOTIFY_ROW = { id: JOB_ID, user_id: 'user-1', product_id: 'prod-1', kind: 'IDEA_GRILL', status: 'QUEUED' }

describe('getFullJobContext — de runtime van de job moet die van de worker zijn (M45-2b)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    tx.$queryRaw.mockResolvedValue([OWNED_ROW])
    tx.$executeRaw.mockResolvedValue(1)
    tx.claudeJob.findUnique.mockResolvedValue(QUEUED_NOTIFY_ROW)
    jobLockMocks.setupProductWorktrees.mockResolvedValue([])
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    errorSpy.mockRestore()
  })

  // [runtime van de worker, runtime van de job]: de twee van het plan, en alle andere combinaties.
  const MISMATCHES = [
    ['HARNESS', 'CLAUDE'],
    ['CLAUDE', 'HARNESS'],
    ['HARNESS', 'CODEX'],
    ['CODEX', 'HARNESS'],
    ['CLAUDE', 'CODEX'],
    ['CODEX', 'CLAUDE'],
  ] as const

  it.each(MISMATCHES)('een %s-worker met een %s-job: RuntimeMismatchError met code en runtimes', async (workerRuntime, jobRuntime) => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaGrillJob(jobRuntime))

    const failure = await getFullJobContext(JOB_ID, workerRuntime, OWNER).then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(RuntimeMismatchError)
    expect(failure).toMatchObject({
      message: `RUNTIME_MISMATCH: job ${JOB_ID} is ${jobRuntime}, worker is ${workerRuntime}`,
      jobId: JOB_ID,
      jobRuntime,
      workerRuntime,
    })
  })

  it.each(MISMATCHES)('een %s-worker met een %s-job: de teruggave is één transactie van lock, taak en job, in die volgorde', async (workerRuntime, jobRuntime) => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaGrillJob(jobRuntime))

    await expect(getFullJobContext(JOB_ID, workerRuntime, OWNER)).rejects.toBeInstanceOf(RuntimeMismatchError)

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    const steps = txSteps()
    expect(steps).toHaveLength(4)
    expect(steps[0].sql).toMatch(STEP_LOCK)
    expect(steps[0].values).toEqual([JOB_ID])
    expect(steps[1]).toEqual({ sql: STEP_TASK_RESET, values: [JOB_ID] })
    expect(steps[2]).toEqual({ sql: STEP_JOB_REQUEUE, values: [JOB_ID] })
    expect(steps[3].sql).toBe(STEP_NOTIFY)
    expect(JSON.parse(steps[3].values[1] as string)).toMatchObject({ type: 'claude_job_status_changed', job_id: JOB_ID, status: 'QUEUED' })
    // Via tx, nooit via de globale prisma (anders vóór COMMIT).
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
  })

  it.each(MISMATCHES)('een %s-worker met een %s-job: er staat niets op schijf en er is niets voorbereid', async (workerRuntime, jobRuntime) => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaGrillJob(jobRuntime))

    await expect(getFullJobContext(JOB_ID, workerRuntime, OWNER)).rejects.toBeInstanceOf(RuntimeMismatchError)

    // Geen worktree, geen clone, geen idee-voorbereiding.
    expect(worktreeMocks.createWorktreeForJob).not.toHaveBeenCalled()
    expect(worktreeMocks.removeWorktreeForJob).not.toHaveBeenCalled()
    expect(cloneMocks.cloneRepoOnDemand).not.toHaveBeenCalled()
    expect(jobLockMocks.setupProductWorktrees).not.toHaveBeenCalled()
    // rollbackClaim (met git-opruiming, buiten de transactie) blijft voor de andere paden en wordt hier niet gebruikt.
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
    expect(mockPrisma.claudeJob.update).not.toHaveBeenCalled()
    // De controle staat vóór elke andere lezing.
    expect(mockPrisma.jobKindConfig.findUnique).not.toHaveBeenCalled()
    expect(buildDocIndex).not.toHaveBeenCalled()
  })

  it.each(MISMATCHES)('een %s-worker met een %s-job: de claimlog noemt runtime_mismatch met job en beide runtimes', async (workerRuntime, jobRuntime) => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaGrillJob(jobRuntime))

    await expect(getFullJobContext(JOB_ID, workerRuntime, OWNER)).rejects.toBeInstanceOf(RuntimeMismatchError)

    const entry = claimLogLines(errorSpy).find((line) => line.event === 'runtime_mismatch')
    expect(entry).toEqual({ scope: 'claim', event: 'runtime_mismatch', jobId: JOB_ID, jobRuntime, workerRuntime })
  })

  // runtime_mismatch is het signaal waarop het plan rekent om een fout in het claimfilter te zien. Faalt de teruggave zelf
  // (een databasefout), dan mag dat signaal niet verloren gaan: de log is geschreven vóór de teruggave begint.
  it.each(MISMATCHES)('een %s-worker met een %s-job: faalt de teruggave, dan staat runtime_mismatch toch in de claimlog en gaat de databasefout omhoog', async (workerRuntime, jobRuntime) => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaGrillJob(jobRuntime))
    const failure = new Error('deadlock detected')
    tx.$executeRaw.mockRejectedValue(failure)

    await expect(getFullJobContext(JOB_ID, workerRuntime, OWNER)).rejects.toBe(failure)

    const entry = claimLogLines(errorSpy).find((line) => line.event === 'runtime_mismatch')
    expect(entry).toEqual({ scope: 'claim', event: 'runtime_mismatch', jobId: JOB_ID, jobRuntime, workerRuntime })
  })

  it('de claimlog wordt geschreven vóór de teruggave begint: eerst runtime_mismatch, dan de transactie', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaGrillJob('CLAUDE'))

    await expect(getFullJobContext(JOB_ID, 'HARNESS', OWNER)).rejects.toBeInstanceOf(RuntimeMismatchError)

    const logCall = errorSpy.mock.calls.findIndex(([line]: unknown[]) => String(line).includes('"event":"runtime_mismatch"'))
    expect(logCall).toBeGreaterThanOrEqual(0)
    expect(errorSpy.mock.invocationCallOrder[logCall]).toBeLessThan(mockPrisma.$transaction.mock.invocationCallOrder[0])
  })

  it.each(['CLAUDE', 'CODEX'] as const)('een %s-worker met een job van dezelfde runtime gaat door: geen teruggave, wel de payload', async (runtime) => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaGrillJob(runtime))

    const context = await getFullJobContext(JOB_ID, runtime, OWNER)

    expect(context).toMatchObject({ job_id: JOB_ID, kind: 'IDEA_GRILL', config: { runtime } })
    expect(jobLockMocks.setupProductWorktrees).toHaveBeenCalledTimes(1)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(claimLogLines(errorSpy).some((line) => line.event === 'runtime_mismatch')).toBe(false)
  })

  it('zonder runtime-argument (geen productie-aanroeper) wordt er niets gecontroleerd of teruggegeven, ook niet met een eigenaar', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaGrillJob('CODEX'))

    // Alleen een aanroep zonder runtime-argument: de effectieve runtime is dan die van de job zelf. Geen enkele
    // productie-aanroeper doet dit nog: wait_for_job en de docker-runner geven de runtime mee.
    const withoutOwner = await getFullJobContext(JOB_ID)
    const withOwner = await getFullJobContext(JOB_ID, undefined, OWNER)

    expect(withoutOwner).toMatchObject({ config: { runtime: 'CODEX' } })
    expect(withOwner).toMatchObject({ config: { runtime: 'CODEX' } })
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(claimLogLines(errorSpy).some((line) => line.event === 'runtime_mismatch')).toBe(false)
  })

  it('zonder eigenaar-identiteit weigert hij de payload ook, maar raakt hij de rij niet aan: er valt niets te bewijzen', async () => {
    mockPrisma.claudeJob.findUnique.mockResolvedValue(ideaGrillJob('CLAUDE'))

    await expect(getFullJobContext(JOB_ID, 'HARNESS')).rejects.toBeInstanceOf(RuntimeMismatchError)
    await expect(getFullJobContext(JOB_ID, 'HARNESS', null)).rejects.toBeInstanceOf(RuntimeMismatchError)

    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(jobLockMocks.setupProductWorktrees).not.toHaveBeenCalled()
  })
})

describe('releaseMismatchedClaim — het eigenaarschap wordt onder de lock gecontroleerd (M45-2b)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    tx.$queryRaw.mockResolvedValue([OWNED_ROW])
    tx.$executeRaw.mockResolvedValue(1)
    tx.claudeJob.findUnique.mockResolvedValue(QUEUED_NOTIFY_ROW)
  })

  const OWNER_IDENTITY = { tokenId: 'token-A', instanceId: 'worker-A' }

  it('geeft de claim terug als de job nog CLAIMED is door dezelfde token en dezelfde instance: lock, taak, job', async () => {
    await releaseMismatchedClaim(JOB_ID, OWNER_IDENTITY)

    const steps = txSteps()
    expect(steps.map((step) => step.sql)).toEqual([expect.stringMatching(STEP_LOCK), STEP_TASK_RESET, STEP_JOB_REQUEUE, STEP_NOTIFY])
    expect(steps.map((step) => step.values.length ? step.values[0] : null).slice(0, 3)).toEqual([JOB_ID, JOB_ID, JOB_ID])
    // De lock komt van een SELECT ... FOR UPDATE in de transactie, niet van een los statement erbuiten.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3)
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
  })

  // Wat de teruggave onder de lock leest, bepaalt of er iets verandert: alleen een claim die nog van déze
  // worker is, wordt teruggegeven. Elk ander geval (lease-verloop en een nieuwe claim, een sweep, een start)
  // laat de rij en de taak met rust.
  it.each([
    ['een andere worker_instance_id', { ...OWNED_ROW, worker_instance_id: 'worker-B' }],
    ['een ander claimed_by_token_id', { ...OWNED_ROW, claimed_by_token_id: 'token-B' }],
    ['status QUEUED (de sweep heeft de claim al teruggegeven)', { status: 'QUEUED', claimed_by_token_id: null, worker_instance_id: null }],
    ['status RUNNING (de claim is al gestart)', { ...OWNED_ROW, status: 'RUNNING' }],
    ['status FAILED', { ...OWNED_ROW, status: 'FAILED' }],
  ])('verandert niets bij %s', async (_titel, row) => {
    tx.$queryRaw.mockResolvedValue([row])

    await releaseMismatchedClaim(JOB_ID, OWNER_IDENTITY)

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tx.$executeRaw).not.toHaveBeenCalled()
  })

  it('verandert niets als de rij niet meer bestaat', async () => {
    tx.$queryRaw.mockResolvedValue([])

    await releaseMismatchedClaim(JOB_ID, OWNER_IDENTITY)

    expect(tx.$executeRaw).not.toHaveBeenCalled()
  })

  it('opent zonder eigenaar-identiteit niet eens een transactie', async () => {
    await releaseMismatchedClaim(JOB_ID, null)

    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('laat een fout van de database door: de aanroeper moet weten dat de claim niet is teruggegeven', async () => {
    const failure = new Error('deadlock detected')
    tx.$executeRaw.mockRejectedValue(failure)

    await expect(releaseMismatchedClaim(JOB_ID, OWNER_IDENTITY)).rejects.toBe(failure)
  })
})
