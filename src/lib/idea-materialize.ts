// Materialisatie-logica: idee-plan → PBI + stories + tasks.
//
// BEWUST DUPLICAAT van Scrum4Me/lib/ideas/materialize-server.ts (M20+M23) — de
// web-action én deze MCP-side-effect (submit_review APPROVED → auto-materialize)
// moeten identieke semantiek draaien. Wijzigingen in beide doorvoeren
// (parser-shape + transactie-semantiek). Zelfde patroon als de bewust-
// gedupliceerde idea-plan-parser.ts.
import type { IdeaStatus, PbiDocRole, Prisma, PrismaClient } from '@prisma/client'

import { parsePlanMd } from './idea-plan-parser.js'
import { planHasExplorationSteps } from './verify-required-guard.js'

export const MATERIALIZE_ALLOWED_FROM = ['PLAN_READY', 'PLAN_REVIEWED'] as const

export type MaterializeErrorCode =
  | 'STATUS'
  | 'NO_PRODUCT'
  | 'NO_PLAN'
  | 'PARSE'
  | 'ACTIVE_TASKS'
  | 'STALE_PLAN' // M23: plan gewijzigd ná de goedgekeurde review

export class MaterializeError extends Error {
  constructor(
    public code: MaterializeErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'MaterializeError'
  }
}

export type MaterializeResult = {
  pbi_id: string
  pbi_code: string
  story_ids: string[]
  task_ids: string[]
  product_id: string
  build_sprint_id: string | null // M23: gezet bij withBuildSprint
}

// M23: bron van de materialisatie — zie de web-duplicaat voor de rationale
// (TOCTOU-guard met legacy-fallback; pinned=false = pre-M23/PLAN_READY).
export async function resolvePlanSource(
  db: PrismaClient,
  idea: { id: string; status: IdeaStatus; plan_md: string | null; plan_doc_id: string | null },
): Promise<{ content: string; planRevisionId: string | null; pinned: boolean }> {
  const doc = idea.plan_doc_id
    ? await db.productDoc.findUnique({
        where: { id: idea.plan_doc_id },
        select: {
          current_revision_id: true,
          current_revision: { select: { id: true, content_md: true } },
        },
      })
    : null
  if (idea.status === 'PLAN_REVIEWED') {
    const approved = await db.reviewLog.findFirst({
      where: { idea_id: idea.id, kind: 'IDEA_REVIEW_PLAN', verdict: 'APPROVED' },
      orderBy: { created_at: 'desc' },
      select: { doc_revision_id: true, doc_revision: { select: { content_md: true } } },
    })
    if (!approved?.doc_revision_id || !doc) {
      const content = doc?.current_revision?.content_md ?? idea.plan_md
      if (!content) throw new MaterializeError('NO_PLAN', 'Idee heeft geen plan')
      return { content, planRevisionId: doc?.current_revision?.id ?? null, pinned: false }
    }
    if (approved.doc_revision_id !== doc.current_revision_id) {
      const norm = (v: string) => v.replace(/^last_updated:.*$/m, '')
      const current = doc.current_revision?.content_md ?? ''
      if (norm(approved.doc_revision!.content_md) !== norm(current)) {
        throw new MaterializeError(
          'STALE_PLAN',
          'Plan is gewijzigd na de goedgekeurde review — her-review nodig',
        )
      }
    }
    return {
      content: approved.doc_revision!.content_md,
      planRevisionId: approved.doc_revision_id,
      pinned: true,
    }
  }
  const content = doc?.current_revision?.content_md ?? idea.plan_md
  if (!content) throw new MaterializeError('NO_PLAN', 'Idee heeft geen plan')
  return { content, planRevisionId: doc?.current_revision?.id ?? null, pinned: false }
}

// M23: Sprint-creatie + koppeling binnen een bestaande transactie (spiegel).
export async function createBuildSprintInTx(
  tx: Prisma.TransactionClient,
  p: {
    productId: string
    ideaCode: string
    goal: string
    storyIds: string[]
    taskIds: string[]
    ideaId: string
  },
): Promise<string> {
  const today = new Date().toISOString().slice(0, 10)
  let code = `S-${today}-${p.ideaCode.toLowerCase()}`.slice(0, 30)
  const clash = await tx.sprint.findFirst({
    where: { product_id: p.productId, code },
    select: { id: true },
  })
  if (clash) code = `${code.slice(0, 26)}-${String(Date.now() % 1000).padStart(3, '0')}`
  const sprint = await tx.sprint.create({
    data: { product_id: p.productId, code, sprint_goal: p.goal, status: 'OPEN' },
    select: { id: true },
  })
  await tx.story.updateMany({
    where: { id: { in: p.storyIds } },
    data: { sprint_id: sprint.id, status: 'IN_SPRINT' },
  })
  await tx.task.updateMany({ where: { id: { in: p.taskIds } }, data: { sprint_id: sprint.id } })
  await tx.idea.update({ where: { id: p.ideaId }, data: { build_sprint_id: sprint.id } })
  return sprint.id
}

const PBI_AUTO_RE = /^PBI-(\d+)$/
const STORY_AUTO_RE = /^ST-(\d+)$/
const TASK_AUTO_RE = /^T-(\d+)$/

function nextNumber(existing: (string | null)[], re: RegExp): number {
  let max = 0
  for (const c of existing) {
    if (!c) continue
    const m = c.match(re)
    if (m) {
      const n = Number.parseInt(m[1], 10)
      if (!Number.isNaN(n) && n > max) max = n
    }
  }
  return max + 1
}

export async function materializeIdeaPlan(
  db: PrismaClient,
  params: { ideaId: string; userId: string; allowAlongside?: boolean; withBuildSprint?: boolean },
): Promise<MaterializeResult> {
  const { ideaId, userId, allowAlongside, withBuildSprint } = params

  const idea = await db.idea.findFirst({
    where: { id: ideaId, user_id: userId },
    select: {
      id: true,
      code: true,
      status: true,
      product_id: true,
      plan_md: true,
      pbi_id: true,
      plan_doc_id: true,
      spec_doc: { select: { current_revision_id: true } },
      grill_doc: { select: { current_revision_id: true } },
    },
  })
  if (!idea) {
    throw new MaterializeError('STATUS', 'Idee niet gevonden')
  }
  if (!MATERIALIZE_ALLOWED_FROM.includes(idea.status as (typeof MATERIALIZE_ALLOWED_FROM)[number])) {
    throw new MaterializeError(
      'STATUS',
      `Materialiseren alleen toegestaan in ${MATERIALIZE_ALLOWED_FROM.join(' | ')} (huidige status: ${idea.status})`,
    )
  }
  if (!idea.product_id) {
    throw new MaterializeError('NO_PRODUCT', 'Idee mist een gekoppeld product')
  }

  // M23: bron = gepinde goedgekeurde revisie (PLAN_REVIEWED) of current/plan_md.
  const planSource = await resolvePlanSource(db, idea)

  const parsed = parsePlanMd(planSource.content)
  if (!parsed.ok) {
    throw new MaterializeError('PARSE', 'plan is niet parseerbaar', parsed.errors)
  }

  // M23 PbiDoc-bronlinks (spiegel van web).
  const specApproved = await db.reviewLog.findFirst({
    where: { idea_id: ideaId, kind: 'SPEC_REVIEW', verdict: 'APPROVED' },
    orderBy: { created_at: 'desc' },
    select: { doc_revision_id: true },
  })
  const specRevisionId = specApproved?.doc_revision_id ?? idea.spec_doc?.current_revision_id ?? null
  const grillRevisionId = idea.grill_doc?.current_revision_id ?? null

  const productId = idea.product_id
  const plan = parsed.plan

  let oldPbiId: string | null = null
  if (idea.pbi_id) {
    const executedCount = await db.task.count({
      where: {
        story: { pbi_id: idea.pbi_id },
        status: { in: ['DONE', 'IN_PROGRESS'] },
      },
    })
    if (executedCount > 0 && !allowAlongside) {
      const existingPbi = await db.pbi.findUnique({
        where: { id: idea.pbi_id },
        select: { code: true },
      })
      throw new MaterializeError(
        'ACTIVE_TASKS',
        `PBI_HAS_ACTIVE_TASKS:${existingPbi?.code ?? idea.pbi_id}`,
      )
    }
    if (executedCount === 0) {
      oldPbiId = idea.pbi_id
    }
  }

  return db.$transaction(async (tx) => {
    if (oldPbiId) {
      await tx.pbi.delete({ where: { id: oldPbiId } })
    }

    const [existingPbis, existingStories, existingTasks] = await Promise.all([
      tx.pbi.findMany({ where: { product_id: productId }, select: { code: true } }),
      tx.story.findMany({ where: { product_id: productId }, select: { code: true } }),
      tx.task.findMany({ where: { product_id: productId }, select: { code: true } }),
    ])
    let nextPbiN = nextNumber(existingPbis.map((p) => p.code), PBI_AUTO_RE)
    let nextStoryN = nextNumber(existingStories.map((s) => s.code), STORY_AUTO_RE)
    let nextTaskN = nextNumber(existingTasks.map((t) => t.code), TASK_AUTO_RE)

    const lastPbi = await tx.pbi.findFirst({
      where: { product_id: productId },
      orderBy: [{ sort_order: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
      select: { sort_order: true },
    })
    const pbiSortOrder = (lastPbi?.sort_order ?? 0) + 1.0

    const pbi = await tx.pbi.create({
      data: {
        product_id: productId,
        code: `PBI-${nextPbiN++}`,
        title: plan.pbi.title,
        description: plan.pbi.description ?? null,
        priority: plan.pbi.priority,
        sort_order: pbiSortOrder,
      },
      select: { id: true, code: true },
    })

    const storyIds: string[] = []
    const taskIds: string[] = []
    const downgradedCodes: string[] = []

    for (let si = 0; si < plan.stories.length; si++) {
      const s = plan.stories[si]
      const storyCode = `ST-${String(nextStoryN++).padStart(3, '0')}`
      const story = await tx.story.create({
        data: {
          pbi_id: pbi.id,
          product_id: productId,
          code: storyCode,
          title: s.title,
          description: s.description ?? null,
          acceptance_criteria: s.acceptance_criteria ?? null,
          priority: s.priority,
          sort_order: si + 1,
          status: 'OPEN',
        },
        select: { id: true },
      })
      storyIds.push(story.id)

      for (let ti = 0; ti < s.tasks.length; ti++) {
        const t = s.tasks[ti]
        const taskCode = `T-${nextTaskN++}`
        // Exploration-guard (IDEA-139, spiegel van web): strikt-ALIGNED met
        // verkenningsstappen → ALIGNED_OR_PARTIAL.
        const requested = t.verify_required ?? 'ALIGNED_OR_PARTIAL'
        const effectiveVerifyRequired =
          requested === 'ALIGNED' && planHasExplorationSteps(t.implementation_plan ?? null)
            ? 'ALIGNED_OR_PARTIAL'
            : requested
        if (effectiveVerifyRequired !== requested) downgradedCodes.push(taskCode)
        const task = await tx.task.create({
          data: {
            story_id: story.id,
            product_id: productId,
            code: taskCode,
            title: t.title,
            description: t.description ?? null,
            implementation_plan: t.implementation_plan ?? null,
            priority: s.priority,
            sort_order: ti + 1,
            status: 'TO_DO',
            verify_required: effectiveVerifyRequired,
            verify_only: t.verify_only ?? false,
          },
          select: { id: true },
        })
        taskIds.push(task.id)
      }
    }

    await tx.idea.update({
      where: { id: ideaId },
      data: { pbi_id: pbi.id, status: 'PLANNED' },
    })

    // M23: bronlinks SPEC/PLAN/GRILL (spiegel van web).
    const docLinks: { role: PbiDocRole; doc_revision_id: string }[] = []
    if (planSource.planRevisionId) docLinks.push({ role: 'PLAN', doc_revision_id: planSource.planRevisionId })
    if (specRevisionId) docLinks.push({ role: 'SPEC', doc_revision_id: specRevisionId })
    if (grillRevisionId) docLinks.push({ role: 'GRILL', doc_revision_id: grillRevisionId })
    if (docLinks.length > 0) {
      await tx.pbiDoc.createMany({
        data: docLinks.map((l) => ({
          pbi_id: pbi.id,
          doc_revision_id: l.doc_revision_id,
          role: l.role,
          created_by: userId,
        })),
      })
    }

    // M23 eindactie stap 1 (spiegel): Sprint in dezelfde transactie.
    let buildSprintId: string | null = null
    if (withBuildSprint) {
      buildSprintId = await createBuildSprintInTx(tx, {
        productId,
        ideaCode: idea.code,
        goal: plan.sprint?.goal ?? plan.pbi.title,
        storyIds,
        taskIds,
        ideaId,
      })
    }

    const baseContent = `Materialized into ${pbi.code} (${plan.stories.length} stories, ${taskIds.length} tasks)`
    const content =
      downgradedCodes.length > 0
        ? `${baseContent}\nAuto-versoepeld: ${downgradedCodes.length} taak(en) met verkenningsstappen op ALIGNED_OR_PARTIAL gezet (${downgradedCodes.join(', ')}).`
        : baseContent

    await tx.ideaLog.create({
      data: {
        idea_id: ideaId,
        type: 'PLAN_RESULT',
        content,
        metadata: {
          pbi_id: pbi.id,
          pbi_code: pbi.code,
          story_count: storyIds.length,
          task_count: taskIds.length,
          ...(downgradedCodes.length > 0 && { downgraded_task_codes: downgradedCodes }),
        },
      },
    })

    return {
      pbi_id: pbi.id,
      pbi_code: pbi.code,
      story_ids: storyIds,
      task_ids: taskIds,
      product_id: productId,
      build_sprint_id: buildSprintId,
    }
  })
}
