import type { Prisma, TaskStatus } from '@prisma/client'
import { prisma } from '../prisma.js'

export type StoryStatusChange = 'promoted' | 'demoted' | null

export interface UpdateTaskStatusResult {
  task: {
    id: string
    title: string
    status: TaskStatus
    story_id: string
    implementation_plan: string | null
  }
  storyStatusChange: StoryStatusChange
  storyId: string
}

// Update task.status atomically and auto-promote/demote the parent story:
//   - All sibling tasks DONE → story.status = DONE
//   - Story was DONE and a task moves out of DONE → story.status = IN_SPRINT
// Demote target is IN_SPRINT (not OPEN): OPEN means "back in product backlog",
// which is a sprint-management action, not a status side-effect.
export async function updateTaskStatusWithStoryPromotion(
  taskId: string,
  newStatus: TaskStatus,
  client?: Prisma.TransactionClient,
): Promise<UpdateTaskStatusResult> {
  const run = async (tx: Prisma.TransactionClient): Promise<UpdateTaskStatusResult> => {
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

    const siblings = await tx.task.findMany({
      where: { story_id: task.story_id },
      select: { status: true },
    })
    const allDone = siblings.every((s) => s.status === 'DONE')

    const story = await tx.story.findUniqueOrThrow({
      where: { id: task.story_id },
      select: { status: true },
    })

    let storyStatusChange: StoryStatusChange = null
    if (newStatus === 'DONE' && allDone && story.status !== 'DONE') {
      await tx.story.update({
        where: { id: task.story_id },
        data: { status: 'DONE' },
      })
      storyStatusChange = 'promoted'
    } else if (newStatus !== 'DONE' && story.status === 'DONE') {
      await tx.story.update({
        where: { id: task.story_id },
        data: { status: 'IN_SPRINT' },
      })
      storyStatusChange = 'demoted'
    }

    return { task, storyStatusChange, storyId: task.story_id }
  }

  if (client) return run(client)
  return prisma.$transaction(run)
}
