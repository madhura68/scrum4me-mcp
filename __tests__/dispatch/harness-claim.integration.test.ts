// M45-2b (Taak 2, deel 1): het claimfilter met de HARNESS-tak tegen een echte Postgres, in beide richtingen.
//
// Eén tabel met QUEUED-jobs van drie runtimes. Een worker met runtime HARNESS claimt alleen HARNESS-jobs van twee
// soorten (idee-chat SYSTEM en een losse taak COPILOT), een Claude-worker nooit een HARNESS-job, een Codex-worker
// alleen de Codex-job en de local_llm-worker (Claude, exact [local_llm]) alleen zijn eigen job. Daarnaast: het
// tier-fragment met een HARNESS-worker als zichzelf en de idee-job-precheck, die geen harness-workers meetelt.
//
// Opzet voor aanvullingen (het deel na de claim volgt in een volgende taak): `makeWorld()` zet per test een
// wegwerp-gebruiker, -product en -token neer (de harness-seed) en geeft de hulpfuncties `insertJob`, `insertWorker`,
// `insertIdea`, `insertTask` en `insertSprintRun` hun context; `dropWorld()` ruimt alles op wat zij aanmaakten.
// Er is geen toestand buiten `world`, dus een volgend describe-blok kan zonder voorbereiding dezelfde hulpfuncties
// gebruiken. `holder.db` is de PrismaClient van de web-rol (scrum4me_web_runtime): de MCP draait met die rol, en
// de gemockte `src/prisma.js` geeft hem aan tryClaimJob, dispatchIdeaJob en wat er nog volgt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { makeDispatchHarness, type DispatchHarness } from './harness.js'
import { buildClaimableJobWhereFragment } from '../../src/dispatch/eligibility.js'
import type { WorkerRuntime } from '../../src/worker-runtime.js'

const holder = vi.hoisted(() => ({ db: null as unknown as PrismaClient }))
vi.mock('../../src/prisma.js', () => ({ get prisma() { return holder.db } }))

import { tryClaimJob } from '../../src/tools/wait-for-job.js'
import { dispatchIdeaJob } from '../../src/lib/dispatch/idea-jobs.js'

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
                             required_capability, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - ($12::int * interval '1 second'), now())`,
    [
      id, world.userId, world.productId, ideaId, taskId, spec.sprintRunId ?? null, spec.kind, spec.source,
      spec.status ?? 'QUEUED', spec.runtime, spec.requiredCapability ?? null, spec.ageSeconds ?? 0,
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
  claudeLocalLlmChat: string
  codexGrill: string
}

/** QUEUED-jobs met runtime HARNESS (idee-chat SYSTEM, losse taak COPILOT, taak met sprint-run, en drie die nergens bij horen), CLAUDE (idee-chat en local_llm-idee-chat) en CODEX. */
async function seedMixedTable(world: World): Promise<MixedTable> {
  const sprintRunId = await insertSprintRun(world)
  return {
    harnessChat: await insertJob(world, { runtime: 'HARNESS', kind: 'IDEA_CHAT', source: 'SYSTEM', idea: true, ageSeconds: 90 }),
    harnessTask: await insertJob(world, { runtime: 'HARNESS', kind: 'TASK_IMPLEMENTATION', source: 'COPILOT', task: true, ageSeconds: 80 }),
    harnessSprintTask: await insertJob(world, { runtime: 'HARNESS', kind: 'TASK_IMPLEMENTATION', source: 'COPILOT', task: true, sprintRunId, ageSeconds: 70 }),
    harnessWithCapability: await insertJob(world, { runtime: 'HARNESS', kind: 'TASK_IMPLEMENTATION', source: 'COPILOT', task: true, requiredCapability: 'local_llm', ageSeconds: 60 }),
    harnessManualTask: await insertJob(world, { runtime: 'HARNESS', kind: 'TASK_IMPLEMENTATION', source: 'MANUAL', ageSeconds: 50 }),
    harnessGrill: await insertJob(world, { runtime: 'HARNESS', kind: 'IDEA_GRILL', source: 'COPILOT', idea: true, ageSeconds: 40 }),
    claudeChat: await insertJob(world, { runtime: 'CLAUDE', kind: 'IDEA_CHAT', source: 'SYSTEM', idea: true, ageSeconds: 30 }),
    claudeLocalLlmChat: await insertJob(world, { runtime: 'CLAUDE', kind: 'IDEA_CHAT', source: 'SYSTEM', idea: true, requiredCapability: 'local_llm', ageSeconds: 20 }),
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

  it.each([[['local_llm']], [['deploy']], [['docs_audit']], [['code_edit', 'review']]])(
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
    for (const capabilities of [[], ['code_edit', 'planning', 'review'], ['local_llm'], ['deploy'], ['docs_audit']]) {
      const seen = await visibleTo(world, { runtime: 'CLAUDE', capabilities })
      for (const id of harnessJobs) expect(seen).not.toContain(id)
    }
    expect(await visibleTo(world, { runtime: 'CLAUDE' })).toEqual([table.claudeChat])
    expect(await visibleTo(world, { runtime: 'CLAUDE', capabilities: ['code_edit', 'planning', 'review'] })).toEqual([table.claudeChat])
  })

  it('de local_llm-worker (Claude, exact [local_llm]) ziet alleen zijn eigen job', async () => {
    expect(await visibleTo(world, { runtime: 'CLAUDE', capabilities: ['local_llm'] })).toEqual([table.claudeLocalLlmChat])
  })

  it('een Codex-worker ziet alleen de Codex-job', async () => {
    expect(await visibleTo(world, { runtime: 'CODEX' })).toEqual([table.codexGrill])
    expect(await visibleTo(world, { runtime: 'CODEX', capabilities: ['review'] })).toEqual([table.codexGrill])
    expect(await visibleTo(world, { runtime: 'CODEX', capabilities: ['local_llm'] })).toEqual([])
  })

  it('geen enkele worker ziet de HARNESS-jobs die er niet bij horen: sprint-run, required_capability, bron MANUAL en een andere soort', async () => {
    const strays = [table.harnessSprintTask, table.harnessWithCapability, table.harnessManualTask, table.harnessGrill]
    for (const poller of [
      { runtime: 'HARNESS' as const },
      { runtime: 'HARNESS' as const, capabilities: ['local_llm'] },
      { runtime: 'CLAUDE' as const },
      { runtime: 'CLAUDE' as const, capabilities: ['local_llm'] },
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
      table.claudeChat, table.claudeLocalLlmChat, table.codexGrill,
    ]) {
      expect((await statusOf(world, id)).status).toBe('QUEUED')
    }
  })

  it('een HARNESS-worker met capabilities [local_llm] claimt hetzelfde: de runtime wint', async () => {
    const claim = () => tryClaimJob(world.userId, world.tokenId, 'harness-2', undefined, 'HARNESS', ['local_llm'], null)
    expect([await claim(), await claim(), await claim()]).toEqual([table.harnessChat, table.harnessTask, null])
  })

  it('een Claude-worker claimt zijn eigen idee-chat en daarna niets, ook al staan er HARNESS-jobs klaar', async () => {
    const claim = () => tryClaimJob(world.userId, world.tokenId, 'claude-1', undefined, 'CLAUDE', [], null)
    expect([await claim(), await claim()]).toEqual([table.claudeChat, null])
    expect((await statusOf(world, table.harnessChat)).status).toBe('QUEUED')
    expect((await statusOf(world, table.harnessTask)).status).toBe('QUEUED')
  })

  it('de local_llm-worker claimt alleen zijn eigen job, en een Codex-worker alleen de Codex-job', async () => {
    expect(await tryClaimJob(world.userId, world.tokenId, 'local-1', undefined, 'CLAUDE', ['local_llm'], null)).toBe(table.claudeLocalLlmChat)
    expect(await tryClaimJob(world.userId, world.tokenId, 'local-1', undefined, 'CLAUDE', ['local_llm'], null)).toBeNull()
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
