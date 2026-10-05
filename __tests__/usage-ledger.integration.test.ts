// IDEA-235 (spec §4.5, §5, §9; plan Taak 8): record_usage_segment, the create_task estimate and
// get_estimate_history against a real Postgres with the usage_ledger migration. Opt in only
// against a disposable test DB (TEST_DATABASE_URL); without it the suite skips.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { toolText } from './helpers/tool-result.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip
const authState = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(async () => ({ userId: authState.userId, tokenId: 'integration-test' })),
  getAuth: vi.fn(async () => ({ userId: authState.userId, tokenId: 'integration-test' })),
  getTokenScopedProducts: vi.fn(async () => []),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))

type Line = { agent_key: string; agent_label: string; model_id: string; input: number; output: number; cache_read: number; cache_write: number; requests: number }
type FixtureSegment = { id: string; ended_reason: string | null; active_ms: number; lines: Line[]; anchor_task_id?: string }
type Fixture = {
  prices: { model_id: string; runtime: 'CLAUDE' | 'CODEX'; provider: string; billing_mode: 'SUBSCRIPTION' | 'API'; billing_unit: 'USD_PROXY' | 'USD' | 'CREDITS'; service_tier: string; input: string; output: string; cache_read: string; cache_write: string }[]
  tasks: { id: string; status: string; estimate: { minutes: number; usd: string; basis: string } | null; segments: FixtureSegment[]; expect: { time: boolean; cost: boolean; active_ms?: number; usd?: string } }[]
  overhead: FixtureSegment[]
}
const fixture = JSON.parse(readFileSync(
  new URL('../vendor/scrum4me-shared/fixtures/usage-ledger/measurable-v1.json', import.meta.url), 'utf8',
)) as Fixture

const body = (result: CallToolResult) => {
  expect(result.isError, toolText(result)).not.toBe(true)
  return JSON.parse(toolText(result))
}

describeWithDatabase('IDEA-235 usage ledger (TEST_DATABASE_URL)', () => {
  const suffix = randomUUID().slice(0, 8)
  let setupPool: Pool
  let db: PrismaClient
  let owner: string, other: string, productId: string, sprint1: string, sprint2: string, storyId: string
  let record: typeof import('../src/tools/record-usage-segment.js').handleRecordUsageSegment
  let history: typeof import('../src/tools/get-estimate-history.js').handleGetEstimateHistory
  let createTask: typeof import('../src/tools/create-task.js').handleCreateTask
  let n = 0

  const newTask = async (sprintId: string | null, status = 'IN_PROGRESS', id?: string) =>
    (await db.task.create({
      data: {
        ...(id && { id }), story_id: storyId, product_id: productId, sprint_id: sprintId,
        code: `UL-${suffix}-${n++}`, title: 'usage', priority: 2, sort_order: n, status: status as 'IN_PROGRESS',
      },
    })).id
  const header = (taskId: string | null, anchor: string) => ({
    id: randomUUID(), task_id: taskId, anchor_task_id: anchor, session_id: `session-${suffix}`,
    started_at: '2026-10-05T10:00:00.000Z', mod_version: 'test',
  })
  const line = (model: string, input: number) => ({
    agent_key: 'main', agent_label: 'main', model_id: model,
    input_tokens: input, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, requests: 1,
  })
  const closeOf = (h: ReturnType<typeof header>, input = 100, reason: 'done' | 'switched' = 'done') => ({
    ...h, ended_at: '2026-10-05T10:20:00.000Z', ended_reason: reason, active_ms: 60_000,
    cost_start_usd: 1, cost_end_usd: 1.5, lines: [line(`m-${suffix}`, input)],
  })
  // Stories and PBIs do not cascade with their product.
  const dropProduct = async (id: string) => {
    await db.usageSegment.deleteMany({ where: { product_id: id } })
    await db.task.deleteMany({ where: { product_id: id } })
    await db.story.deleteMany({ where: { product_id: id } })
    await db.pbi.deleteMany({ where: { product_id: id } })
    await db.sprint.deleteMany({ where: { product_id: id } })
    await db.product.deleteMany({ where: { id } })
  }
  const stored = (id: string) => db.usageSegment.findUnique({ where: { id }, include: { lines: true } })

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl
    setupPool = new Pool({ connectionString: testDatabaseUrl })
    db = new PrismaClient({ adapter: new PrismaPg(setupPool) })
    owner = (await db.user.create({ data: { username: `ul-owner-${suffix}`, password_hash: 'test-only' } })).id
    other = (await db.user.create({ data: { username: `ul-other-${suffix}`, password_hash: 'test-only' } })).id
    authState.userId = owner
    productId = (await db.product.create({ data: { user_id: owner, name: `ul-${suffix}`, definition_of_done: 'test' } })).id
    await db.productMember.create({ data: { product_id: productId, user_id: other } })
    sprint1 = (await db.sprint.create({ data: { product_id: productId, code: `S-${suffix}-1`, sprint_goal: 'one' } })).id
    sprint2 = (await db.sprint.create({ data: { product_id: productId, code: `S-${suffix}-2`, sprint_goal: 'two' } })).id
    const pbi = await db.pbi.create({ data: { product_id: productId, code: `P-${suffix}`, title: 'pbi', priority: 2, sort_order: 1 } })
    storyId = (await db.story.create({
      data: { pbi_id: pbi.id, product_id: productId, sprint_id: sprint1, code: `ST-${suffix}`, title: 'story', priority: 2, sort_order: 1 },
    })).id
    ;({ handleRecordUsageSegment: record } = await import('../src/tools/record-usage-segment.js'))
    ;({ handleGetEstimateHistory: history } = await import('../src/tools/get-estimate-history.js'))
    ;({ handleCreateTask: createTask } = await import('../src/tools/create-task.js'))
  })

  afterAll(async () => {
    if (!db) return
    await db.modelPrice.deleteMany({ where: { model_id: { endsWith: `-${suffix}` } } })
    await dropProduct(productId)
    await db.user.deleteMany({ where: { id: { in: [owner, other] } } })
    await db.$disconnect()
    await setupPool.end()
  })

  it('overhead: a closing message that arrives first creates the segment with the anchor and its sprint', async () => {
    const anchor = await newTask(sprint1)
    const h = header(null, anchor)
    expect(body(await record(closeOf(h, 100, 'switched')))).toEqual({ id: h.id, state: 'closed', effect: 'created' })
    const s = await stored(h.id)
    expect(s).toMatchObject({ task_id: null, anchor_task_id: anchor, sprint_id: sprint1, product_id: productId, user_id: owner, ended_reason: 'SWITCHED', active_ms: 60_000 })
    expect(s!.reported_cost_usd!.toFixed(4)).toBe('0.5000')
    expect(s!.lines).toHaveLength(1)
  })

  it('rejects another user on a closed segment before the lifecycle rule (RR4-6)', async () => {
    const h = header(await newTask(sprint1), '')
    h.anchor_task_id = h.task_id!
    body(await record(closeOf(h)))
    authState.userId = other
    try {
      const result = await record(closeOf(h, 999))
      expect(toolText(result)).toMatch(/^USAGE_SEGMENT_REJECTED: /)
    } finally {
      authState.userId = owner
    }
    expect((await stored(h.id))!.lines[0].input_tokens).toBe(100)
  })

  it('a task taken out of its sprint between opening and closing keeps the original sprint and all lines', async () => {
    const task = await newTask(sprint1)
    const h = { ...header(task, task) }
    expect(body(await record(h)).effect).toBe('created')
    await db.task.update({ where: { id: task }, data: { sprint_id: null } })
    expect(body(await record(closeOf(h)))).toEqual({ id: h.id, state: 'closed', effect: 'closed' })
    expect(await stored(h.id)).toMatchObject({ sprint_id: sprint1, ended_reason: 'DONE', lines: [expect.objectContaining({ input_tokens: 100 })] })
  })

  it('a task moved to another sprint stays in the sprint fixed at opening', async () => {
    const task = await newTask(sprint1)
    const h = header(task, task)
    body(await record(h))
    await db.task.update({ where: { id: task }, data: { sprint_id: sprint2 } })
    body(await record(closeOf(h)))
    expect((await stored(h.id))!.sprint_id).toBe(sprint1)
  })

  it('open → close → the same and a different closing message again: one segment, lines of the first closing', async () => {
    const task = await newTask(sprint1)
    const h = header(task, task)
    body(await record(h))
    body(await record(closeOf(h, 100)))
    expect(body(await record(closeOf(h, 100)))).toEqual({ id: h.id, state: 'closed', effect: 'none' })
    expect(body(await record({ ...closeOf(h, 555), ended_reason: 'switched' }))).toEqual({ id: h.id, state: 'closed', effect: 'none' })
    expect(body(await record(h))).toEqual({ id: h.id, state: 'closed', effect: 'none' })
    const s = await stored(h.id)
    expect(s).toMatchObject({ ended_reason: 'DONE', lines: [expect.objectContaining({ input_tokens: 100 })] })
    expect(await db.usageSegment.count({ where: { id: h.id } })).toBe(1)
  })

  it('two closings at once: exactly one wins, with its own lines', async () => {
    const task = await newTask(sprint1)
    const h = header(task, task)
    body(await record(h))
    const results = (await Promise.all([record(closeOf(h, 1)), record(closeOf(h, 2))])).map(body)
    expect(results.map((r) => r.effect).sort()).toEqual(['closed', 'none'])
    const winner = results[0].effect === 'closed' ? 1 : 2
    expect((await stored(h.id))!.lines.map((l) => l.input_tokens)).toEqual([winner])
  })

  it('a task without sprint is a permanent error and stores nothing', async () => {
    const task = await newTask(null)
    const h = header(task, task)
    expect(toolText(await record(h))).toMatch(/^USAGE_SEGMENT_REJECTED: .*no sprint/)
    expect(await stored(h.id)).toBeNull()
  })

  it('create_task stores an estimate once, and refuses a partial one without creating the task', async () => {
    const created = body(await createTask({
      story_id: storyId, title: 'geschat', priority: 2,
      estimate_active_minutes: 45, estimate_usd: 3.25, estimate_basis: 'Twee tools en tests; Opus.',
    }))
    expect(await db.taskEstimate.findUnique({ where: { task_id: created.id } })).toMatchObject({
      estimate_active_minutes: 45, estimate_basis: 'Twee tools en tests; Opus.',
    })
    const before = await db.task.count({ where: { story_id: storyId } })
    expect(toolText(await createTask({ story_id: storyId, title: 'half', priority: 2, estimate_usd: 1 }))).toMatch(/^ESTIMATE_INCOMPLETE/)
    expect(await db.task.count({ where: { story_id: storyId } })).toBe(before)
    const plain = body(await createTask({ story_id: storyId, title: 'zonder', priority: 2 }))
    expect(await db.taskEstimate.findUnique({ where: { task_id: plain.id } })).toBeNull()
  })

  it('get_estimate_history returns only the measurable fixture tasks, with USD only when fully priced', async () => {
    // A product of its own, so the tasks above do not count.
    const product = await db.product.create({ data: { user_id: owner, name: `ul-history-${suffix}`, definition_of_done: 'test' } })
    const sprint = await db.sprint.create({ data: { product_id: product.id, code: `S-${suffix}-h`, sprint_goal: 'history' } })
    const pbi = await db.pbi.create({ data: { product_id: product.id, code: `P-${suffix}-h`, title: 'pbi', priority: 2, sort_order: 1 } })
    const story = await db.story.create({ data: { pbi_id: pbi.id, product_id: product.id, sprint_id: sprint.id, code: `ST-${suffix}-h`, title: 's', priority: 2, sort_order: 1 } })
    const model = (id: string) => `${id}-${suffix}`
    try {
      for (const p of fixture.prices) {
        await db.modelPrice.create({ data: {
          model_id: model(p.model_id), runtime: p.runtime, provider: p.provider, billing_mode: p.billing_mode,
          billing_unit: p.billing_unit, service_tier: p.service_tier, input_price_per_1m: p.input,
          output_price_per_1m: p.output, cache_read_price_per_1m: p.cache_read, cache_write_price_per_1m: p.cache_write,
        } })
      }
      const ids = new Map<string, string>()
      const insert = async (s: FixtureSegment, taskId: string | null, anchor: string) => db.usageSegment.create({ data: {
        id: randomUUID(), user_id: owner, product_id: product.id, sprint_id: sprint.id, task_id: taskId, anchor_task_id: anchor,
        session_id: 'history', started_at: new Date('2026-10-05T09:00:00Z'), mod_version: 'test', active_ms: s.active_ms,
        ended_at: s.ended_reason ? new Date('2026-10-05T10:00:00Z') : null,
        ended_reason: s.ended_reason as 'DONE' | null,
        lines: { create: s.lines.map((l) => ({
          agent_key: l.agent_key, agent_label: l.agent_label, model_id: model(l.model_id), input_tokens: l.input,
          output_tokens: l.output, cache_read_tokens: l.cache_read, cache_write_tokens: l.cache_write, requests: l.requests,
        })) },
      } })
      for (const t of fixture.tasks) {
        const task = await db.task.create({ data: {
          story_id: story.id, product_id: product.id, sprint_id: sprint.id, code: `H-${suffix}-${t.id}`,
          title: t.id, priority: 2, sort_order: ids.size + 1, status: t.status as 'DONE',
        } })
        ids.set(t.id, task.id)
        if (t.estimate) {
          await db.taskEstimate.create({ data: {
            task_id: task.id, estimate_active_minutes: t.estimate.minutes, estimate_usd: t.estimate.usd, estimate_basis: t.estimate.basis,
          } })
        }
        for (const s of t.segments) await insert(s, task.id, task.id)
      }
      for (const s of fixture.overhead) await insert(s, null, ids.get(s.anchor_task_id!)!)

      const result = body(await history({ product_id: product.id, limit: 20 }))
      const byTitle = Object.fromEntries(result.tasks.map((t: { title: string }) => [t.title, t]))
      expect(Object.keys(byTitle).sort()).toEqual(
        fixture.tasks.filter((t) => t.expect.time).map((t) => t.id).sort(),
      )
      const measurable = fixture.tasks.find((t) => t.id === 'measurable')!
      expect(byTitle.measurable).toMatchObject({
        estimate: { active_minutes: 30, usd: '2.5000', basis: measurable.estimate!.basis },
        actual: { active_minutes: 15, usd: measurable.expect.usd, usd_status: 'priced' },
        ratio: { time: 0.5, cost: 0.09 },
      })
      expect(byTitle['unpriced-line']).toMatchObject({
        actual: { usd: null, usd_status: 'no_price' },
        ratio: { time: 0.1, cost: null },
      })
      expect(result.tasks.filter((t: { ratio: { cost: number | null } }) => t.ratio.cost !== null).map((t: { title: string }) => t.title))
        .toEqual(['measurable'])
    } finally {
      await dropProduct(product.id)
    }
  })

  it('get_estimate_history refuses a product the user cannot access', async () => {
    const foreign = await db.product.create({ data: { user_id: other, name: `ul-foreign-${suffix}`, definition_of_done: 'test' } })
    try {
      const result = await history({ product_id: foreign.id, limit: 20 })
      expect(result.isError).toBe(true)
    } finally {
      await dropProduct(foreign.id)
    }
  })
})
