import { prisma } from './prisma.js'

export async function userCanAccessProduct(productId: string, userId: string): Promise<boolean> {
  const hit = await prisma.product.findFirst({
    where: {
      id: productId,
      OR: [{ user_id: userId }, { members: { some: { user_id: userId } } }],
    },
    select: { id: true },
  })
  return Boolean(hit)
}

export async function userCanAccessTask(taskId: string, userId: string): Promise<boolean> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { story: { select: { product_id: true } } },
  })
  if (!task) return false
  return userCanAccessProduct(task.story.product_id, userId)
}

export async function userCanAccessStory(storyId: string, userId: string): Promise<boolean> {
  const story = await prisma.story.findUnique({
    where: { id: storyId },
    select: { product_id: true },
  })
  if (!story) return false
  return userCanAccessProduct(story.product_id, userId)
}
