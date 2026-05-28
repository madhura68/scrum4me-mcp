import { prisma } from '../prisma.js'

export type ResolveResult = { id: string } | { error: string }

const productScope = (userId: string) => ({
  OR: [{ user_id: userId }, { members: { some: { user_id: userId } } }],
})

export async function resolveStoryRef(ref: string, userId: string): Promise<ResolveResult> {
  const byId = await prisma.story.findFirst({
    where: { id: ref, product: productScope(userId) },
    select: { id: true },
  })
  if (byId) return { id: byId.id }

  const byCode = await prisma.story.findMany({
    where: { code: ref, product: productScope(userId) },
    select: { id: true },
    take: 2,
  })
  if (byCode.length === 1) return { id: byCode[0].id }
  if (byCode.length > 1)
    return { error: `Story code '${ref}' is ambiguous across products; pass the story CUID id instead.` }

  const asTask = await prisma.task.findFirst({
    where: { code: ref, product: productScope(userId) },
    select: { id: true },
  })
  if (asTask)
    return { error: `'${ref}' is a task code, not a story. This tool expects a story (CUID id or ST-… code).` }

  return { error: `Story '${ref}' not found or not accessible. Pass the story CUID id or its code (e.g. ST-1427).` }
}

export async function resolveTaskRef(ref: string, userId: string): Promise<ResolveResult> {
  const byId = await prisma.task.findFirst({
    where: { id: ref, product: productScope(userId) },
    select: { id: true },
  })
  if (byId) return { id: byId.id }

  const byCode = await prisma.task.findMany({
    where: { code: ref, product: productScope(userId) },
    select: { id: true },
    take: 2,
  })
  if (byCode.length === 1) return { id: byCode[0].id }
  if (byCode.length > 1)
    return { error: `Task code '${ref}' is ambiguous across products; pass the task CUID id instead.` }

  const asStory = await prisma.story.findFirst({
    where: { code: ref, product: productScope(userId) },
    select: { id: true },
  })
  if (asStory)
    return { error: `'${ref}' is a story code, not a task. This tool expects a task (CUID id or T-… code).` }

  return { error: `Task '${ref}' not found or not accessible. Pass the task CUID id or its code (e.g. T-1219).` }
}

export async function resolveProductRef(ref: string, userId: string): Promise<ResolveResult> {
  const byId = await prisma.product.findFirst({
    where: { id: ref, ...productScope(userId) },
    select: { id: true },
  })
  if (byId) return { id: byId.id }

  const byCode = await prisma.product.findFirst({
    where: { code: ref, ...productScope(userId) },
    select: { id: true },
  })
  if (byCode) return { id: byCode.id }

  return { error: `Product '${ref}' not found or not accessible. Pass the product CUID id or its code.` }
}
