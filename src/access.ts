import { prisma } from './prisma.js'
import { getTokenScopedProducts } from './auth.js'

export async function userCanAccessProduct(productId: string, userId: string): Promise<boolean> {
  // IDEA-118 K3: token-scope eerst — geldt automatisch voor elke tool die
  // deze helper gebruikt. [] = ongescopet (runners/bestaande tokens).
  const scoped = await getTokenScopedProducts()
  if (scoped.length > 0 && !scoped.includes(productId)) return false

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

// M12: idee is strikt user_id-only (geen productAccessFilter — Q8).
// Idea-questions, idea-jobs, en idea-md-mutaties scopen op de eigenaar.
export async function userOwnsIdea(ideaId: string, userId: string): Promise<boolean> {
  const idea = await prisma.idea.findUnique({
    where: { id: ideaId },
    select: { user_id: true },
  })
  return idea !== null && idea.user_id === userId
}
