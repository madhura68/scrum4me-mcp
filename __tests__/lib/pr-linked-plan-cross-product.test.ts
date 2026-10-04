import { describe, it, expect, vi, beforeEach } from 'vitest'

// Kleine nep-database die Prisma's `where`/`select` voor de gebruikte vormen nabootst,
// zodat een veld dat niet geselecteerd is ook niet in de output kan lekken.
type P = { id: string; name: string; user_id: string }
type S = { id: string; code: string; title: string; acceptance_criteria: string | null; product_id: string; pbi_id?: string }
type T = { id: string; code: string; title: string; implementation_plan: string | null; repo_url: string | null; product_id: string; story_id: string; sort_order: number }
type L = { story_id: string; commit_hash: string; created_at: number }
type B = { id: string; code: string; product_id: string; plan_md?: string }
const db: { products: P[]; stories: S[]; tasks: T[]; logs: L[]; pbis: B[] } = { products: [], stories: [], tasks: [], logs: [], pbis: [] }

const matchVal = (v: any, cond: any): boolean => {
  if (cond === undefined) return true
  if (cond && typeof cond === 'object') {
    if ('in' in cond && !cond.in.includes(v)) return false
    if ('not' in cond && v === cond.not) return false
    return true
  }
  return v === cond
}
const productOf = (id: string) => db.products.find((p) => p.id === id)!
const storyOf = (id: string) => db.stories.find((s) => s.id === id)!
function pick(kind: 'story' | 'task' | 'pbi' | 'product', row: any, select: any): any {
  const out: any = {}
  for (const [k, v] of Object.entries(select)) {
    if (v === true) { out[k] = row[k]; continue }
    const sub = (v as any).select
    if (kind === 'story' && k === 'tasks') {
      out[k] = db.tasks.filter((t) => t.story_id === row.id).sort((a, b) => a.sort_order - b.sort_order).map((t) => pick('task', t, sub))
    } else if (k === 'product') {
      out[k] = pick('product', productOf(row.product_id), sub)
    } else if (kind === 'task' && k === 'story') {
      out[k] = pick('story', storyOf(row.story_id), sub)
    } else if (kind === 'pbi' && k === 'docs') {
      out[k] = row.plan_md ? [{ doc_revision: { content_md: row.plan_md } }] : []
    } else throw new Error(`fake: onbekende relatie ${kind}.${k}`)
  }
  return out
}
const where = (row: any, w: any) => Object.entries(w).every(([k, c]) => matchVal(row[k], c))

vi.mock('../../src/prisma.js', () => ({
  prisma: {
    claudeJob: { findFirst: async () => null },
    pbi: {
      findFirst: async () => null,
      findMany: async (a: any) => db.pbis.filter((r) => where(r, a.where)).map((r) => pick('pbi', r, a.select)),
    },
    sprintTaskExecution: { findMany: async () => [] },
    product: { findMany: async (a: any) => db.products.filter((r) => where(r, a.where)).map((r) => pick('product', r, a.select)) },
    story: { findMany: async (a: any) => db.stories.filter((r) => where(r, a.where)).map((r) => pick('story', r, a.select)) },
    task: { findMany: async (a: any) => db.tasks.filter((r) => where(r, a.where)).map((r) => pick('task', r, a.select)) },
    storyLog: {
      findMany: async (a: any) => {
        const w = a.where
        return db.logs
          .filter((l) => matchVal(l.commit_hash, w.commit_hash) && matchVal(l.story_id, w.story_id))
          .filter((l) => !w.story || matchVal(storyOf(l.story_id).product_id, w.story.product_id))
          .sort((x, y) => x.created_at - y.created_at)
          .map((l) => (a.select.story ? { story: pick('story', storyOf(l.story_id), a.select.story.select) } : { story_id: l.story_id }))
      },
    },
  },
}))

const listShas = vi.fn()
vi.mock('../../src/git/pr.js', () => ({
  listPullRequestCommitShas: (...a: any[]) => listShas(...a),
  fetchRepoFileAtRef: async () => ({ error: 'not found' }),
}))
const tokenScope = vi.fn()
vi.mock('../../src/auth.js', () => ({ getTokenScopedProducts: (...a: any[]) => tokenScope(...a) }))

import { resolvePrLinkedPlan, pickMatch, LINKED_PLAN_BUDGET } from '../../src/lib/pr-linked-plan.js'

const PR_URL = 'https://git.jp-visser.nl/janpeter/scrum4me-mcp/pulls/180'
const JOB = { id: 'review', pr_url: PR_URL, product_id: 'mcp', user_id: 'jp' }
const SHA1 = '1'.repeat(40)
const SHA2 = '2'.repeat(40)

function seed() {
  db.products = [
    { id: 'mcp', name: 'scrum4me-mcp', user_id: 'jp' },
    { id: 's4m', name: 'Scrum4Me', user_id: 'jp' },
    { id: 'ops', name: 'Ops Dashboard', user_id: 'jp' },
    { id: 'demo', name: 'Demo', user_id: 'iemand-anders' },
  ]
  db.stories = []
  db.tasks = []
  db.logs = []
  db.pbis = []
}
const story = (id: string, code: string, product_id: string, ac: string | null = `AC ${code}`) =>
  db.stories.push({ id, code, title: `story ${code}`, acceptance_criteria: ac, product_id })
const task = (id: string, code: string, product_id: string, story_id: string, opts: Partial<T> = {}) =>
  db.tasks.push({ id, code, title: `taak ${code}`, implementation_plan: `plan ${code}`, repo_url: null, product_id, story_id, sort_order: db.tasks.length, ...opts })

beforeEach(() => {
  seed()
  listShas.mockReset()
  listShas.mockResolvedValue([])
  tokenScope.mockReset()
  tokenScope.mockResolvedValue([])
})

describe('volgorde: het eigen product gaat vóór', () => {
  it('commit in het eigen product én een code die alleen elders bestaat → B(eigen), byte-gelijk', async () => {
    story('s-own', 'ST-5', 'mcp')
    task('t-own', 'T-5', 'mcp', 's-own')
    db.logs.push({ story_id: 's-own', commit_hash: SHA1.slice(0, 7), created_at: 1 })
    story('s-x', 'ST-1622', 's4m')
    task('t-x', 'T-1972', 's4m', 's-x')
    listShas.mockResolvedValue([SHA1])
    const out = await resolvePrLinkedPlan(JOB, { body: 'Zie T-1972', head_sha: SHA1 })
    expect(out).toStrictEqual({
      source: 'commits',
      references: ['ST-5'],
      stories: [{ code: 'ST-5', title: 'story ST-5', acceptance_criteria: 'AC ST-5', tasks: [{ code: 'T-5', title: 'taak T-5', implementation_plan: 'plan T-5' }] }],
      plan_docs: [],
      omitted: [],
    })
  })

  it('zonder user_id worden A× en B× overgeslagen (gedrag = ST-052)', async () => {
    story('s-x', 'ST-1622', 's4m')
    task('t-x', 'T-1972', 's4m', 's-x')
    const { user_id: _u, ...noUser } = JOB
    expect(await resolvePrLinkedPlan(noUser, { body: 'T-1972', head_sha: SHA1 })).toBeNull()
  })

  it('de kandidaat-lookup gooit → B(eigen) blijft, en zonder B(eigen) gewoon null', async () => {
    story('s-own', 'ST-5', 'mcp')
    db.logs.push({ story_id: 's-own', commit_hash: SHA1, created_at: 1 })
    listShas.mockResolvedValue([SHA1])
    tokenScope.mockRejectedValue(new Error('token-db weg'))
    const out: any = await resolvePrLinkedPlan(JOB, { body: '', head_sha: SHA1 })
    expect(out.references).toStrictEqual(['ST-5'])
    db.logs = []
    expect(await resolvePrLinkedPlan(JOB, { body: '', head_sha: SHA1 })).toBeNull()
  })

  it('de SHA\'s worden voor B(eigen), A× en B× samen één keer opgehaald', async () => {
    story('s-x', 'ST-9', 's4m')
    db.logs.push({ story_id: 's-x', commit_hash: SHA1, created_at: 1 })
    listShas.mockResolvedValue([SHA1])
    await resolvePrLinkedPlan(JOB, { body: 'ST-404', head_sha: SHA1 })
    expect(listShas).toHaveBeenCalledTimes(1)
  })
})

describe('A× — codes in andere producten', () => {
  it('unieke match → plan met herkomst', async () => {
    story('s-x', 'ST-1622', 's4m')
    task('t-x', 'T-1972', 's4m', 's-x')
    task('t-x2', 'T-1971', 's4m', 's-x')
    const out = await resolvePrLinkedPlan(JOB, { body: 'Werk voor T-1972.', head_sha: SHA1 })
    expect(out).toStrictEqual({
      source: 'pr_refs',
      references: ['T-1972 (Scrum4Me)'],
      stories: [{
        code: 'ST-1622', title: 'story ST-1622', product: 'Scrum4Me', acceptance_criteria: 'AC ST-1622',
        tasks: [{ code: 'T-1972', title: 'taak T-1972', implementation_plan: 'plan T-1972' }],
      }],
      plan_docs: [],
      omitted: [],
    })
  })

  it('twee matches, één met repo_url = repo van de PR (https) → die ene', async () => {
    story('s-a', 'ST-1', 's4m'); task('t-a', 'T-77', 's4m', 's-a', { repo_url: 'https://git.jp-visser.nl/janpeter/scrum4me-mcp.git' })
    story('s-b', 'ST-1', 'ops'); task('t-b', 'T-77', 'ops', 's-b')
    const out: any = await resolvePrLinkedPlan(JOB, { body: 'T-77', head_sha: SHA1 })
    expect(out.references).toStrictEqual(['T-77 (Scrum4Me)'])
  })

  it('twee matches, één met een SSH-repo_url naar dezelfde repo → die ene', async () => {
    story('s-a', 'ST-1', 's4m'); task('t-a', 'T-77', 's4m', 's-a')
    story('s-b', 'ST-1', 'ops'); task('t-b', 'T-77', 'ops', 's-b', { repo_url: 'git@git.jp-visser.nl:janpeter/scrum4me-mcp.git' })
    const out: any = await resolvePrLinkedPlan(JOB, { body: 'T-77', head_sha: SHA1 })
    expect(out.references).toStrictEqual(['T-77 (Ops Dashboard)'])
  })

  it('twee matches, één met een PR-commit in zijn story_logs → die ene', async () => {
    story('s-a', 'ST-2', 's4m')
    story('s-b', 'ST-2', 'ops')
    db.logs.push({ story_id: 's-b', commit_hash: SHA2, created_at: 1 })
    listShas.mockResolvedValue([SHA2])
    const out: any = await resolvePrLinkedPlan(JOB, { body: 'ST-2', head_sha: SHA2 })
    expect(out.source).toBe('pr_refs')
    expect(out.references).toStrictEqual(['ST-2 (Ops Dashboard)'])
  })

  it('twee matches zonder signaal → code vervalt, door naar B×', async () => {
    story('s-a', 'ST-3', 's4m')
    story('s-b', 'ST-3', 'ops')
    story('s-c', 'ST-8', 's4m')
    db.logs.push({ story_id: 's-c', commit_hash: SHA1, created_at: 1 })
    listShas.mockResolvedValue([SHA1])
    const out: any = await resolvePrLinkedPlan(JOB, { body: 'ST-3', head_sha: SHA1 })
    expect(out.source).toBe('commits')
    expect(out.references).toStrictEqual(['ST-8 (Scrum4Me)'])
  })

  it('een code die in het eigen product bestaat wordt niet elders gezocht', async () => {
    story('s-own', 'ST-4', 'mcp', null)
    story('s-x', 'ST-4', 's4m')
    expect(await resolvePrLinkedPlan(JOB, { body: 'ST-4', head_sha: SHA1 })).toBeNull()
  })

  it('een product van een andere eigenaar telt niet mee', async () => {
    story('s-d', 'ST-6', 'demo')
    db.logs.push({ story_id: 's-d', commit_hash: SHA1, created_at: 1 })
    listShas.mockResolvedValue([SHA1])
    expect(await resolvePrLinkedPlan(JOB, { body: 'ST-6', head_sha: SHA1 })).toBeNull()
  })

  it('een gescoped token sluit een eigen product uit', async () => {
    story('s-x', 'ST-7', 's4m')
    tokenScope.mockResolvedValue(['ops'])
    expect(await resolvePrLinkedPlan(JOB, { body: 'ST-7', head_sha: SHA1 })).toBeNull()
  })

  it('unieke taakcodes onder dezelfde storycode in twee producten worden niet gemengd', async () => {
    story('s-a', 'ST-1', 's4m'); task('t-a', 'T-501', 's4m', 's-a')
    story('s-b', 'ST-1', 'ops'); task('t-b', 'T-502', 'ops', 's-b')
    const out: any = await resolvePrLinkedPlan(JOB, { body: 'T-501 en T-502', head_sha: SHA1 })
    expect(out.stories).toStrictEqual([
      { code: 'ST-1', title: 'story ST-1', product: 'Scrum4Me', acceptance_criteria: 'AC ST-1', tasks: [{ code: 'T-501', title: 'taak T-501', implementation_plan: 'plan T-501' }] },
      { code: 'ST-1', title: 'story ST-1', product: 'Ops Dashboard', acceptance_criteria: 'AC ST-1', tasks: [{ code: 'T-502', title: 'taak T-502', implementation_plan: 'plan T-502' }] },
    ])
    expect(out.references).toStrictEqual(['T-501 (Scrum4Me)', 'T-502 (Ops Dashboard)'])
  })

  it('PBI-code levert het PLAN-document met herkomst', async () => {
    db.pbis.push({ id: 'p-x', code: 'PBI-175', product_id: 's4m', plan_md: '# plan PBI-175' })
    const out: any = await resolvePrLinkedPlan(JOB, { body: 'PBI-175', head_sha: SHA1 })
    expect(out.plan_docs).toStrictEqual([{ ref: 'PBI-175 (Scrum4Me)', content_md: '# plan PBI-175', truncated: false }])
    expect(out.references).toStrictEqual(['PBI-175 (Scrum4Me)'])
  })
})

describe('B× — commits in andere producten', () => {
  it('dezelfde storycode in twee producten met elk een PR-commit → twee stories, niet gemengd', async () => {
    story('s-a', 'ST-1', 's4m'); task('t-a', 'T-1', 's4m', 's-a')
    story('s-b', 'ST-1', 'ops'); task('t-b', 'T-1', 'ops', 's-b', { implementation_plan: 'ander plan' })
    db.logs.push({ story_id: 's-a', commit_hash: SHA1, created_at: 1 }, { story_id: 's-b', commit_hash: SHA2, created_at: 2 })
    listShas.mockResolvedValue([SHA1, SHA2])
    const out: any = await resolvePrLinkedPlan(JOB, { body: '', head_sha: SHA2 })
    expect(out.source).toBe('commits')
    expect(out.stories).toStrictEqual([
      { code: 'ST-1', title: 'story ST-1', product: 'Scrum4Me', acceptance_criteria: 'AC ST-1', tasks: [{ code: 'T-1', title: 'taak T-1', implementation_plan: 'plan T-1' }] },
      { code: 'ST-1', title: 'story ST-1', product: 'Ops Dashboard', acceptance_criteria: 'AC ST-1', tasks: [{ code: 'T-1', title: 'taak T-1', implementation_plan: 'ander plan' }] },
    ])
    expect(out.references).toStrictEqual(['ST-1 (Scrum4Me)', 'ST-1 (Ops Dashboard)'])
  })

  it('lange productnamen in de labels blijven binnen het budget', async () => {
    const long = 'P'.repeat(150)
    db.products.push({ id: 'lang', name: long, user_id: 'jp' })
    for (let i = 0; i < 8; i++) {
      story(`s${i}`, `ST-${i}`, 'lang', 'x'.repeat(20_000))
      for (let j = 0; j < 8; j++) task(`t${i}-${j}`, `T-${i}${j}`, 'lang', `s${i}`, { implementation_plan: 'y\n"'.repeat(7_000) })
      db.logs.push({ story_id: `s${i}`, commit_hash: SHA1, created_at: i })
    }
    listShas.mockResolvedValue([SHA1])
    const out: any = await resolvePrLinkedPlan(JOB, { body: '', head_sha: SHA1 })
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LINKED_PLAN_BUDGET)
    expect(out.omitted.length).toBeGreaterThan(0)
    expect(out.omitted[0]).toContain(`(${long})`)
  })
})

describe('K1 — beslisfunctie', () => {
  const m = (id: string, signal: boolean) => ({ id, signal })
  it('ja: een unieke match zonder signaal wordt gebruikt', () => {
    expect(pickMatch([m('a', false)], (x) => x.signal, true)).toStrictEqual(m('a', false))
  })
  it('nee: een unieke match zonder signaal vervalt, met signaal blijft hij', () => {
    expect(pickMatch([m('a', false)], (x) => x.signal, false)).toBeNull()
    expect(pickMatch([m('a', true)], (x) => x.signal, false)).toStrictEqual(m('a', true))
  })
  it('meerdere matches: alleen precies één met signaal telt', () => {
    expect(pickMatch([m('a', true), m('b', false)], (x) => x.signal, true)).toStrictEqual(m('a', true))
    expect(pickMatch([m('a', true), m('b', true)], (x) => x.signal, true)).toBeNull()
    expect(pickMatch([m('a', false), m('b', false)], (x) => x.signal, true)).toBeNull()
  })
})
