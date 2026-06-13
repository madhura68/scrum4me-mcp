// MCP authoring tool: create een Task onder een bestaande Story.
//
// sprint_id wordt afgeleid uit de Story (denormalized FK). Als de story in
// een sprint zit, erft de task die sprint_id; anders null. Status='TO_DO'.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const TASK_AUTO_RE = /^T-(\d+)$/
const MAX_CODE_ATTEMPTS = 3

async function generateNextTaskCode(productId: string): Promise<string> {
  const tasks = await prisma.task.findMany({
    where: { product_id: productId },
    select: { code: true },
  })
  let max = 0
  for (const t of tasks) {
    const m = t.code?.match(TASK_AUTO_RE)
    if (m) {
      const n = Number.parseInt(m[1], 10)
      if (!Number.isNaN(n) && n > max) max = n
    }
  }
  return `T-${max + 1}`
}

function isCodeUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code !== 'P2002') return false
  const target = (error.meta as { target?: string[] | string } | undefined)?.target
  if (!target) return false
  return Array.isArray(target) ? target.includes('code') : target.includes('code')
}

const inputSchema = z.object({
  story_id: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  implementation_plan: z.string().max(8000).optional(),
  priority: z.number().int().min(1).max(4),
  sort_order: z.number().optional(),
  // Cross-repo override: zet expliciet de repo waarop de worker deze task
  // moet uitvoeren (overrides product.repo_url). Gebruik dit voor PBI's die
  // werk in meerdere repos coördineren — bv. PBI op Scrum4Me-product met
  // tasks die in scrum4me-mcp of scrum4me-docker landen.
  // Format: full git URL (https://github.com/owner/repo). Null/omit = erf
  // van product.repo_url.
  repo_url: z.string().url().optional(),
})

type CreateTaskInput = z.infer<typeof inputSchema>

export async function handleCreateTask({
  story_id,
  title,
  description,
  implementation_plan,
  priority,
  sort_order,
  repo_url,
}: CreateTaskInput) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()

    const story = await prisma.story.findUnique({
      where: { id: story_id },
      select: { product_id: true, sprint_id: true, assignee_id: true },
    })
    if (!story) return toolError(`Story ${story_id} not found`)
    if (!(await userCanAccessProduct(story.product_id, auth.userId))) {
      return toolError(`Story ${story_id} not accessible`)
    }

    let resolvedSortOrder = sort_order
    if (resolvedSortOrder === undefined) {
      const last = await prisma.task.findFirst({
        where: { story_id, priority },
        orderBy: { sort_order: 'desc' },
        select: { sort_order: true },
      })
      resolvedSortOrder = (last?.sort_order ?? 0) + 1.0
    }

    let lastError: unknown
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = await generateNextTaskCode(story.product_id)
      try {
        const task = await prisma.$transaction(async (tx) => {
          if (story.sprint_id && story.assignee_id === null) {
            await tx.story.updateMany({
              where: { id: story_id, assignee_id: null },
              data: { assignee_id: auth.userId },
            })
          }

          return tx.task.create({
            data: {
              story_id,
              product_id: story.product_id, // denormalized — erf van story
              sprint_id: story.sprint_id,   // denormalized — erf van story
              code,
              title,
              description: description ?? null,
              implementation_plan: implementation_plan ?? null,
              priority,
              sort_order: resolvedSortOrder,
              status: 'TO_DO',
              repo_url: repo_url ?? null,
            },
            select: {
              id: true,
              code: true,
              title: true,
              description: true,
              implementation_plan: true,
              priority: true,
              sort_order: true,
              status: true,
              repo_url: true,
              created_at: true,
            },
          })
        })
        return toolJson(task)
      } catch (e) {
        if (isCodeUniqueConflict(e)) { lastError = e; continue }
        throw e
      }
    }
    throw lastError ?? new Error('Kon geen unieke Task-code genereren')
  })
}

export function registerCreateTaskTool(server: McpServer) {
  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description:
        'Add a task under an existing story. Inherits sprint_id from the story (denormalized). Status defaults to TO_DO. Sort_order auto-set to last+1 within the story/priority group if not provided. Optional repo_url overrides the product.repo_url for cross-repo work (e.g. tasks targeting scrum4me-mcp under a Scrum4Me PBI). Forbidden for demo accounts.',
      inputSchema,
    },
    handleCreateTask,
  )
}
