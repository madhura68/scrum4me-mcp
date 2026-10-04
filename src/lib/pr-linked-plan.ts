import { prisma } from '../prisma.js'
import { fetchRepoFileAtRef, listPullRequestCommitShas } from '../git/pr.js'
import { extractPrRefs } from './pr-refs.js'

export type LinkedPlanTask = { code: string; title: string; implementation_plan: string | null }
export type LinkedPlanStory = {
  code: string
  title: string
  acceptance_criteria: string | null
  tasks: LinkedPlanTask[]
}
export type LinkedPlanDoc = { ref: string; content_md: string; truncated: boolean }

export type LinkedPlan = {
  source: 'job' | 'pbi' | 'pr_refs' | 'commits'
  plan_md?: string | null
  acceptance_criteria?: string | null
  plan_snapshot?: string | null
  /** SPRINT_IMPLEMENTATION: per-task frozen snapshots uit SprintTaskExecution. */
  sprint_tasks?: Array<{
    task_title: string | null
    plan_snapshot: string | null
    acceptance_criteria: string | null
  }>
  /** Routes pr_refs/commits: stories met acceptatiecriteria en taakplannen. */
  stories?: LinkedPlanStory[]
  /** Routes pr_refs/commits: planbestanden (pad) en PBI-plannen (code). */
  plan_docs?: LinkedPlanDoc[]
  /** Routes pr_refs/commits: wat er gekoppeld is, zodat de reviewer het kan noemen. */
  references?: string[]
  /** Routes pr_refs/commits: verwijzingen die door het budget zijn weggevallen. */
  omitted?: string[]
}

export type PrContext = { body: string; head_sha: string | null }
type ReviewJob = { id: string; pr_url: string | null; product_id?: string }

/**
 * Resolve het plan/acceptatie dat bij een PR hoort, voor een PR_REVIEW-job.
 * Sluit de huidige review-job uit (zelfde pr_url, self-match) en filtert op
 * implementatie-dragers; valt terug op de PBI-plan-doc (PbiDoc role=PLAN);
 * anders null → de review draait op diff + product-docs.
 */
export async function resolvePrLinkedPlan(
  job: ReviewJob,
  pr?: PrContext,
): Promise<LinkedPlan | null> {
  if (!job.pr_url) return null

  const impl = await prisma.claudeJob.findFirst({
    where: {
      pr_url: job.pr_url,
      id: { not: job.id },
      OR: [
        { kind: 'TASK_IMPLEMENTATION', task_id: { not: null } },
        { kind: 'SPRINT_IMPLEMENTATION', sprint_run_id: { not: null } },
      ],
    },
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      kind: true,
      plan_snapshot: true,
      task: {
        select: {
          implementation_plan: true,
          story: { select: { acceptance_criteria: true } },
        },
      },
    },
  })

  if (impl) {
    if (impl.kind === 'SPRINT_IMPLEMENTATION') {
      const executions = await prisma.sprintTaskExecution.findMany({
        where: { sprint_job_id: impl.id },
        orderBy: { order: 'asc' },
        select: {
          plan_snapshot: true,
          task: {
            select: {
              title: true,
              story: { select: { acceptance_criteria: true } },
            },
          },
        },
      })
      if (executions.length > 0) {
        return {
          source: 'job',
          sprint_tasks: executions.map((e) => ({
            task_title: e.task?.title ?? null,
            plan_snapshot: e.plan_snapshot ?? null,
            acceptance_criteria: e.task?.story?.acceptance_criteria ?? null,
          })),
        }
      }
      // geen executions → val door naar de bestaande task-velden-check / PBI-fallback
    }

    const acceptance = impl.task?.story?.acceptance_criteria ?? null
    const planMd = impl.task?.implementation_plan ?? null
    if (impl.plan_snapshot || planMd || acceptance) {
      return {
        source: 'job',
        plan_snapshot: impl.plan_snapshot ?? null,
        plan_md: planMd,
        acceptance_criteria: acceptance,
      }
    }
  }

  // Pbi heeft geen plan_md-kolom; plan-content hangt via PbiDoc(role=PLAN)
  // aan een ProductDocRevision.
  const pbi = await prisma.pbi.findFirst({
    where: { pr_url: job.pr_url },
    select: {
      id: true,
      docs: {
        where: { role: 'PLAN' },
        orderBy: { created_at: 'desc' },
        take: 1,
        select: { doc_revision: { select: { content_md: true } } },
      },
    },
  })
  const pbiPlanMd = pbi?.docs[0]?.doc_revision?.content_md ?? null
  if (pbi && pbiPlanMd) {
    return { source: 'pbi', plan_md: pbiPlanMd }
  }

  if (!pr || !job.product_id) return null
  return (await resolvePlanViaPrRefs(job, pr)) ?? (await resolvePlanViaCommits(job))
}

// ---------------------------------------------------------------------------
// Routes A (PR-beschrijving) en B (commit-hashes). Beide best-effort: een
// DB- of Forgejo-fout geeft null, zodat de volgende route het overneemt.
// ---------------------------------------------------------------------------

/** Maximale lengte van `JSON.stringify(linked_plan)` voor de routes A en B. */
export const LINKED_PLAN_BUDGET = 100_000
const FIELD_MAX = 20_000
const MARKER = '…[afgekapt]'
const MIN_USEFUL = 200

const taskSelect = { code: true, title: true, implementation_plan: true } as const
const storySelect = {
  code: true,
  title: true,
  acceptance_criteria: true,
  tasks: { select: taskSelect, orderBy: { sort_order: 'asc' } },
} as const

type StoryRow = LinkedPlanStory
type DocSource = { ref: string; load: () => Promise<string | null> }
type Collected = {
  stories: StoryRow[]
  /** Codes van taken die de beschrijving zelf noemt; die krijgen voorrang. */
  explicitTasks: Set<string>
  docs: DocSource[]
  /** Gevonden codes in volgorde van de beschrijving; die geplaatst worden gaan naar `references`. */
  codeRefs: string[]
}

export async function resolvePlanViaPrRefs(job: ReviewJob, pr: PrContext): Promise<LinkedPlan | null> {
  if (!job.pr_url || !job.product_id) return null
  const prUrl = job.pr_url
  const productId = job.product_id
  const refs = extractPrRefs(pr.body)
  if (!refs.task_codes.length && !refs.story_codes.length && !refs.pbi_codes.length && !refs.doc_paths.length) {
    return null
  }
  try {
    const [stories, tasks, pbis] = await Promise.all([
      refs.story_codes.length
        ? prisma.story.findMany({ where: { product_id: productId, code: { in: refs.story_codes } }, select: storySelect })
        : [],
      refs.task_codes.length
        ? prisma.task.findMany({
            where: { product_id: productId, code: { in: refs.task_codes } },
            select: { ...taskSelect, story: { select: { code: true, title: true, acceptance_criteria: true } } },
          })
        : [],
      refs.pbi_codes.length
        ? prisma.pbi.findMany({
            where: { product_id: productId, code: { in: refs.pbi_codes } },
            select: {
              code: true,
              docs: {
                where: { role: 'PLAN' },
                orderBy: { created_at: 'desc' },
                take: 1,
                select: { doc_revision: { select: { content_md: true } } },
              },
            },
          })
        : [],
    ])

    const byCode = new Map<string, StoryRow>()
    for (const code of refs.story_codes) {
      const found = stories.find((s) => s.code === code)
      if (found) byCode.set(code, { ...found, tasks: [...found.tasks] })
    }
    const explicitTasks = new Set<string>()
    for (const code of refs.task_codes) {
      const t = tasks.find((x) => x.code === code)
      if (!t?.story) continue
      explicitTasks.add(t.code)
      const target = byCode.get(t.story.code) ?? { ...t.story, tasks: [] }
      if (!target.tasks.some((x) => x.code === t.code)) {
        target.tasks.push({ code: t.code, title: t.title, implementation_plan: t.implementation_plan })
      }
      byCode.set(t.story.code, target)
    }

    const docs: DocSource[] = []
    if (pr.head_sha) {
      const ref = pr.head_sha
      for (const path of refs.doc_paths) {
        docs.push({
          ref: path,
          load: async () => {
            const out = await fetchRepoFileAtRef({ prUrl, path, ref }).catch(() => null)
            return typeof out === 'string' && out.trim() ? out : null
          },
        })
      }
    }
    for (const code of refs.pbi_codes) {
      const md = pbis.find((p) => p.code === code)?.docs[0]?.doc_revision?.content_md
      if (md?.trim()) docs.push({ ref: code, load: async () => md })
    }

    const codeRefs = [
      ...refs.task_codes.filter((c) => explicitTasks.has(c)),
      ...refs.story_codes.filter((c) => stories.some((s) => s.code === c)),
    ]
    return await assembleWithinBudget('pr_refs', { stories: [...byCode.values()], explicitTasks, docs, codeRefs })
  } catch (err) {
    console.warn('[pr-linked-plan] route pr_refs failed:', err)
    return null
  }
}

export async function resolvePlanViaCommits(job: ReviewJob): Promise<LinkedPlan | null> {
  if (!job.pr_url || !job.product_id) return null
  try {
    const shas = await listPullRequestCommitShas({ prUrl: job.pr_url })
    if (!Array.isArray(shas) || shas.length === 0) return null
    // log_commit bewaart volledige én korte hashes (7+ tekens): match op elk prefix.
    const prefixes = new Set<string>()
    for (const sha of shas) {
      const lower = sha.toLowerCase()
      for (let n = 7; n <= lower.length; n++) prefixes.add(lower.slice(0, n))
    }
    const logs = await prisma.storyLog.findMany({
      where: { type: 'COMMIT', commit_hash: { in: [...prefixes] }, story: { product_id: job.product_id } },
      orderBy: { created_at: 'asc' },
      select: { story: { select: storySelect } },
    })
    const byCode = new Map<string, StoryRow>()
    for (const { story } of logs) {
      if (!byCode.has(story.code)) byCode.set(story.code, { ...story, tasks: [...story.tasks] })
    }
    if (byCode.size === 0) return null
    return await assembleWithinBudget('commits', {
      stories: [...byCode.values()],
      explicitTasks: new Set(),
      docs: [],
      codeRefs: [...byCode.keys()],
    })
  } catch (err) {
    console.warn('[pr-linked-plan] route commits failed:', err)
    return null
  }
}

function capField(text: string): string {
  return text.length > FIELD_MAX ? text.slice(0, FIELD_MAX) + MARKER : text
}

/**
 * Vult het resultaat in vaste volgorde binnen het budget (gemeten op de
 * geserialiseerde vorm): 1. story + acceptatiecriteria, 2. genoemde taken,
 * 3. plan-docs, 4. overige taken. Wat niet past gaat naar `omitted`.
 * Geeft null als er niets inhoudelijks in komt.
 */
async function assembleWithinBudget(source: 'pr_refs' | 'commits', c: Collected): Promise<LinkedPlan | null> {
  const plan: LinkedPlan & Required<Pick<LinkedPlan, 'stories' | 'plan_docs' | 'references' | 'omitted'>> = {
    source,
    references: [],
    stories: [],
    plan_docs: [],
    omitted: [],
  }
  // `references` en `omitted` worden pas aan het eind gevuld. Elke verwijzing komt in
  // hooguit één van beide, dus reserveer precies de ruimte van alle kandidaten samen.
  const candidates = [
    ...c.stories.flatMap((s) => [s.code, ...s.tasks.map((t) => t.code)]),
    ...c.docs.map((d) => d.ref),
  ]
  const limit = LINKED_PLAN_BUDGET - JSON.stringify(candidates).length
  const size = () => JSON.stringify(plan).length
  const omitted: string[] = []
  const docRefs: string[] = []
  // Zodra één item niet meer volledig past, gaat alles daarna naar `omitted`, ook een
  // kort item: de vulvolgorde is de prioriteit, niet wat toevallig nog past.
  let full = false

  // Zet `text` via `set` in het plan; past het niet, dan zoekt een binaire zoektocht
  // de langste prefix die nog past (escaping maakt de geserialiseerde lengte groter
  // dan de tekstlengte). Past zelfs MIN_USEFUL niet, dan draait `unset` terug.
  const fit = (set: (text: string) => void, text: string, unset: () => void, marker = MARKER): boolean => {
    if (full) {
      unset()
      return false
    }
    set(text)
    if (size() <= limit) return true
    full = true
    set(text.slice(0, MIN_USEFUL) + marker)
    if (text.length <= MIN_USEFUL || size() > limit) {
      unset()
      return false
    }
    let lo = MIN_USEFUL
    let hi = text.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      set(text.slice(0, mid) + marker)
      if (size() <= limit) lo = mid
      else hi = mid - 1
    }
    set(text.slice(0, lo) + marker)
    return true
  }

  // Een item zonder tekst (story zonder acceptatiecriteria, taak zonder plan).
  const fitBare = (unset: () => void): boolean => {
    if (!full && size() <= limit) return true
    full = true
    unset()
    return false
  }

  // 1. Stories met acceptatiecriteria.
  const placed = new Map<string, LinkedPlanStory>()
  for (const s of c.stories) {
    const entry: LinkedPlanStory = { code: s.code, title: s.title, acceptance_criteria: null, tasks: [] }
    plan.stories.push(entry)
    const ok = s.acceptance_criteria
      ? fit((t) => { entry.acceptance_criteria = t }, capField(s.acceptance_criteria), () => { plan.stories.pop() })
      : fitBare(() => { plan.stories.pop() })
    if (ok) placed.set(s.code, entry)
    else omitted.push(s.code)
  }

  const addTask = (storyCode: string, t: LinkedPlanTask) => {
    const entry = placed.get(storyCode)
    if (!entry) return omitted.push(t.code)
    const row: LinkedPlanTask = { code: t.code, title: t.title, implementation_plan: null }
    entry.tasks.push(row)
    const ok = t.implementation_plan
      ? fit((x) => { row.implementation_plan = x }, capField(t.implementation_plan), () => { entry.tasks.pop() })
      : fitBare(() => { entry.tasks.pop() })
    if (!ok) omitted.push(t.code)
  }

  // 2. Taken die de beschrijving zelf noemt.
  for (const s of c.stories) for (const t of s.tasks) if (c.explicitTasks.has(t.code)) addTask(s.code, t)

  // 3. Plan-docs, pas ophalen als ze aan de beurt zijn.
  for (const d of c.docs) {
    if (full || limit - size() < MIN_USEFUL) {
      full = true
      omitted.push(d.ref)
      continue
    }
    const content = await d.load()
    if (!content) continue
    const capped = content.length > FIELD_MAX
    const doc: LinkedPlanDoc = { ref: d.ref, content_md: '', truncated: capped }
    plan.plan_docs.push(doc)
    const base = capped ? content.slice(0, FIELD_MAX) : content
    const ok = fit(
      (t) => { doc.content_md = t; doc.truncated = capped || t !== base },
      base,
      () => { plan.plan_docs.pop() },
      '',
    )
    if (ok) docRefs.push(d.ref)
    else omitted.push(d.ref)
  }

  // 4. Overige taken van de stories.
  for (const s of c.stories) for (const t of s.tasks) if (!c.explicitTasks.has(t.code)) addTask(s.code, t)

  const hasText = (v: string | null) => Boolean(v?.trim())
  const hasContent =
    plan.plan_docs.length > 0 ||
    plan.stories.some((s) => hasText(s.acceptance_criteria) || s.tasks.some((t) => hasText(t.implementation_plan)))
  if (!hasContent) return null

  const placedTasks = new Set(plan.stories.flatMap((s) => s.tasks.map((t) => t.code)))
  plan.references = [
    ...c.codeRefs.filter((r) => placed.has(r) || placedTasks.has(r)),
    ...docRefs.filter((r) => !r.includes('/')),
    ...docRefs.filter((r) => r.includes('/')),
  ]
  plan.omitted = omitted
  return plan
}
