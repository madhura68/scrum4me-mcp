// Integrale port van Scrum4Me actions/sprint-runs.ts startSprintRunCore
// (IDEA-118 K12). Afwijkingen t.o.v. web zijn gemarkeerd met "COPILOT:".
import type { Prisma } from '@prisma/client'
import { prisma } from '../../prisma.js'
import { getJobConfigSnapshot } from './snapshot.js'
import { DispatchError } from './idea-jobs.js'

type PreFlightBlocker = { type: string; id: string; label: string }

export { DispatchError }

export async function dispatchSprintRun(opts: {
  sprintId: string
  productId: string
  userId: string
}): Promise<{ sprint_run_id: string; jobs_count: number }> {
  return prisma.$transaction((tx) => startSprintRunCore(tx, opts))
}

async function startSprintRunCore(
  tx: Prisma.TransactionClient,
  opts: { sprintId: string; productId: string; userId: string },
): Promise<{ sprint_run_id: string; jobs_count: number }> {
  const sprint = await tx.sprint.findUnique({
    where: { id: opts.sprintId },
    include: { product: true },
  })
  // COPILOT: 404-semantiek óók bij product-mismatch (scope, spec §6.3).
  if (!sprint || sprint.product_id !== opts.productId) {
    throw new DispatchError(`Sprint ${opts.sprintId} not found in this product`)
  }
  if (sprint.status !== 'OPEN') throw new DispatchError('Sprint is niet OPEN.')

  const activeRun = await tx.sprintRun.findFirst({
    where: { sprint_id: opts.sprintId, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
  })
  if (activeRun) throw new DispatchError('Er is al een actieve sprint-run.')

  const stories = await tx.story.findMany({
    where: { sprint_id: opts.sprintId, status: { not: 'DONE' } },
    include: {
      pbi: true,
      tasks: {
        where: { status: 'TO_DO' },
        orderBy: [{ sort_order: 'asc' }],
      },
    },
    orderBy: [{ sort_order: 'asc' }],
  })

  const blockers: PreFlightBlocker[] = []

  for (const s of stories) {
    for (const t of s.tasks) {
      if (!t.implementation_plan) {
        blockers.push({ type: 'task_no_plan', id: t.id, label: `${t.code}: ${t.title}` })
      }
    }
  }

  const openQuestions = await tx.claudeQuestion.findMany({
    where: { story: { sprint_id: opts.sprintId }, status: 'open' },
    select: { id: true, question: true },
  })
  for (const q of openQuestions) {
    blockers.push({ type: 'open_question', id: q.id, label: q.question.slice(0, 80) })
  }

  const seenPbi = new Set<string>()
  for (const s of stories) {
    if (seenPbi.has(s.pbi.id)) continue
    seenPbi.add(s.pbi.id)
    if (s.pbi.status === 'BLOCKED' || s.pbi.status === 'FAILED') {
      blockers.push({ type: 'pbi_blocked', id: s.pbi.id, label: `${s.pbi.code}: ${s.pbi.title}` })
    }
  }

  if (sprint.product.pr_strategy === 'SPRINT_BATCH') {
    for (const s of stories) {
      for (const t of s.tasks) {
        if (t.repo_url && t.repo_url !== sprint.product.repo_url) {
          blockers.push({ type: 'task_cross_repo', id: t.id, label: `${t.code}: ${t.title}` })
        }
      }
    }
  }

  if (blockers.length > 0) {
    throw new DispatchError(
      'PRE_FLIGHT_BLOCKED: ' + blockers.map((b) => `${b.type} ${b.label}`).join('; '),
    )
  }

  const sprintRun = await tx.sprintRun.create({
    data: {
      sprint_id: opts.sprintId,
      started_by_id: opts.userId,
      status: 'QUEUED',
      pr_strategy: sprint.product.pr_strategy,
      started_at: new Date(),
    },
  })

  const orderedTasks = stories
    .slice()
    .sort(
      (a, b) =>
        a.pbi.priority - b.pbi.priority ||
        a.pbi.sort_order - b.pbi.sort_order ||
        a.sort_order - b.sort_order,
    )
    .flatMap((s) => s.tasks)

  if (sprint.product.pr_strategy === 'SPRINT_BATCH') {
    const sprintSnapshot = await getJobConfigSnapshot({
      kind: 'SPRINT_IMPLEMENTATION',
      productId: sprint.product_id,
    })
    await tx.claudeJob.create({
      data: {
        user_id: opts.userId,
        product_id: sprint.product_id,
        task_id: null,
        idea_id: null,
        sprint_run_id: sprintRun.id,
        kind: 'SPRINT_IMPLEMENTATION',
        status: 'QUEUED',
        source: 'COPILOT', // COPILOT: web default is SYSTEM
        ...sprintSnapshot,
      },
    })
    return { sprint_run_id: sprintRun.id, jobs_count: 1 }
  }

  // STORY / SPRINT (per-task): snapshot per task zodat task.requires_opus
  // de cascade kan overrulen (identiek aan web).
  let jobsCount = 0
  for (const t of orderedTasks) {
    const taskSnapshot = await getJobConfigSnapshot({
      kind: 'TASK_IMPLEMENTATION',
      productId: sprint.product_id,
      taskId: t.id,
    })
    await tx.claudeJob.create({
      data: {
        user_id: opts.userId,
        product_id: sprint.product_id,
        task_id: t.id,
        sprint_run_id: sprintRun.id,
        kind: 'TASK_IMPLEMENTATION',
        status: 'QUEUED',
        source: 'COPILOT', // COPILOT: web default is SYSTEM
        ...taskSnapshot,
      },
    })
    jobsCount += 1
  }

  return { sprint_run_id: sprintRun.id, jobs_count: jobsCount }
}
