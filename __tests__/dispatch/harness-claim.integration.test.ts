// M45-2b (Taak 2, deel 1): het claimfilter met de HARNESS-tak tegen een echte Postgres, in beide richtingen.
//
// Eén tabel met QUEUED-jobs van drie runtimes. Een worker met runtime HARNESS claimt alleen HARNESS-jobs van twee
// soorten (idee-chat SYSTEM en een losse taak COPILOT), een Claude-worker nooit een HARNESS-job, een Codex-worker
// alleen de Codex-job. Daarnaast: het
// tier-fragment met een HARNESS-worker als zichzelf en de idee-job-precheck, die geen harness-workers meetelt.
//
// Het deel na de claim (M45-2b, Taak 2 deel 2) staat onderaan:
// - een claim waarvan de job een andere runtime heeft dan de worker wordt door getFullJobContext in één transactie
//   teruggegeven (releaseMismatchedClaim): de job weer QUEUED met lege claimvelden, de taak alleen terug op TO_DO
//   als déze claim hem promoveerde, en niets als de worker de job intussen kwijt is. Dat laatste bewijst een
//   tweede verbinding die de jobrij vergrendelt;
// - het plafond van een HARNESS-job komt uit product_harness_choices: de Decimal(10,4) uit de echte database wordt
//   een korte decimale string, en zonder rij geldt de standaard van de soort.
//
// Opzet voor aanvullingen: `makeWorld()` zet per test een wegwerp-gebruiker, -product en -token neer (de
// harness-seed) en geeft de hulpfuncties `insertJob`, `insertWorker`, `insertIdea`, `insertTask` en
// `insertSprintRun` hun context; `dropWorld()` ruimt alles op wat zij aanmaakten. Er is geen toestand buiten
// `world`, dus een volgend describe-blok kan zonder voorbereiding dezelfde hulpfuncties gebruiken. `holder.db` is
// de PrismaClient van de web-rol (scrum4me_web_runtime): de MCP draait met die rol, en de gemockte
// `src/prisma.js` geeft hem aan tryClaimJob, dispatchIdeaJob, getFullJobContext en releaseMismatchedClaim.
//
// Het deel van M45-2b Taak 4 staat helemaal onderaan: de enqueue-paden (losse taak en idee-chat) lezen de productkeuze
// en maken een HARNESS-job die de claim van een HARNESS-worker vindt, en `update_job_status` schrijft de kostenrij
// in dezelfde echte transactie als de statusupdate (beide paden, en de vervolgjob van een idee-chat). De gemockte
// `src/auth.js` geeft de seed-gebruiker en -token (`holder.actor`) aan de tools.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { makeDispatchHarness, type DispatchHarness } from './harness.js'
import { buildClaimableJobWhereFragment } from '../../src/dispatch/eligibility.js'
import type { WorkerRuntime } from '../../src/worker-runtime.js'

const holder = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  actor: null as unknown as { userId: string; tokenId: string },
}))
vi.mock('../../src/prisma.js', () => ({ get prisma() { return holder.db } }))
vi.mock('../../src/auth.js', async (original) => ({
  ...(await original<typeof import('../../src/auth.js')>()),
  requireWriteAccess: async () => holder.actor,
}))

import { getFullJobContext, releaseMismatchedClaim, tryClaimJob } from '../../src/tools/wait-for-job.js'
import { RuntimeMismatchError } from '../../src/git/on-demand-clone.js'
import { dispatchIdeaJob } from '../../src/lib/dispatch/idea-jobs.js'
import { dispatchTaskImplementation } from '../../src/lib/dispatch/task-implementation.js'
import { registerSendIdeaChatMessageTool } from '../../src/tools/send-idea-chat-message.js'
import { registerUpdateJobStatusTool } from '../../src/tools/update-job-status.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------------------------------------
// Hulpfuncties: een wegwerpwereld per test
// ---------------------------------------------------------------------------------------------------------

interface World {
  h: DispatchHarness
  userId: string
  tokenId: string
  productId: string
  /** Wat deze wereld buiten de harness-seed aanmaakte; dropWorld() ruimt het op. */
  ideaIds: string[]
  sprintIds: string[]
  sprintRunIds: string[]
  sequence: number
}

async function makeWorld(): Promise<World> {
  const h = await makeDispatchHarness()
  const seed = await h.seed()
  holder.db = new PrismaClient({ adapter: new PrismaPg(h.web) })
  holder.actor = { userId: seed.actor.userId, tokenId: seed.actor.tokenId! }
  return {
    h,
    userId: seed.actor.userId,
    tokenId: seed.actor.tokenId!,
    productId: seed.input.product_id,
    ideaIds: [],
    sprintIds: [],
    sprintRunIds: [],
    sequence: 0,
  }
}

async function dropWorld(world: World | undefined): Promise<void> {
  if (!world) return
  try {
    await holder.db?.$disconnect()
    const client = await world.h.admin.connect()
    try {
      await client.query('BEGIN')
      // Zoals de reset van de harness: zonder FK-acties, dus elke tabel expliciet en kinderen eerst.
      await client.query("SET LOCAL session_replication_role = 'replica'")
      await client.query(
        'DELETE FROM job_cost_reports WHERE job_id IN (SELECT id FROM claude_jobs WHERE product_id = $1)', [world.productId],
      )
      await client.query('DELETE FROM product_harness_choices WHERE product_id = $1', [world.productId])
      await client.query('DELETE FROM idea_logs WHERE idea_id = ANY($1::text[])', [world.ideaIds])
      await client.query('DELETE FROM idea_chat_messages WHERE idea_id = ANY($1::text[])', [world.ideaIds])
      await client.query('DELETE FROM claude_jobs WHERE product_id = $1', [world.productId])
      await client.query('DELETE FROM ideas WHERE id = ANY($1::text[])', [world.ideaIds])
      await client.query('DELETE FROM sprint_runs WHERE id = ANY($1::text[])', [world.sprintRunIds])
      await client.query('DELETE FROM sprints WHERE id = ANY($1::text[])', [world.sprintIds])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  } finally {
    await world.h.close()
  }
}

async function insertIdea(world: World, status = 'DRAFT'): Promise<string> {
  const id = randomUUID()
  await world.h.admin.query(
    `INSERT INTO ideas(id, user_id, product_id, code, title, status, updated_at)
     VALUES($1, $2, $3, $4, 'Harness-claim', $5, now())`,
    [id, world.userId, world.productId, `IDEA-${++world.sequence}`, status],
  )
  world.ideaIds.push(id)
  return id
}

/** Een taak met PBI en story erboven (de harness ruimt ze per product op). */
async function insertTask(world: World): Promise<string> {
  const n = ++world.sequence
  const pbi = randomUUID(), story = randomUUID(), task = randomUUID()
  await world.h.admin.query(
    "INSERT INTO pbis(id, product_id, code, title, priority, sort_order, updated_at) VALUES($1, $2, $3, 'PBI', 1, 1, now())",
    [pbi, world.productId, `PBI-${n}`],
  )
  await world.h.admin.query(
    "INSERT INTO stories(id, pbi_id, product_id, code, title, acceptance_criteria, priority, sort_order, updated_at) VALUES($1, $2, $3, $4, 'Story', 'accepted', 1, 1, now())",
    [story, pbi, world.productId, `ST-${n}`],
  )
  await world.h.admin.query(
    "INSERT INTO tasks(id, story_id, product_id, code, title, implementation_plan, priority, sort_order, updated_at) VALUES($1, $2, $3, $4, 'Task', 'plan', 1, 1, now())",
    [task, story, world.productId, `T-${n}`],
  )
  return task
}

async function insertSprintRun(world: World): Promise<string> {
  const sprintId = randomUUID(), runId = randomUUID()
  await world.h.admin.query(
    "INSERT INTO sprints(id, product_id, code, sprint_goal) VALUES($1, $2, $3, 'Harness-claim')",
    [sprintId, world.productId, `SP-${++world.sequence}`],
  )
  await world.h.admin.query(
    "INSERT INTO sprint_runs(id, sprint_id, started_by_id, pr_strategy, updated_at) VALUES($1, $2, $3, 'SPRINT', now())",
    [runId, sprintId, world.userId],
  )
  world.sprintIds.push(sprintId)
  world.sprintRunIds.push(runId)
  return runId
}

interface JobSpec {
  runtime: WorkerRuntime
  kind: string
  source: string
  /** Een nieuw idee of een nieuwe taak aan de job koppelen (de CHECK-constraint van claude_jobs eist dat per soort). */
  idea?: boolean
  task?: boolean
  sprintRunId?: string
  requiredCapability?: string
  /** De configuratienaam van een HARNESS-job (de snapshot van de enqueue). */
  requestedModel?: string
  status?: string
  /** Hoe lang geleden de job is aangemaakt; oudere jobs worden eerder geclaimd. */
  ageSeconds?: number
}

async function insertJob(world: World, spec: JobSpec): Promise<string> {
  const id = randomUUID()
  const ideaId = spec.idea ? await insertIdea(world) : null
  const taskId = spec.task ? await insertTask(world) : null
  await world.h.admin.query(
    `INSERT INTO claude_jobs(id, user_id, product_id, idea_id, task_id, sprint_run_id, kind, source, status, runtime,
                             required_capability, requested_model, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $13, now() - ($12::int * interval '1 second'), now())`,
    [
      id, world.userId, world.productId, ideaId, taskId, spec.sprintRunId ?? null, spec.kind, spec.source,
      spec.status ?? 'QUEUED', spec.runtime, spec.requiredCapability ?? null, spec.ageSeconds ?? 0,
      spec.requestedModel ?? null,
    ],
  )
  return id
}

interface WorkerSpec {
  runtime: WorkerRuntime
  capabilities?: string[]
  /** De tier van de worker; een harness-worker heeft er geen. */
  capability?: 'HIGH_P' | 'MEDIUM_P' | 'LOW_P'
  instanceId?: string
  /** Hoe lang geleden de worker voor het laatst gezien is; vers is korter dan 15 seconden. */
  ageSeconds?: number
}

async function insertWorker(world: World, spec: WorkerSpec): Promise<string> {
  const instanceId = spec.instanceId ?? `harness-test:${randomUUID()}`
  await world.h.admin.query(
    `INSERT INTO claude_workers(id, user_id, token_id, instance_id, runtime, capabilities, capability, last_seen_at)
     VALUES($1, $2, $3, $4, $5, $6::text[], $7, now() - ($8::int * interval '1 second'))`,
    [
      randomUUID(), world.userId, world.tokenId, instanceId, spec.runtime, spec.capabilities ?? [],
      spec.capability ?? null, spec.ageSeconds ?? 0,
    ],
  )
  return instanceId
}

async function statusOf(world: World, jobId: string) {
  const { rows } = await world.h.admin.query<{ status: string; claimed_by_token_id: string | null; worker_instance_id: string | null }>(
    'SELECT status, claimed_by_token_id, worker_instance_id FROM claude_jobs WHERE id = $1', [jobId],
  )
  return rows[0]
}

// ---------------------------------------------------------------------------------------------------------
// De tabel met jobs van drie runtimes
// ---------------------------------------------------------------------------------------------------------

interface MixedTable {
  /** De twee jobs die een HARNESS-worker mag claimen, oudste eerst. */
  harnessChat: string
  harnessTask: string
  /** HARNESS-jobs die hij niet mag claimen: sprint-run, required_capability, bron MANUAL, andere soort. */
  harnessSprintTask: string
  harnessWithCapability: string
  harnessManualTask: string
  harnessGrill: string
  claudeChat: string
  codexGrill: string
}

/** QUEUED-jobs met runtime HARNESS (idee-chat SYSTEM, losse taak COPILOT, taak met sprint-run, en drie die nergens bij horen), CLAUDE (idee-chat) en CODEX. */
async function seedMixedTable(world: World): Promise<MixedTable> {
  const sprintRunId = await insertSprintRun(world)
  return {
    harnessChat: await insertJob(world, { runtime: 'HARNESS', kind: 'IDEA_CHAT', source: 'SYSTEM', idea: true, ageSeconds: 90 }),
    harnessTask: await insertJob(world, { runtime: 'HARNESS', kind: 'TASK_IMPLEMENTATION', source: 'COPILOT', task: true, ageSeconds: 80 }),
    harnessSprintTask: await insertJob(world, { runtime: 'HARNESS', kind: 'TASK_IMPLEMENTATION', source: 'COPILOT', task: true, sprintRunId, ageSeconds: 70 }),
    harnessWithCapability: await insertJob(world, { runtime: 'HARNESS', kind: 'TASK_IMPLEMENTATION', source: 'COPILOT', task: true, requiredCapability: 'review', ageSeconds: 60 }),
    harnessManualTask: await insertJob(world, { runtime: 'HARNESS', kind: 'TASK_IMPLEMENTATION', source: 'MANUAL', ageSeconds: 50 }),
    harnessGrill: await insertJob(world, { runtime: 'HARNESS', kind: 'IDEA_GRILL', source: 'COPILOT', idea: true, ageSeconds: 40 }),
    claudeChat: await insertJob(world, { runtime: 'CLAUDE', kind: 'IDEA_CHAT', source: 'SYSTEM', idea: true, ageSeconds: 30 }),
    codexGrill: await insertJob(world, { runtime: 'CODEX', kind: 'IDEA_GRILL', source: 'COPILOT', idea: true, ageSeconds: 10 }),
  }
}

interface Poller {
  runtime: WorkerRuntime
  capabilities?: string[]
  /** Met productscope: alleen jobs van dit product. */
  productId?: string
}

/**
 * Wat de claim-query van een poller ziet: dezelfde FROM-joins en hetzelfde WHERE-fragment als tryClaimJob,
 * maar zonder LIMIT en claim, zodat een test de hele verzameling kan vergelijken.
 */
async function visibleTo(world: World, poller: Poller): Promise<string[]> {
  const where = poller.productId
    ? buildClaimableJobWhereFragment({ userId: world.userId, productId: poller.productId, hasProductScope: true, runtime: poller.runtime, capabilities: poller.capabilities })
    : buildClaimableJobWhereFragment({ userId: world.userId, hasProductScope: false, runtime: poller.runtime, capabilities: poller.capabilities })
  const query = Prisma.sql`
    SELECT cj.id FROM claude_jobs cj
    LEFT JOIN tasks t ON t.id = cj.task_id
    LEFT JOIN sprint_runs sr ON sr.id = cj.sprint_run_id
    ${where}`
  const { rows } = await world.h.web.query<{ id: string }>(query.text, query.values)
  return rows.map((row) => row.id).sort()
}
const sorted = (...ids: string[]) => [...ids].sort()

let world: World
beforeEach(async () => { world = await makeWorld() })
afterEach(async () => {
  // Nooit twee keer opruimen: een mislukte makeWorld() laat hier anders de wereld van de vorige test staan.
  const finished = world
  world = undefined as unknown as World
  await dropWorld(finished)
})

// ---------------------------------------------------------------------------------------------------------
// Het claimfilter in beide richtingen
// ---------------------------------------------------------------------------------------------------------

describe('claimfilter: HARNESS-, Claude- en Codex-jobs in één tabel', () => {
  let table: MixedTable
  beforeEach(async () => { table = await seedMixedTable(world) })

  it('een HARNESS-worker ziet precies de idee-chat en de losse taak', async () => {
    expect(await visibleTo(world, { runtime: 'HARNESS' })).toEqual(sorted(table.harnessChat, table.harnessTask))
  })

  it.each([[['deploy']], [['docs_audit']], [['code_edit', 'review']]])(
    'de capabilities %j van de harness-worker tellen niet mee: de runtime wint',
    async (capabilities) => {
      expect(await visibleTo(world, { runtime: 'HARNESS', capabilities })).toEqual(sorted(table.harnessChat, table.harnessTask))
    },
  )

  it('een HARNESS-worker met productscope ziet dezelfde twee, en bij een ander product niets', async () => {
    expect(await visibleTo(world, { runtime: 'HARNESS', productId: world.productId })).toEqual(sorted(table.harnessChat, table.harnessTask))
    expect(await visibleTo(world, { runtime: 'HARNESS', productId: randomUUID() })).toEqual([])
  })

  it('een Claude-worker ziet nooit een HARNESS-job, wat zijn capabilities ook zijn', async () => {
    const harnessJobs = [
      table.harnessChat, table.harnessTask, table.harnessSprintTask,
      table.harnessWithCapability, table.harnessManualTask, table.harnessGrill,
    ]
    for (const capabilities of [[], ['code_edit', 'planning', 'review'], ['review'], ['deploy'], ['docs_audit']]) {
      const seen = await visibleTo(world, { runtime: 'CLAUDE', capabilities })
      for (const id of harnessJobs) expect(seen).not.toContain(id)
    }
    expect(await visibleTo(world, { runtime: 'CLAUDE' })).toEqual([table.claudeChat])
    expect(await visibleTo(world, { runtime: 'CLAUDE', capabilities: ['code_edit', 'planning', 'review'] })).toEqual([table.claudeChat])
  })

  it('een Codex-worker ziet alleen de Codex-job', async () => {
    expect(await visibleTo(world, { runtime: 'CODEX' })).toEqual([table.codexGrill])
    expect(await visibleTo(world, { runtime: 'CODEX', capabilities: ['review'] })).toEqual([table.codexGrill])
    expect(await visibleTo(world, { runtime: 'CODEX', capabilities: ['deploy'] })).toEqual([])
  })

  it('geen enkele worker ziet de HARNESS-jobs die er niet bij horen: sprint-run, required_capability, bron MANUAL en een andere soort', async () => {
    const strays = [table.harnessSprintTask, table.harnessWithCapability, table.harnessManualTask, table.harnessGrill]
    for (const poller of [
      { runtime: 'HARNESS' as const },
      { runtime: 'HARNESS' as const, capabilities: ['review'] },
      { runtime: 'CLAUDE' as const },
      { runtime: 'CLAUDE' as const, capabilities: ['review'] },
      { runtime: 'CODEX' as const },
    ]) {
      const seen = await visibleTo(world, poller)
      for (const id of strays) expect(seen).not.toContain(id)
    }
  })
})

describe('tryClaimJob tegen de echte database', () => {
  let table: MixedTable
  beforeEach(async () => { table = await seedMixedTable(world) })

  it('een HARNESS-worker claimt de twee toegestane jobs, oudste eerst, en daarna niets meer', async () => {
    const claim = () => tryClaimJob(world.userId, world.tokenId, 'harness-1', undefined, 'HARNESS', [], null)
    expect([await claim(), await claim(), await claim()]).toEqual([table.harnessChat, table.harnessTask, null])

    for (const id of [table.harnessChat, table.harnessTask]) {
      expect(await statusOf(world, id)).toEqual({ status: 'CLAIMED', claimed_by_token_id: world.tokenId, worker_instance_id: 'harness-1' })
    }
    // Al het andere blijft staan: de andere HARNESS-jobs en de jobs van de andere runtimes.
    for (const id of [
      table.harnessSprintTask, table.harnessWithCapability, table.harnessManualTask, table.harnessGrill,
      table.claudeChat, table.codexGrill,
    ]) {
      expect((await statusOf(world, id)).status).toBe('QUEUED')
    }
  })

  it('een HARNESS-worker met capabilities [review] claimt hetzelfde: de runtime wint', async () => {
    const claim = () => tryClaimJob(world.userId, world.tokenId, 'harness-2', undefined, 'HARNESS', ['review'], null)
    expect([await claim(), await claim(), await claim()]).toEqual([table.harnessChat, table.harnessTask, null])
  })

  it('een Claude-worker claimt zijn eigen idee-chat en daarna niets, ook al staan er HARNESS-jobs klaar', async () => {
    const claim = () => tryClaimJob(world.userId, world.tokenId, 'claude-1', undefined, 'CLAUDE', [], null)
    expect([await claim(), await claim()]).toEqual([table.claudeChat, null])
    expect((await statusOf(world, table.harnessChat)).status).toBe('QUEUED')
    expect((await statusOf(world, table.harnessTask)).status).toBe('QUEUED')
  })

  it('een Codex-worker claimt alleen de Codex-job', async () => {
    expect(await tryClaimJob(world.userId, world.tokenId, 'codex-1', undefined, 'CODEX', [], null)).toBe(table.codexGrill)
    expect(await tryClaimJob(world.userId, world.tokenId, 'codex-1', undefined, 'CODEX', [], null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------
// Het tier-fragment (C): een HARNESS-worker als zichzelf telt alleen HARNESS-peers
// ---------------------------------------------------------------------------------------------------------

describe('tier-fragment met een HARNESS-worker als zichzelf', () => {
  let table: MixedTable
  beforeEach(async () => { table = await seedMixedTable(world) })

  it('een hogere-tier Claude-peer defereert een HARNESS-worker niet', async () => {
    await insertWorker(world, { runtime: 'CLAUDE', capability: 'HIGH_P' })
    expect(await tryClaimJob(world.userId, world.tokenId, 'harness-low', undefined, 'HARNESS', [], 'LOW_P')).toBe(table.harnessChat)
  })

  it('een hogere-tier HARNESS-peer defereert hem wel: de job blijft voor die peer staan', async () => {
    await insertWorker(world, { runtime: 'HARNESS', capability: 'HIGH_P' })
    expect(await tryClaimJob(world.userId, world.tokenId, 'harness-low', undefined, 'HARNESS', [], 'LOW_P')).toBeNull()
    expect((await statusOf(world, table.harnessChat)).status).toBe('QUEUED')
  })

  it('een hogere-tier HARNESS-peer defereert een Claude-worker niet: de runtimes tellen elkaar niet mee', async () => {
    await insertWorker(world, { runtime: 'HARNESS', capability: 'HIGH_P' })
    expect(await tryClaimJob(world.userId, world.tokenId, 'claude-low', undefined, 'CLAUDE', [], 'LOW_P')).toBe(table.claudeChat)
  })
})

// ---------------------------------------------------------------------------------------------------------
// De idee-job-precheck: een harness-worker claimt IDEA_GRILL, IDEA_MAKE_PLAN en IDEA_MAKE_SPEC nooit
// ---------------------------------------------------------------------------------------------------------

describe('idee-job-precheck tegen de echte database', () => {
  const STATUS_FOR = { IDEA_GRILL: 'DRAFT', IDEA_MAKE_PLAN: 'GRILLED', IDEA_MAKE_SPEC: 'GRILLED' } as const
  const KINDS = ['IDEA_GRILL', 'IDEA_MAKE_PLAN', 'IDEA_MAKE_SPEC'] as const

  beforeEach(async () => {
    // De harness-seed zet een verse Codex-worker neer; deze tests beginnen zonder enige worker.
    await world.h.admin.query('DELETE FROM claude_workers WHERE user_id = $1', [world.userId])
    await world.h.admin.query("UPDATE products SET repo_url = 'https://forge.test/repo.git' WHERE id = $1", [world.productId])
  })

  async function jobsOf(ideaId: string) {
    return (await world.h.admin.query<{ kind: string; status: string }>('SELECT kind, status FROM claude_jobs WHERE idea_id = $1', [ideaId])).rows
  }

  it.each(KINDS)('%s: een verse HARNESS-worker telt niet mee, een verse Claude-worker wel', async (kind) => {
    const ideaId = await insertIdea(world, STATUS_FOR[kind])
    const dispatch = () => dispatchIdeaJob({ kind, ideaId, productId: world.productId, userId: world.userId })

    await insertWorker(world, { runtime: 'HARNESS' })
    await expect(dispatch()).rejects.toThrow(/Geen actieve worker/)
    expect(await jobsOf(ideaId)).toEqual([])

    await insertWorker(world, { runtime: 'CLAUDE' })
    await expect(dispatch()).resolves.toEqual({ job_id: expect.any(String) })
    expect(await jobsOf(ideaId)).toEqual([{ kind, status: 'QUEUED' }])
  })

  it('een verse Codex-worker blijft meetellen: alleen HARNESS valt af', async () => {
    const ideaId = await insertIdea(world, 'DRAFT')
    await insertWorker(world, { runtime: 'CODEX' })
    await expect(
      dispatchIdeaJob({ kind: 'IDEA_GRILL', ideaId, productId: world.productId, userId: world.userId }),
    ).resolves.toEqual({ job_id: expect.any(String) })
  })

  it('een verlopen Claude-worker met een verse HARNESS-worker ernaast telt niet: de versheid blijft gelden', async () => {
    const ideaId = await insertIdea(world, 'DRAFT')
    await insertWorker(world, { runtime: 'HARNESS' })
    await insertWorker(world, { runtime: 'CLAUDE', ageSeconds: 120 })
    await expect(
      dispatchIdeaJob({ kind: 'IDEA_GRILL', ideaId, productId: world.productId, userId: world.userId }),
    ).rejects.toThrow(/Geen actieve worker/)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Na de claim: een claim met de verkeerde runtime wordt in één transactie teruggegeven (RUNTIME_MISMATCH)
// ---------------------------------------------------------------------------------------------------------

describe('teruggave van een claim bij RUNTIME_MISMATCH tegen de echte database', () => {
  const WORKER_A = 'worker-A'

  const ownerOf = (jobId: string, instanceId = WORKER_A, tokenId = world.tokenId) => ({ jobId, instanceId, tokenId })

  /** Een taak-job die een worker echt claimt: de trigger claude_job_claim_to_task promoveert de taak dan naar IN_PROGRESS. */
  async function claimTaskJob(spec: { runtime: WorkerRuntime; instanceId?: string; tokenId?: string; taskStatus?: string }) {
    const jobId = await insertJob(world, { runtime: spec.runtime, kind: 'TASK_IMPLEMENTATION', source: 'COPILOT', task: true })
    const { rows } = await world.h.admin.query<{ task_id: string }>('SELECT task_id FROM claude_jobs WHERE id = $1', [jobId])
    const taskId = rows[0].task_id
    // Een taak die al onderweg was vóór de claim: de trigger promoveert alleen een taak die nog TO_DO is.
    if (spec.taskStatus) await world.h.admin.query('UPDATE tasks SET status = $2 WHERE id = $1', [taskId, spec.taskStatus])
    expect(await tryClaimJob(world.userId, spec.tokenId ?? world.tokenId, spec.instanceId ?? WORKER_A, undefined, spec.runtime, [], null)).toBe(jobId)
    return { jobId, taskId }
  }

  /** De claimvelden van de job en de taakstatus; `stamped_by_claim` is wat de teruggave in SQL vergelijkt (updated_at = claimed_at). */
  async function stateOf(jobId: string, taskId: string | null) {
    const job = (await world.h.admin.query(
      `SELECT status::text AS status, claimed_by_token_id, claimed_at, plan_snapshot, worker_instance_id, lease_until
       FROM claude_jobs WHERE id = $1`, [jobId],
    )).rows[0]
    const task = taskId
      ? (await world.h.admin.query(
          `SELECT t.status::text AS status, (t.updated_at = cj.claimed_at) AS stamped_by_claim
           FROM tasks t, claude_jobs cj WHERE t.id = $1 AND cj.id = $2`, [taskId, jobId],
        )).rows[0]
      : null
    return { job, task }
  }

  const EMPTY_CLAIM = {
    status: 'QUEUED', claimed_by_token_id: null, claimed_at: null, plan_snapshot: null, worker_instance_id: null, lease_until: null,
  }

  // [runtime van de job, runtime van de worker die hem kreeg]
  it.each([
    ['CLAUDE', 'HARNESS'],
    ['HARNESS', 'CLAUDE'],
  ] as const)('een %s-job die een %s-worker kreeg: job weer QUEUED met lege claimvelden, taak weer TO_DO', async (jobRuntime, workerRuntime) => {
    const { jobId, taskId } = await claimTaskJob({ runtime: jobRuntime })
    const claimed = await stateOf(jobId, taskId)
    expect(claimed.job).toMatchObject({ status: 'CLAIMED', claimed_by_token_id: world.tokenId, worker_instance_id: WORKER_A, plan_snapshot: 'plan' })
    expect(claimed.job.claimed_at).not.toBeNull()
    expect(claimed.job.lease_until).not.toBeNull()
    // De voorwaarde van de teruggave: de trigger promoveerde de taak in dezelfde transactie als de claim.
    expect(claimed.task).toEqual({ status: 'IN_PROGRESS', stamped_by_claim: true })

    await expect(getFullJobContext(jobId, workerRuntime, ownerOf(jobId))).rejects.toBeInstanceOf(RuntimeMismatchError)

    const released = await stateOf(jobId, taskId)
    expect(released.job).toEqual(EMPTY_CLAIM)
    expect(released.task!.status).toBe('TO_DO')
  })

  it('na de teruggave claimt de juiste worker de job opnieuw, en de taak gaat weer naar IN_PROGRESS', async () => {
    const { jobId, taskId } = await claimTaskJob({ runtime: 'CLAUDE' })
    await expect(getFullJobContext(jobId, 'HARNESS', ownerOf(jobId))).rejects.toBeInstanceOf(RuntimeMismatchError)

    expect(await tryClaimJob(world.userId, world.tokenId, 'worker-C', undefined, 'CLAUDE', [], null)).toBe(jobId)

    const reclaimed = await stateOf(jobId, taskId)
    expect(reclaimed.job).toMatchObject({ status: 'CLAIMED', claimed_by_token_id: world.tokenId, worker_instance_id: 'worker-C' })
    expect(reclaimed.task).toEqual({ status: 'IN_PROGRESS', stamped_by_claim: true })
  })

  it('een taak die vóór de claim al IN_PROGRESS was, blijft staan: de claim stempelde haar updated_at niet', async () => {
    const { jobId, taskId } = await claimTaskJob({ runtime: 'CLAUDE', taskStatus: 'IN_PROGRESS' })
    expect((await stateOf(jobId, taskId)).task).toEqual({ status: 'IN_PROGRESS', stamped_by_claim: false })

    await expect(getFullJobContext(jobId, 'HARNESS', ownerOf(jobId))).rejects.toBeInstanceOf(RuntimeMismatchError)

    const released = await stateOf(jobId, taskId)
    expect(released.job).toEqual(EMPTY_CLAIM)
    expect(released.task!.status).toBe('IN_PROGRESS')
  })

  it('een job zonder taak (idee-chat) gaat ook terug naar QUEUED', async () => {
    const jobId = await insertJob(world, { runtime: 'HARNESS', kind: 'IDEA_CHAT', source: 'SYSTEM', idea: true })
    expect(await tryClaimJob(world.userId, world.tokenId, WORKER_A, undefined, 'HARNESS', [], null)).toBe(jobId)

    await expect(getFullJobContext(jobId, 'CLAUDE', ownerOf(jobId))).rejects.toBeInstanceOf(RuntimeMismatchError)

    expect((await stateOf(jobId, null)).job).toEqual(EMPTY_CLAIM)
  })

  // De claim is van een andere worker (lease-verloop en een nieuwe claim): dan is de job niet meer van A en
  // verandert de teruggave van A niets, ook niet aan de taak.
  describe('verandert niets als de worker de job niet meer heeft', () => {
    async function secondToken(): Promise<string> {
      const id = randomUUID()
      await world.h.admin.query(
        "INSERT INTO api_tokens(id, user_id, token_hash, kind, scoped_products) VALUES($1, $2, $3, 'IMPLEMENTATION', $4::text[])",
        [id, world.userId, randomUUID(), [world.productId]],
      )
      world.h.trackToken(id)
      return id
    }

    it('een andere worker_instance_id (dezelfde token)', async () => {
      const { jobId, taskId } = await claimTaskJob({ runtime: 'CLAUDE', instanceId: 'worker-B' })
      const before = await stateOf(jobId, taskId)

      await releaseMismatchedClaim(jobId, { tokenId: world.tokenId, instanceId: WORKER_A })

      expect(await stateOf(jobId, taskId)).toEqual(before)
      expect(before.job).toMatchObject({ status: 'CLAIMED', worker_instance_id: 'worker-B' })
      expect(before.task!.status).toBe('IN_PROGRESS')
    })

    it('een andere token (dezelfde worker_instance_id)', async () => {
      const otherToken = await secondToken()
      const { jobId, taskId } = await claimTaskJob({ runtime: 'CLAUDE', tokenId: otherToken })
      const before = await stateOf(jobId, taskId)

      await releaseMismatchedClaim(jobId, { tokenId: world.tokenId, instanceId: WORKER_A })

      expect(await stateOf(jobId, taskId)).toEqual(before)
      expect(before.job).toMatchObject({ status: 'CLAIMED', claimed_by_token_id: otherToken })
      expect(before.task!.status).toBe('IN_PROGRESS')
    })

    it('een job die al QUEUED is (de sweep gaf de claim al terug): de taak blijft zoals ze is', async () => {
      const { jobId, taskId } = await claimTaskJob({ runtime: 'CLAUDE' })
      await world.h.admin.query(
        `UPDATE claude_jobs SET status = 'QUEUED', claimed_by_token_id = NULL, claimed_at = NULL, plan_snapshot = NULL,
                                worker_instance_id = NULL, lease_until = NULL WHERE id = $1`, [jobId],
      )
      const before = await stateOf(jobId, taskId)

      await releaseMismatchedClaim(jobId, { tokenId: world.tokenId, instanceId: WORKER_A })

      expect(await stateOf(jobId, taskId)).toEqual(before)
      expect(before.task!.status).toBe('IN_PROGRESS')
    })
  })

  // ---------------------------------------------------------------------------------------------------------
  // Concurrentie: het eigenaarschap wordt onder de lock gecontroleerd
  //
  // Verbinding B vergrendelt de jobrij en zet de job op een nieuwe eigenaar (zoals een lease-verloop gevolgd door
  // een nieuwe claim). Dan start A's teruggave. B commit pas als de database laat zien dat A op B's lock wacht.
  // Daarna verandert A niets: de job blijft van B en de taak blijft IN_PROGRESS.
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Wacht tot de database meldt dat een sessie door `blockerPid` wordt tegengehouden in een statement dat aan `statement`
   * voldoet (pg_blocking_pids), en geeft de wachtende rijen terug. Faalt na de deadline: dan wacht A niet op B.
   * Dit is een poll op de toestand van de database, geen slaap in de hoop dat A inmiddels wacht.
   */
  async function waitUntilBlockedBy(blockerPid: number, statement: RegExp, deadlineMs = 5_000) {
    const deadline = Date.now() + deadlineMs
    let blocked: Array<{ pid: number; wait_event_type: string | null; query: string }> = []
    while (Date.now() < deadline) {
      blocked = (await world.h.admin.query(
        'SELECT pid, wait_event_type, query FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [blockerPid],
      )).rows
      const waiting = blocked.filter((row) => statement.test(row.query))
      if (waiting.length > 0) return waiting
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(
      `A wacht niet op de lock van B in een statement dat ${statement} bevat; ` +
      `sessies die door B worden tegengehouden: ${JSON.stringify(blocked.map((row) => ({ wait_event_type: row.wait_event_type, query: row.query.replace(/\s+/g, ' ').slice(0, 80) })))}`,
    )
  }

  it('A wacht op de lock van B en verandert daarna niets: de job blijft van B en de taak IN_PROGRESS', async () => {
    const { jobId, taskId } = await claimTaskJob({ runtime: 'CLAUDE', instanceId: WORKER_A })
    const b = await world.h.admin.connect()
    let releasing: Promise<void> | undefined
    let bFinished = false
    try {
      await b.query('BEGIN')
      const pidOfB = Number((await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await b.query('SELECT 1 FROM claude_jobs WHERE id = $1 FOR UPDATE', [jobId])
      await b.query(
        "UPDATE claude_jobs SET worker_instance_id = 'worker-B', claimed_at = now(), lease_until = now() + interval '5 minutes' WHERE id = $1",
        [jobId],
      )

      // A start zijn teruggave: de SELECT ... FOR UPDATE moet op B wachten.
      releasing = releaseMismatchedClaim(jobId, { tokenId: world.tokenId, instanceId: WORKER_A })
      releasing.catch(() => undefined) // een fout komt na de commit van B uit `await releasing`; geen losse rejection ondertussen
      const waiting = await waitUntilBlockedBy(pidOfB, /FOR UPDATE/i)
      expect(waiting.map((row) => row.wait_event_type)).toEqual(['Lock'])

      await b.query('COMMIT')
      bFinished = true
      await releasing // A krijgt de lock nu en rondt af
    } finally {
      // Wat er ook misgaat: B laat zijn locks los en A rondt af, zodat de opruiming niet blijft hangen.
      if (!bFinished) await b.query('ROLLBACK').catch(() => undefined)
      b.release()
      await releasing?.catch(() => undefined)
    }

    const after = await stateOf(jobId, taskId)
    expect(after.job).toMatchObject({ status: 'CLAIMED', claimed_by_token_id: world.tokenId, worker_instance_id: 'worker-B' })
    expect(after.job.claimed_at).not.toBeNull()
    expect(after.job.plan_snapshot).toBe('plan')
    expect(after.task!.status).toBe('IN_PROGRESS')
  })
})

// ---------------------------------------------------------------------------------------------------------
// Na de claim: het plafond van een HARNESS-job komt uit de productkeuze
// ---------------------------------------------------------------------------------------------------------

describe('plafond van een HARNESS-job tegen de echte database', () => {
  const INSTANCE = 'harness-ceiling'
  type HarnessKind = 'IDEA_CHAT' | 'TASK_IMPLEMENTATION'

  /** Een HARNESS-job die een HARNESS-worker echt claimt, met de configuratienaam van de enqueue als requested_model. */
  async function claimHarnessJob(kind: HarnessKind): Promise<string> {
    const jobId = await insertJob(
      world,
      kind === 'IDEA_CHAT'
        ? { runtime: 'HARNESS', kind, source: 'SYSTEM', idea: true, requestedModel: 'gsq-lokaal' }
        : { runtime: 'HARNESS', kind, source: 'COPILOT', task: true, requestedModel: 'gsq-lokaal' },
    )
    expect(await tryClaimJob(world.userId, world.tokenId, INSTANCE, undefined, 'HARNESS', [], null)).toBe(jobId)
    return jobId
  }

  /** De keuze van het product voor een jobsoort, zoals de ops-UI haar zou zetten (Decimal(10,4), updated_at zonder default). */
  async function chooseCeiling(kind: HarnessKind, maxCostUsd: string, configuration = 'gsq-lokaal') {
    await world.h.admin.query(
      'INSERT INTO product_harness_choices(product_id, kind, configuration, max_cost_usd, updated_at) VALUES($1, $2, $3, $4::numeric, now())',
      [world.productId, kind, configuration, maxCostUsd],
    )
  }

  const contextOf = async (jobId: string) =>
    (await getFullJobContext(jobId, 'HARNESS', { jobId, instanceId: INSTANCE, tokenId: world.tokenId })) as { kind: string; config: unknown }

  it.each([
    ['IDEA_CHAT', '0.05'],
    ['TASK_IMPLEMENTATION', '0.50'],
  ] as const)('%s zonder keuze krijgt het standaardplafond %s', async (kind, defaultCost) => {
    const jobId = await claimHarnessJob(kind)

    const context = await contextOf(jobId)

    expect(context).toMatchObject({ kind, config: { runtime: 'HARNESS', model: 'gsq-lokaal', max_cost_usd: defaultCost } })
  })

  // De Decimal(10,4) uit de database ('0.2000') is een Prisma-Decimal; de MCP geeft de gewone korte string door.
  it.each([
    ['IDEA_CHAT', '0.2000', '0.2'],
    ['TASK_IMPLEMENTATION', '1.2500', '1.25'],
    ['TASK_IMPLEMENTATION', '0.0001', '0.0001'],
    ['IDEA_CHAT', '999999.9999', '999999.9999'],
  ] as const)('%s met een keuze van %s krijgt het plafond %s als string', async (kind, stored, expected) => {
    await chooseCeiling(kind, stored)
    const jobId = await claimHarnessJob(kind)

    const context = await contextOf(jobId)

    expect(context).toMatchObject({ kind, config: { runtime: 'HARNESS', model: 'gsq-lokaal', max_cost_usd: expected } })
    expect(typeof (context.config as { max_cost_usd: unknown }).max_cost_usd).toBe('string')
  })

  it('de keuze geldt per jobsoort: de keuze voor IDEA_CHAT raakt de standaard van TASK_IMPLEMENTATION niet', async () => {
    await chooseCeiling('IDEA_CHAT', '0.2000')
    const jobId = await claimHarnessJob('TASK_IMPLEMENTATION')

    const context = await contextOf(jobId)

    expect(context).toMatchObject({ config: { max_cost_usd: '0.50' } })
  })

  it('de configuratienaam komt uit de job, niet uit de keuze van het product', async () => {
    await chooseCeiling('IDEA_CHAT', '0.3000', 'een-andere-naam')
    const jobId = await claimHarnessJob('IDEA_CHAT')

    const context = await contextOf(jobId)

    expect(context).toMatchObject({ config: { runtime: 'HARNESS', model: 'gsq-lokaal', max_cost_usd: '0.3' } })
  })
})

// ---------------------------------------------------------------------------------------------------------
// Taak 4 (M45-2b): enqueue en kostenmelding tegen de echte database
// ---------------------------------------------------------------------------------------------------------

type ToolResult = { isError?: boolean; content: Array<{ text: string }> }
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>

/** De handler die een register*Tool(server)-functie aan de server hangt, zonder echte MCP-server. */
function toolHandlerOf(register: (server: McpServer) => void): ToolHandler {
  let handler: ToolHandler | undefined
  register({ registerTool: (_name: string, _config: unknown, callback: ToolHandler) => { handler = callback } } as unknown as McpServer)
  return handler!
}

/** De keuze van het product voor een jobsoort, zoals de ops-UI haar zou zetten (updated_at heeft geen default). */
async function chooseConfiguration(kind: 'IDEA_CHAT' | 'TASK_IMPLEMENTATION', configuration = 'gsq-lokaal') {
  await world.h.admin.query(
    'INSERT INTO product_harness_choices(product_id, kind, configuration, max_cost_usd, updated_at) VALUES($1, $2, $3, 0.5, now())',
    [world.productId, kind, configuration],
  )
}

async function jobRowOf(jobId: string) {
  return (await world.h.admin.query(
    `SELECT kind::text AS kind, source::text AS source, status::text AS status, runtime::text AS runtime, requested_model,
            required_capability, requested_thinking_budget, requested_permission_mode
     FROM claude_jobs WHERE id = $1`, [jobId],
  )).rows[0]
}

describe('enqueue volgt de productkeuze: het resultaat is een job die de claim vindt', () => {
  async function dispatchTask(): Promise<string> {
    const taskId = await insertTask(world)
    const { job_id } = await dispatchTaskImplementation(
      { taskId, productId: world.productId, userId: world.userId },
      { db: holder.db, notify: async () => undefined },
    )
    return job_id
  }

  async function sendChatMessage(): Promise<string> {
    const ideaId = await insertIdea(world)
    const result = await toolHandlerOf(registerSendIdeaChatMessageTool)({ product_id: world.productId, idea_id: ideaId, content: 'hallo' })
    expect(result.isError).toBeFalsy()
    const { rows } = await world.h.admin.query<{ id: string }>('SELECT id FROM claude_jobs WHERE idea_id = $1', [ideaId])
    expect(rows).toHaveLength(1)
    return rows[0].id
  }

  it('een losse taak met een keuze wordt een HARNESS-job zonder Claude-snapshot of capability, en een HARNESS-worker claimt hem', async () => {
    await chooseConfiguration('TASK_IMPLEMENTATION')

    const jobId = await dispatchTask()

    expect(await jobRowOf(jobId)).toEqual({
      kind: 'TASK_IMPLEMENTATION', source: 'COPILOT', status: 'QUEUED', runtime: 'HARNESS', requested_model: 'gsq-lokaal',
      required_capability: null, requested_thinking_budget: null, requested_permission_mode: null,
    })
    expect(await visibleTo(world, { runtime: 'CLAUDE' })).toEqual([])
    expect(await visibleTo(world, { runtime: 'HARNESS' })).toEqual([jobId])
    expect(await tryClaimJob(world.userId, world.tokenId, 'harness-enqueue', undefined, 'HARNESS', [], null)).toBe(jobId)
  })

  it.each([
    ['er is geen keuze', null],
    ['de keuze geldt voor een andere jobsoort (IDEA_CHAT)', 'IDEA_CHAT'],
  ] as const)('een losse taak waarvoor %s wordt een Claude-job met de snapshot, die geen HARNESS-worker ziet', async (_reden, otherKind) => {
    if (otherKind) await chooseConfiguration(otherKind)

    const jobId = await dispatchTask()

    const row = await jobRowOf(jobId)
    expect(row).toMatchObject({ kind: 'TASK_IMPLEMENTATION', source: 'COPILOT', status: 'QUEUED', runtime: 'CLAUDE', required_capability: null })
    expect(row.requested_model).not.toBeNull()
    expect(row.requested_permission_mode).not.toBeNull()
    expect(await visibleTo(world, { runtime: 'HARNESS' })).toEqual([])
  })

  it('send_idea_chat_message met een keuze maakt een HARNESS-job (SYSTEM) die een HARNESS-worker claimt', async () => {
    await chooseConfiguration('IDEA_CHAT', 'qwen3-coder')

    const jobId = await sendChatMessage()

    expect(await jobRowOf(jobId)).toMatchObject({
      kind: 'IDEA_CHAT', source: 'SYSTEM', status: 'QUEUED', runtime: 'HARNESS', requested_model: 'qwen3-coder', required_capability: null,
    })
    expect(await visibleTo(world, { runtime: 'CLAUDE' })).toEqual([])
    expect(await tryClaimJob(world.userId, world.tokenId, 'harness-enqueue', undefined, 'HARNESS', [], null)).toBe(jobId)
  })

  it.each([
    ['er is geen keuze', null],
    ['de keuze geldt voor een andere jobsoort (TASK_IMPLEMENTATION)', 'TASK_IMPLEMENTATION'],
  ] as const)('send_idea_chat_message waarvoor %s maakt een gewone Claude-job', async (_reden, otherKind) => {
    if (otherKind) await chooseConfiguration(otherKind)

    const jobId = await sendChatMessage()

    expect(await jobRowOf(jobId)).toMatchObject({ kind: 'IDEA_CHAT', source: 'SYSTEM', runtime: 'CLAUDE', required_capability: null, requested_model: null })
    expect(await visibleTo(world, { runtime: 'HARNESS' })).toEqual([])
    expect(await tryClaimJob(world.userId, world.tokenId, 'claude-enqueue', undefined, 'CLAUDE', [], null)).toBe(jobId)
  })
})

describe('kostenmelding van een HARNESS-job: de kostenrij en de statusupdate zijn één echte transactie', () => {
  const update = toolHandlerOf(registerUpdateJobStatusTool)
  const COST = { reported_cost_usd: '0.00031200000000000005', cost_source: 'provider_reported', provider: 'openrouter' } as const
  // Het schema van de tool begrenst provider op 200 tekens, maar een directe aanroep van de handler passeert dat schema niet:
  // zo wordt de kostenrij pas door de database geweigerd, ná de validatie en op het moment van het schrijven.
  const COST_REFUSED_BY_DATABASE = { ...COST, provider: 'x'.repeat(201) }
  let worktreeRoot: string

  beforeEach(async () => {
    // Het failed-pad markeert de worktree voor opruiming: in een eigen tijdelijke map, nooit in de echte worktree-root.
    worktreeRoot = await mkdtemp(join(tmpdir(), 'm45-cost-'))
    process.env.SCRUM4ME_AGENT_WORKTREE_DIR = worktreeRoot
  })
  afterEach(async () => {
    delete process.env.SCRUM4ME_AGENT_WORKTREE_DIR
    await rm(worktreeRoot, { recursive: true, force: true })
  })

  /** Een HARNESS-job die een HARNESS-worker echt claimt (status CLAIMED, geclaimd door de token van de seed-gebruiker). */
  async function claimedJob(kind: 'IDEA_CHAT' | 'TASK_IMPLEMENTATION'): Promise<string> {
    const jobId = await insertJob(
      world,
      kind === 'IDEA_CHAT'
        ? { runtime: 'HARNESS', kind, source: 'SYSTEM', idea: true, requestedModel: 'gsq-lokaal' }
        : { runtime: 'HARNESS', kind, source: 'COPILOT', task: true, requestedModel: 'gsq-lokaal' },
    )
    expect(await tryClaimJob(world.userId, world.tokenId, 'harness-cost', undefined, 'HARNESS', [], null)).toBe(jobId)
    return jobId
  }

  const costRowOf = async (jobId: string) => (await world.h.admin.query(
    `SELECT job_id, reported_cost_usd::text AS reported_cost_usd, cost_source, provider, configuration, reported_at
     FROM job_cost_reports WHERE job_id = $1`, [jobId],
  )).rows[0]

  const assistantMessagesOf = async (jobId: string) =>
    (await world.h.admin.query('SELECT content FROM idea_chat_messages WHERE job_id = $1', [jobId])).rows

  describe('gewoon pad (losse taak)', () => {
    it('failed + cost: de job is FAILED en de kostenrij staat er met het naar boven afgeronde bedrag en de configuratie van de job', async () => {
      const jobId = await claimedJob('TASK_IMPLEMENTATION')

      const result = await update({ job_id: jobId, status: 'failed', error: 'COST_LIMIT_EXCEEDED', cost: COST })

      expect(result.isError).toBeFalsy()
      expect((await statusOf(world, jobId)).status).toBe('FAILED')
      expect(await costRowOf(jobId)).toEqual({
        job_id: jobId, reported_cost_usd: '0.000313', cost_source: 'provider_reported', provider: 'openrouter',
        configuration: 'gsq-lokaal', reported_at: expect.any(Date),
      })
    })

    it('een bron zonder bedrag schrijft een rij zonder bedrag en zonder aanbieder', async () => {
      const jobId = await claimedJob('TASK_IMPLEMENTATION')

      const result = await update({ job_id: jobId, status: 'failed', error: 'COST_UNKNOWN', cost: { reported_cost_usd: null, cost_source: 'none' } })

      expect(result.isError).toBeFalsy()
      expect(await costRowOf(jobId)).toMatchObject({ reported_cost_usd: null, cost_source: 'none', provider: null, configuration: 'gsq-lokaal' })
    })

    it('zonder cost schrijft de handler geen kostenrij en blijft het de gewone statusupdate', async () => {
      const jobId = await claimedJob('TASK_IMPLEMENTATION')

      const result = await update({ job_id: jobId, status: 'failed', error: 'model faalde' })

      expect(result.isError).toBeFalsy()
      expect((await statusOf(world, jobId)).status).toBe('FAILED')
      expect(await costRowOf(jobId)).toBeUndefined()
    })

    it('een kostenrij die de database weigert, laat de job ongewijzigd: de statusupdate gaat mee terug', async () => {
      const jobId = await claimedJob('TASK_IMPLEMENTATION')

      const result = await update({ job_id: jobId, status: 'failed', error: 'COST_LIMIT_EXCEEDED', cost: COST_REFUSED_BY_DATABASE })
      // De fout komt van het schrijven van de kostenrij zelf (niet van een eerdere stap): daarna is de update teruggedraaid.
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toMatch(/jobCostReport\.upsert\(\)/)
      expect((await statusOf(world, jobId)).status).toBe('CLAIMED')
      expect(await costRowOf(jobId)).toBeUndefined()
    })

    it('een geweigerde melding (een Claude-job met cost) schrijft niets en laat de job staan', async () => {
      const jobId = await insertJob(world, { runtime: 'CLAUDE', kind: 'TASK_IMPLEMENTATION', source: 'COPILOT', task: true })
      expect(await tryClaimJob(world.userId, world.tokenId, 'claude-cost', undefined, 'CLAUDE', [], null)).toBe(jobId)

      const result = await update({ job_id: jobId, status: 'failed', error: 'model faalde', cost: COST })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe('VALIDATION_ERROR: COST_REPORT_NOT_ALLOWED')
      expect((await statusOf(world, jobId)).status).toBe('CLAIMED')
      expect(await costRowOf(jobId)).toBeUndefined()
    })
  })

  describe('idee-chat-pad (transactie onder de per-idea lock)', () => {
    it('done + cost: de job is DONE, het antwoord staat in het kanaal en de kostenrij staat er', async () => {
      const jobId = await claimedJob('IDEA_CHAT')

      const result = await update({ job_id: jobId, status: 'done', summary: 'Het antwoord.', cost: { ...COST, reported_cost_usd: '0.0042', cost_source: 'litellm_computed' } })

      expect(result.isError).toBeFalsy()
      expect((await statusOf(world, jobId)).status).toBe('DONE')
      expect(await assistantMessagesOf(jobId)).toEqual([{ content: 'Het antwoord.' }])
      expect(await costRowOf(jobId)).toMatchObject({
        reported_cost_usd: '0.004200', cost_source: 'litellm_computed', provider: 'openrouter', configuration: 'gsq-lokaal',
      })
    })

    it('een kostenrij die de database weigert, laat de job, het kanaal en de kostenrij ongewijzigd', async () => {
      const jobId = await claimedJob('IDEA_CHAT')

      const result = await update({ job_id: jobId, status: 'done', summary: 'Het antwoord.', cost: COST_REFUSED_BY_DATABASE })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toMatch(/jobCostReport\.upsert\(\)/)
      expect((await statusOf(world, jobId)).status).toBe('CLAIMED')
      expect(await assistantMessagesOf(jobId)).toEqual([])
      expect(await costRowOf(jobId)).toBeUndefined()
    })

    // Een USER-bericht dat tijdens de beurt binnenkwam, geeft bij de afronding precies één vervolgjob. De productkeuze
    // van dat moment bepaalt of hij HARNESS wordt; zonder keuze is het een gewone Claude-job.
    it.each([
      ['met een keuze', 'HARNESS', 'nieuw-model'],
      ['zonder keuze', 'CLAUDE', null],
    ] as const)('de vervolgjob %s is een %s-job', async (_met, runtime, requestedModel) => {
      if (requestedModel) await chooseConfiguration('IDEA_CHAT', requestedModel)
      const jobId = await claimedJob('IDEA_CHAT')
      const { rows } = await world.h.admin.query<{ idea_id: string }>('SELECT idea_id FROM claude_jobs WHERE id = $1', [jobId])
      await world.h.admin.query(
        `INSERT INTO idea_chat_messages(id, idea_id, role, kind, content, created_at)
         VALUES($1, $2, 'USER', 'TEXT', 'nog een vraag', now() + interval '1 minute')`,
        [randomUUID(), rows[0].idea_id],
      )

      const result = await update({ job_id: jobId, status: 'done', summary: 'Het antwoord.' })

      expect(result.isError).toBeFalsy()
      const followUps = (await world.h.admin.query<{ id: string }>(
        "SELECT id FROM claude_jobs WHERE idea_id = $1 AND status = 'QUEUED'", [rows[0].idea_id],
      )).rows
      expect(followUps).toHaveLength(1)
      expect(await jobRowOf(followUps[0].id)).toMatchObject({
        kind: 'IDEA_CHAT', source: 'SYSTEM', runtime, requested_model: requestedModel, required_capability: null,
      })
      expect(await visibleTo(world, { runtime: 'HARNESS' })).toEqual(runtime === 'HARNESS' ? [followUps[0].id] : [])
    })
  })
})
