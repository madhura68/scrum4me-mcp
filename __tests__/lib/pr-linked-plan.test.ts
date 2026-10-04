import { describe, it, expect, vi, beforeEach } from 'vitest'

const findFirstJob = vi.fn()
const findFirstPbi = vi.fn()
const findManyExec = vi.fn()
const findManyTask = vi.fn()
const findManyStory = vi.fn()
const findManyPbi = vi.fn()
const findManyLog = vi.fn()
const findManyProduct = vi.fn()
vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findFirst: (...a: any[]) => findFirstJob(...a) },
    pbi: { findFirst: (...a: any[]) => findFirstPbi(...a), findMany: (...a: any[]) => findManyPbi(...a) },
    sprintTaskExecution: { findMany: (...a: any[]) => findManyExec(...a) },
    task: { findMany: (...a: any[]) => findManyTask(...a) },
    story: { findMany: (...a: any[]) => findManyStory(...a) },
    storyLog: { findMany: (...a: any[]) => findManyLog(...a) },
    product: { findMany: (...a: any[]) => findManyProduct(...a) },
  },
}))

const tokenScope = vi.fn()
vi.mock('../../src/auth.js', () => ({
  getTokenScopedProducts: (...a: any[]) => tokenScope(...a),
}))

const listShas = vi.fn()
const fetchFile = vi.fn()
vi.mock('../../src/git/pr.js', () => ({
  listPullRequestCommitShas: (...a: any[]) => listShas(...a),
  fetchRepoFileAtRef: (...a: any[]) => fetchFile(...a),
}))

import {
  resolvePrLinkedPlan,
  resolvePlanViaCommits,
  candidateProductIds,
  createResolveContext,
  LINKED_PLAN_BUDGET,
} from '../../src/lib/pr-linked-plan.js'

const JOB = { id: 'review-job', pr_url: 'https://git.jp-visser.nl/o/r/pulls/9' }
const JOB_P = { ...JOB, product_id: 'prod-1' }
const SHA = 'a'.repeat(40)

beforeEach(() => {
  vi.clearAllMocks()
  findFirstJob.mockResolvedValue(null)
  findFirstPbi.mockResolvedValue(null)
  findManyExec.mockResolvedValue([])
  findManyTask.mockResolvedValue([])
  findManyStory.mockResolvedValue([])
  findManyPbi.mockResolvedValue([])
  findManyLog.mockResolvedValue([])
  listShas.mockResolvedValue([])
  fetchFile.mockResolvedValue({ error: 'not found' })
  findManyProduct.mockResolvedValue([])
  tokenScope.mockResolvedValue([])
})

describe('resolvePrLinkedPlan', () => {
  it('sluit de huidige review-job uit in de query', async () => {
    await resolvePrLinkedPlan(JOB as any)
    const where = findFirstJob.mock.calls[0][0].where
    expect(where.id).toEqual({ not: 'review-job' })
    expect(where.pr_url).toBe(JOB.pr_url)
  })
  it('job-pad: task-implementatie met plan_snapshot', async () => {
    findFirstJob.mockResolvedValue({
      id: 'impl', kind: 'TASK_IMPLEMENTATION', plan_snapshot: 'PLAN',
      task: { implementation_plan: 'TP', story: { acceptance_criteria: 'AC' } },
    })
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toMatchObject({ source: 'job', plan_snapshot: 'PLAN', acceptance_criteria: 'AC' })
  })
  it('impl-job zonder bruikbare plan-context → door naar pbi-fallback', async () => {
    findFirstJob.mockResolvedValue({ id: 'impl', kind: 'TASK_IMPLEMENTATION', plan_snapshot: null, task: null })
    findFirstPbi.mockResolvedValue({ id: 'pbi1', docs: [{ doc_revision: { content_md: 'PM' } }] })
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toMatchObject({ source: 'pbi', plan_md: 'PM' })
  })
  it('pbi-fallback via PbiDoc(role=PLAN) → doc_revision.content_md', async () => {
    findFirstPbi.mockResolvedValue({ id: 'pbi1', docs: [{ doc_revision: { content_md: 'PM' } }] })
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toMatchObject({ source: 'pbi', plan_md: 'PM' })
  })
  it('pbi zonder PLAN-doc → null (geen bruikbaar plan)', async () => {
    findFirstPbi.mockResolvedValue({ id: 'pbi1', docs: [] })
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toBeNull()
  })
  it('niets matcht → null', async () => {
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toBeNull()
  })
  it('job zonder pr_url → null zonder queries', async () => {
    const out = await resolvePrLinkedPlan({ id: 'x', pr_url: null } as any)
    expect(out).toBeNull()
    expect(findFirstJob).not.toHaveBeenCalled()
  })

  // Sprint-pad tests
  it('sprint-pad: SPRINT_IMPLEMENTATION zonder task_id → sprint_tasks uit SprintTaskExecution', async () => {
    findFirstJob.mockResolvedValue({ id: 'sprint-impl', kind: 'SPRINT_IMPLEMENTATION', plan_snapshot: null, task: null })
    findManyExec.mockResolvedValue([
      { plan_snapshot: 'P1', task: { title: 'T1', story: { acceptance_criteria: 'AC1' } } },
      { plan_snapshot: 'P2', task: { title: 'T2', story: { acceptance_criteria: null } } },
    ])
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toMatchObject({
      source: 'job',
      sprint_tasks: [
        { task_title: 'T1', plan_snapshot: 'P1', acceptance_criteria: 'AC1' },
        { task_title: 'T2', plan_snapshot: 'P2', acceptance_criteria: null },
      ],
    })
    const where = findManyExec.mock.calls[0][0].where
    expect(where.sprint_job_id).toBe('sprint-impl')
  })
  it('sprint-job zonder execution-rows → door naar pbi-fallback', async () => {
    findFirstJob.mockResolvedValue({ id: 'sprint-impl', kind: 'SPRINT_IMPLEMENTATION', plan_snapshot: null, task: null })
    findManyExec.mockResolvedValue([])
    findFirstPbi.mockResolvedValue({ id: 'pbi1', docs: [{ doc_revision: { content_md: 'PM' } }] })
    const out = await resolvePrLinkedPlan(JOB as any)
    expect(out).toMatchObject({ source: 'pbi', plan_md: 'PM' })
  })
})

// Fixtures voor routes A en B. Story- en taakvorm zoals de resolver ze selecteert.
const task = (code: string, plan: string | null, title = `titel ${code}`) => ({ code, title, implementation_plan: plan })
const story = (code: string, ac: string | null, tasks: ReturnType<typeof task>[] = []) =>
  ({ code, title: `story ${code}`, acceptance_criteria: ac, tasks })

describe('bestaande routes blijven byte-gelijk', () => {
  it('job-route: exact hetzelfde object, ook als er een PR-beschrijving is', async () => {
    findFirstJob.mockResolvedValue({
      id: 'impl', kind: 'TASK_IMPLEMENTATION', plan_snapshot: 'PLAN',
      task: { implementation_plan: 'TP', story: { acceptance_criteria: 'AC' } },
    })
    const out = await resolvePrLinkedPlan(JOB_P, { body: 'ST-1', head_sha: SHA })
    expect(out).toStrictEqual({ source: 'job', plan_snapshot: 'PLAN', plan_md: 'TP', acceptance_criteria: 'AC' })
    expect(findManyStory).not.toHaveBeenCalled()
    expect(listShas).not.toHaveBeenCalled()
  })
  it('pbi-route: exact hetzelfde object, A en B draaien niet', async () => {
    findFirstPbi.mockResolvedValue({ id: 'pbi1', docs: [{ doc_revision: { content_md: 'PM' } }] })
    const out = await resolvePrLinkedPlan(JOB_P, { body: 'ST-1', head_sha: SHA })
    expect(out).toStrictEqual({ source: 'pbi', plan_md: 'PM' })
    expect(findManyStory).not.toHaveBeenCalled()
    expect(listShas).not.toHaveBeenCalled()
  })
  it('zonder pr-argument draaien A en B niet', async () => {
    expect(await resolvePrLinkedPlan(JOB_P)).toBeNull()
    expect(findManyStory).not.toHaveBeenCalled()
    expect(listShas).not.toHaveBeenCalled()
  })
})

describe('route A — verwijzingen in de PR-beschrijving', () => {
  it('storycode neemt acceptatiecriteria en taakplannen mee, binnen het product', async () => {
    findManyStory.mockResolvedValue([story('ST-1', 'AC1', [task('T-1', 'P1'), task('T-2', null)])])
    const out = await resolvePrLinkedPlan(JOB_P, { body: 'Werk voor ST-1.', head_sha: SHA })
    expect(out).toStrictEqual({
      source: 'pr_refs',
      references: ['ST-1'],
      stories: [{
        code: 'ST-1', title: 'story ST-1', acceptance_criteria: 'AC1',
        tasks: [{ code: 'T-1', title: 'titel T-1', implementation_plan: 'P1' }, { code: 'T-2', title: 'titel T-2', implementation_plan: null }],
      }],
      plan_docs: [],
      omitted: [],
    })
    expect(findManyStory.mock.calls[0][0].where).toMatchObject({ product_id: 'prod-1', code: { in: ['ST-1'] } })
  })

  it('taakcode groepeert onder zijn story, zonder de andere taken van die story', async () => {
    findManyTask.mockResolvedValue([{ ...task('T-7', 'P7'), story: { code: 'ST-3', title: 'story ST-3', acceptance_criteria: 'AC3' } }])
    const out: any = await resolvePrLinkedPlan(JOB_P, { body: 'T-7', head_sha: SHA })
    expect(out.source).toBe('pr_refs')
    expect(out.stories).toStrictEqual([{
      code: 'ST-3', title: 'story ST-3', acceptance_criteria: 'AC3',
      tasks: [{ code: 'T-7', title: 'titel T-7', implementation_plan: 'P7' }],
    }])
    expect(out.references).toStrictEqual(['T-7'])
    expect(findManyTask.mock.calls[0][0].where).toMatchObject({ product_id: 'prod-1', code: { in: ['T-7'] } })
  })

  it('PBI-code levert het PLAN-document; pad wordt op head_sha gelezen', async () => {
    findManyPbi.mockResolvedValue([{ code: 'PBI-4', docs: [{ doc_revision: { content_md: '# PBI-plan' } }] }])
    fetchFile.mockResolvedValue('# Repo-plan')
    const out: any = await resolvePrLinkedPlan(JOB_P, { body: 'PBI-4, zie `docs/plans/x.md`', head_sha: SHA })
    expect(out.plan_docs).toStrictEqual([
      { ref: 'docs/plans/x.md', content_md: '# Repo-plan', truncated: false },
      { ref: 'PBI-4', content_md: '# PBI-plan', truncated: false },
    ])
    expect(out.references).toStrictEqual(['PBI-4', 'docs/plans/x.md'])
    expect(fetchFile).toHaveBeenCalledWith({ prUrl: JOB.pr_url, path: 'docs/plans/x.md', ref: SHA })
    expect(findManyPbi.mock.calls[0][0].where).toMatchObject({ product_id: 'prod-1', code: { in: ['PBI-4'] } })
  })

  it('zonder head_sha wordt geen pad opgehaald', async () => {
    findManyStory.mockResolvedValue([story('ST-1', 'AC1')])
    await resolvePrLinkedPlan(JOB_P, { body: 'ST-1 docs/plans/x.md', head_sha: null })
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('onbekende codes of lege inhoud → door naar route B', async () => {
    findManyStory.mockResolvedValue([story('ST-1', null, [task('T-1', null)])])
    listShas.mockResolvedValue([SHA])
    findManyLog.mockResolvedValue([{ story: story('ST-9', 'AC9') }])
    const out: any = await resolvePrLinkedPlan(JOB_P, { body: 'ST-1 ST-404', head_sha: SHA })
    expect(out.source).toBe('commits')
    expect(out.references).toStrictEqual(['ST-9'])
  })

  it('Forgejo-fout bij een pad → pad overgeslagen, geen throw', async () => {
    findManyStory.mockResolvedValue([story('ST-1', 'AC1')])
    fetchFile.mockRejectedValue(new Error('boom'))
    const out: any = await resolvePrLinkedPlan(JOB_P, { body: 'ST-1 docs/plans/x.md', head_sha: SHA })
    expect(out.source).toBe('pr_refs')
    expect(out.plan_docs).toStrictEqual([])
  })

  it('DB-fout in route A → route B, geen throw', async () => {
    findManyStory.mockRejectedValue(new Error('db down'))
    listShas.mockResolvedValue([SHA])
    findManyLog.mockResolvedValue([{ story: story('ST-9', 'AC9') }])
    const out: any = await resolvePrLinkedPlan(JOB_P, { body: 'ST-1', head_sha: SHA })
    expect(out.source).toBe('commits')
  })
})

describe('route B — commit-hashes', () => {
  it('zoekt op prefixen van 7 tot 40 tekens binnen het product', async () => {
    listShas.mockResolvedValue([SHA])
    findManyLog.mockResolvedValue([{ story: story('ST-9', 'AC9', [task('T-9', 'P9')]) }])
    const out = await resolvePrLinkedPlan(JOB_P, { body: '', head_sha: SHA })
    expect(out).toStrictEqual({
      source: 'commits',
      references: ['ST-9'],
      stories: [{ code: 'ST-9', title: 'story ST-9', acceptance_criteria: 'AC9', tasks: [{ code: 'T-9', title: 'titel T-9', implementation_plan: 'P9' }] }],
      plan_docs: [],
      omitted: [],
    })
    const where = findManyLog.mock.calls[0][0].where
    expect(where.type).toBe('COMMIT')
    expect(where.story).toStrictEqual({ product_id: 'prod-1' })
    expect(where.commit_hash.in).toContain(SHA.slice(0, 7))
    expect(where.commit_hash.in).toContain(SHA)
    expect(where.commit_hash.in).not.toContain(SHA.slice(0, 6))
  })

  it('dezelfde story via meerdere commits telt één keer', async () => {
    listShas.mockResolvedValue([SHA, 'b'.repeat(40)])
    findManyLog.mockResolvedValue([{ story: story('ST-9', 'AC9') }, { story: story('ST-9', 'AC9') }])
    const out: any = await resolvePlanViaCommits(JOB_P)
    expect(out.stories).toHaveLength(1)
  })

  it('Forgejo-fout → null, geen throw', async () => {
    listShas.mockResolvedValue({ error: 'boom' })
    expect(await resolvePrLinkedPlan(JOB_P, { body: '', head_sha: SHA })).toBeNull()
    expect(findManyLog).not.toHaveBeenCalled()
  })
})

describe('totaalbudget voor A en B', () => {
  // Tekst met regeleinden en aanhalingstekens: escaping maakt de JSON langer dan de tekst.
  const long = (n: number) => 'regel met "quotes"\n'.repeat(Math.ceil(n / 20)).slice(0, n)

  it('blijft binnen het budget, vult in vaste volgorde en meldt wat wegviel', async () => {
    findManyStory.mockResolvedValue([
      story('ST-1', long(30_000), [task('T-11', long(30_000)), task('T-12', long(30_000))]),
      story('ST-2', long(30_000), [task('T-21', long(30_000))]),
    ])
    findManyTask.mockResolvedValue([{ ...task('T-12', long(30_000)), story: { code: 'ST-1', title: 'story ST-1', acceptance_criteria: long(30_000) } }])
    fetchFile.mockResolvedValue(long(30_000))
    const body = 'ST-1 ST-2 T-12 docs/plans/a.md docs/plans/b.md docs/specs/c.md'
    const out: any = await resolvePrLinkedPlan(JOB_P, { body, head_sha: SHA })

    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LINKED_PLAN_BUDGET)
    // 1: acceptatiecriteria van beide stories eerst, afgekapt op 20 000 met markering
    expect(out.stories.map((s: any) => s.code)).toStrictEqual(['ST-1', 'ST-2'])
    expect(out.stories[0].acceptance_criteria.endsWith('…[afgekapt]')).toBe(true)
    // 2: de expliciet genoemde taak T-12 staat erin, vóór de overige taken
    expect(out.stories[0].tasks.map((t: any) => t.code)).toContain('T-12')
    // de rest past niet: docs en/of overige taken staan in omitted
    expect(out.omitted.length).toBeGreaterThan(0)
    expect(out.omitted).toContain('T-21')
  })

  it('haalt geen plan-docs meer op als het budget op is', async () => {
    const stories = Array.from({ length: 8 }, (_, i) => story(`ST-${i + 1}`, long(20_000)))
    findManyStory.mockResolvedValue(stories)
    fetchFile.mockResolvedValue('# plan')
    const body = stories.map((s) => s.code).join(' ') + ' docs/plans/a.md'
    const out: any = await resolvePrLinkedPlan(JOB_P, { body, head_sha: SHA })
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LINKED_PLAN_BUDGET)
    expect(fetchFile).not.toHaveBeenCalled()
    expect(out.omitted).toContain('docs/plans/a.md')
  })
})

describe('review-bevindingen #183', () => {
  it('alleen witruimte in acceptatiecriteria en taakplannen telt niet als inhoud → route B', async () => {
    findManyStory.mockResolvedValue([story('ST-1', '   \n', [task('T-1', ' \n\t')])])
    listShas.mockResolvedValue([SHA])
    findManyLog.mockResolvedValue([{ story: story('ST-9', 'AC9') }])
    const out: any = await resolvePrLinkedPlan(JOB_P, { body: 'ST-1', head_sha: SHA })
    expect(out.source).toBe('commits')
  })

  it('na het eerste item dat niet past gaat alles daarna naar omitted, ook een kort item', async () => {
    const ac = 'x'.repeat(19_855)
    const stories = Array.from({ length: 5 }, (_, i) => story(`ST-${i + 1}`, ac))
    stories[4] = story('ST-5', ac, [task('T-1', 'p'.repeat(1_000)), task('T-2', 'short')])
    findManyStory.mockResolvedValue(stories)
    const out: any = await resolvePrLinkedPlan(JOB_P, { body: stories.map((s) => s.code).join(' '), head_sha: SHA })
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LINKED_PLAN_BUDGET)
    const placed = out.stories.flatMap((s: any) => s.tasks.map((t: any) => t.code))
    expect(placed).not.toContain('T-2')
    expect(out.omitted).toStrictEqual(expect.arrayContaining(['T-1', 'T-2']))
  })
})

describe('ST-053 Taak 1 — productscope en SHA-context', () => {
  it('candidateProductIds: alleen eigen producten van de gebruiker, zonder het eigen product', async () => {
    findManyProduct.mockResolvedValue([{ id: 'p2' }, { id: 'p3' }])
    expect(await candidateProductIds('u1', 'prod-1')).toStrictEqual(['p2', 'p3'])
    // Eigenaarschap via Product.user_id; lidmaatschap (members) telt bewust niet mee.
    expect(findManyProduct.mock.calls[0][0].where).toStrictEqual({ user_id: 'u1', id: { not: 'prod-1' } })
  })

  it('candidateProductIds: een gescoped token beperkt tot de toegestane producten; [] = geen beperking', async () => {
    findManyProduct.mockResolvedValue([{ id: 'p2' }, { id: 'p3' }])
    tokenScope.mockResolvedValue(['p3', 'p-ander'])
    expect(await candidateProductIds('u1', 'prod-1')).toStrictEqual(['p3'])
    tokenScope.mockResolvedValue([])
    expect(await candidateProductIds('u1', 'prod-1')).toStrictEqual(['p2', 'p3'])
  })

  it('de commit-SHA\'s worden per resolve hooguit één keer opgehaald', async () => {
    listShas.mockResolvedValue([SHA])
    const ctx = createResolveContext(JOB.pr_url)
    expect(await ctx.shas()).toStrictEqual([SHA])
    expect(await ctx.shas()).toStrictEqual([SHA])
    expect(listShas).toHaveBeenCalledTimes(1)
  })

  it('B binnen het eigen product gebruikt de gedeelde SHA-context', async () => {
    listShas.mockResolvedValue([SHA])
    const ctx = createResolveContext(JOB.pr_url)
    await ctx.shas()
    await resolvePlanViaCommits(JOB_P, ctx)
    expect(listShas).toHaveBeenCalledTimes(1)
  })
})
