// Materialisatie-logica: idee-plan → PBI + stories + tasks.
//
// BEWUST DUPLICAAT van Scrum4Me/lib/ideas/materialize-server.ts (M20) — de
// web-action én deze MCP-side-effect (submit_review APPROVED → auto-materialize)
// moeten identieke semantiek draaien. Wijzigingen in beide doorvoeren
// (parser-shape + transactie-semantiek). Zelfde patroon als de bewust-
// gedupliceerde idea-plan-parser.ts.
import type { PrismaClient } from '@prisma/client'

import { parsePlanMd } from './idea-plan-parser.js'

export const MATERIALIZE_ALLOWED_FROM = ['PLAN_READY', 'PLAN_REVIEWED'] as const

export type MaterializeErrorCode = 'STATUS' | 'NO_PRODUCT' | 'NO_PLAN' | 'PARSE' | 'ACTIVE_TASKS'

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

// Web gebruikt parseCodeNumber(@/lib/code); mcp inlinet dezelfde semantiek:
// trailing getal uit een code ("ST-001" → 1, "T-3" → 3).
function codeNumber(code: string): number {
  const m = code.match(/(\d+)$/)
  return m ? Number.parseInt(m[1], 10) : 0
}

export async function materializeIdeaPlan(
  db: PrismaClient,
  params: { ideaId: string; userId: string; allowAlongside?: boolean },
): Promise<MaterializeResult> {
  const { ideaId, userId, allowAlongside } = params

  const idea = await db.idea.findFirst({
    where: { id: ideaId, user_id: userId },
    select: { id: true, status: true, product_id: true, plan_md: true, pbi_id: true },
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
  if (!idea.plan_md) {
    throw new MaterializeError('NO_PLAN', 'Idee heeft geen plan_md')
  }

  const parsed = parsePlanMd(idea.plan_md)
  if (!parsed.ok) {
    throw new MaterializeError('PARSE', 'plan_md is niet parseerbaar', parsed.errors)
  }

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
      where: { product_id: productId, priority: plan.pbi.priority },
      orderBy: { sort_order: 'desc' },
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
          sort_order: codeNumber(storyCode),
          status: 'OPEN',
        },
        select: { id: true },
      })
      storyIds.push(story.id)

      for (let ti = 0; ti < s.tasks.length; ti++) {
        const t = s.tasks[ti]
        const taskCode = `T-${nextTaskN++}`
        const task = await tx.task.create({
          data: {
            story_id: story.id,
            product_id: productId,
            code: taskCode,
            title: t.title,
            description: t.description ?? null,
            implementation_plan: t.implementation_plan ?? null,
            priority: s.priority,
            sort_order: codeNumber(taskCode),
            status: 'TO_DO',
            verify_required: t.verify_required ?? 'ALIGNED_OR_PARTIAL',
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

    await tx.ideaLog.create({
      data: {
        idea_id: ideaId,
        type: 'PLAN_RESULT',
        content: `Materialized into ${pbi.code} (${plan.stories.length} stories, ${taskIds.length} tasks)`,
        metadata: {
          pbi_id: pbi.id,
          pbi_code: pbi.code,
          story_count: storyIds.length,
          task_count: taskIds.length,
        },
      },
    })

    return { pbi_id: pbi.id, pbi_code: pbi.code, story_ids: storyIds, task_ids: taskIds, product_id: productId }
  })
}
