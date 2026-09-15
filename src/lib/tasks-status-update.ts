import {decideStoryStatus,decidePbiStatus,decideSprintStatus} from './task-status-decisions.js'
// **HOUD SYNC** met Scrum4Me/lib/tasks-status-update.ts.
// Beide repos delen dezelfde DB; deze helper moet bit-voor-bit gelijke
// statusovergangen produceren als de Scrum4Me-versie. Bij wijziging hier
// ook in de Scrum4Me-repo updaten en omgekeerd.
import type { Prisma, TaskStatus, SprintStatus } from '@prisma/client'
import { prisma } from '../prisma.js'

export interface PropagationResult {
  task: {
    id: string
    title: string
    status: TaskStatus
    story_id: string
    implementation_plan: string | null
  }
  storyId: string
  storyChanged: boolean
  pbiChanged: boolean
  sprintChanged: boolean
  sprintRunChanged: boolean
}

// Real-time status-propagatie: bij elke task-statuswijziging wordt de keten
// Task → Story → PBI → Sprint → SprintRun herevalueerd binnen één transactie.
//
// Regels:
//   Story:  ANY task FAILED → FAILED, ELSE ALL DONE → DONE,
//           ELSE IN_SPRINT (mits story.sprint_id != null), anders OPEN
//   PBI:    ANY story FAILED → FAILED, ELSE ALL DONE → DONE, ELSE READY
//           (BLOCKED is handmatig en wordt niet overschreven door deze helper)
//   Sprint: ANY PBI van een story-in-sprint FAILED → FAILED,
//           ELSE ALL PBIs van die stories DONE → COMPLETED,
//           ELSE ACTIVE
//   SprintRun: Sprint→FAILED → SprintRun=FAILED + cancel openstaand werk +
//              zet failed_task_id; Sprint→COMPLETED → SprintRun=DONE; anders
//              blijft SprintRun ongewijzigd.
export async function propagateStatusUpwards(
  taskId: string,
  newStatus: TaskStatus,
  client?: Prisma.TransactionClient,
  // PBI-50: optionele expliciete sprint_run_id voor SPRINT_IMPLEMENTATION
  // (waar geen ClaudeJob.task_id-koppeling bestaat). Wanneer afwezig valt
  // de helper terug op de lookup via ClaudeJob.task_id, met als laatste
  // fallback Story → Sprint → SprintRun.findFirst({ status: active }).
  sprintRunId?: string,
): Promise<PropagationResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<PropagationResult> => {
    const task = await tx.task.update({
      where: { id: taskId },
      data: { status: newStatus },
      select: {
        id: true,
        title: true,
        status: true,
        story_id: true,
        implementation_plan: true,
      },
    })

    // Story herevalueren
    const siblings = await tx.task.findMany({
      where: { story_id: task.story_id },
      select: { status: true },
    })
    const story = await tx.story.findUniqueOrThrow({
      where: { id: task.story_id },
      select: { id: true, status: true, pbi_id: true, sprint_id: true },
    })

    const nextStoryStatus = decideStoryStatus(siblings.map(s=>s.status),!!story.sprint_id)

    let storyChanged = false
    if (nextStoryStatus !== story.status) {
      await tx.story.update({
        where: { id: story.id },
        data: { status: nextStoryStatus },
      })
      storyChanged = true
    }

    // PBI herevalueren — BLOCKED met rust laten
    const pbi = await tx.pbi.findUniqueOrThrow({
      where: { id: story.pbi_id },
      select: { id: true, status: true },
    })

    let pbiChanged = false
    if (pbi.status !== 'BLOCKED') {
      const pbiStories = await tx.story.findMany({
        where: { pbi_id: pbi.id },
        select: { status: true },
      })
      const nextPbiStatus = decidePbiStatus(pbiStories.map(s=>s.status),pbi.status)

      if (nextPbiStatus !== pbi.status) {
        await tx.pbi.update({
          where: { id: pbi.id },
          data: { status: nextPbiStatus },
        })
        pbiChanged = true
      }
    }

    // Sprint herevalueren — alleen als deze story aan een sprint hangt
    let sprintChanged = false
    let nextSprintStatus: SprintStatus | null = null
    if (story.sprint_id) {
      const sprint = await tx.sprint.findUniqueOrThrow({
        where: { id: story.sprint_id },
        select: { id: true, status: true },
      })

      const sprintPbiRows = await tx.story.findMany({
        where: { sprint_id: sprint.id },
        select: { pbi_id: true },
        distinct: ['pbi_id'],
      })
      const sprintPbis = await tx.pbi.findMany({
        where: { id: { in: sprintPbiRows.map((s) => s.pbi_id) } },
        select: { status: true },
      })
      const nextStatus = decideSprintStatus(sprintPbis.map(p=>p.status))

      if (nextStatus !== sprint.status) {
        await tx.sprint.update({
          where: { id: sprint.id },
          data: {
            status: nextStatus,
            ...(nextStatus === 'CLOSED' ? { completed_at: new Date() } : {}),
          },
        })
        sprintChanged = true
        nextSprintStatus = nextStatus
      }
    }

    // SprintRun herevalueren. Resolve sprint_run_id in volgorde:
    //   1. Expliciete sprintRunId-arg (PBI-50: SPRINT_IMPLEMENTATION-pad).
    //   2. ClaudeJob.task_id-lookup (PER_TASK-flow).
    //   3. Story → Sprint → SprintRun.findFirst({ status: active }) (geen
    //      task-job, bv. handmatige task-statuswijziging via UI).
    let sprintRunChanged = false
    if (nextSprintStatus === 'FAILED' || nextSprintStatus === 'CLOSED') {
      let resolvedRunId: string | null = sprintRunId ?? null
      let cancelExceptJobId: string | null = null

      if (!resolvedRunId) {
        const job = await tx.claudeJob.findFirst({
          where: { task_id: taskId, sprint_run_id: { not: null } },
          orderBy: { created_at: 'desc' },
          select: { id: true, sprint_run_id: true },
        })
        if (job?.sprint_run_id) {
          resolvedRunId = job.sprint_run_id
          cancelExceptJobId = job.id
        }
      }

      if (!resolvedRunId && story.sprint_id) {
        const activeRun = await tx.sprintRun.findFirst({
          where: {
            sprint_id: story.sprint_id,
            status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
          },
          orderBy: { created_at: 'desc' },
          select: { id: true },
        })
        if (activeRun) resolvedRunId = activeRun.id
      }

      if (resolvedRunId) {
        const sprintRun = await tx.sprintRun.findUnique({
          where: { id: resolvedRunId },
          select: { id: true, status: true },
        })
        if (
          sprintRun &&
          (sprintRun.status === 'QUEUED' ||
            sprintRun.status === 'RUNNING' ||
            sprintRun.status === 'PAUSED')
        ) {
          if (nextSprintStatus === 'FAILED') {
            await tx.sprintRun.update({
              where: { id: sprintRun.id },
              data: {
                status: 'FAILED',
                finished_at: new Date(),
                failed_task_id: taskId,
              },
            })
            // Cancel sibling-jobs binnen dezelfde SprintRun behalve de
            // huidige task-job (als die er is). Voor SPRINT_IMPLEMENTATION
            // is cancelExceptJobId null en hebben we geen siblings om te
            // cancellen — de SPRINT-job zelf blijft actief en de worker
            // detecteert dit via job_heartbeat.
            await tx.claudeJob.updateMany({
              where: {
                sprint_run_id: sprintRun.id,
                status: { in: ['QUEUED', 'CLAIMED', 'RUNNING'] },
                ...(cancelExceptJobId ? { id: { not: cancelExceptJobId } } : {}),
              },
              data: {
                status: 'CANCELLED',
                finished_at: new Date(),
                error: `Cancelled: task ${taskId} failed in same sprint run`,
              },
            })
            sprintRunChanged = true
          } else {
            // COMPLETED
            await tx.sprintRun.update({
              where: { id: sprintRun.id },
              data: { status: 'DONE', finished_at: new Date() },
            })
            sprintRunChanged = true
          }
        }
      }
    }

    return {
      task,
      storyId: task.story_id,
      storyChanged,
      pbiChanged,
      sprintChanged,
      sprintRunChanged,
    }
  }

  if (client) return run(client)
  return prisma.$transaction(run)
}

// ─── Backwards-compat wrapper ────────────────────────────────────────────────
// Bestaande tools (update-task-status, log-implementation, etc.) verwachten
// de oude { task, storyStatusChange, storyId } shape. We mappen storyChanged
// op promoted/demoted via een eenvoudige heuristiek op nieuwe TaskStatus.

export type StoryStatusChange = 'promoted' | 'demoted' | null

export interface UpdateTaskStatusResult {
  task: PropagationResult['task']
  storyStatusChange: StoryStatusChange
  storyId: string
  sprintRunChanged: boolean
}

export async function updateTaskStatusWithStoryPromotion(
  taskId: string,
  newStatus: TaskStatus,
  client?: Prisma.TransactionClient,
  sprintRunId?: string,
): Promise<UpdateTaskStatusResult> {
  const result = await propagateStatusUpwards(taskId, newStatus, client, sprintRunId)
  let storyStatusChange: StoryStatusChange = null
  if (result.storyChanged) {
    storyStatusChange = newStatus === 'DONE' ? 'promoted' : 'demoted'
  }
  return {
    task: result.task,
    storyStatusChange,
    storyId: result.storyId,
    sprintRunChanged: result.sprintRunChanged,
  }
}
