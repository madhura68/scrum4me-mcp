// MCP authoring tool: create een Task onder een bestaande Story.
//
// sprint_id wordt afgeleid uit de Story (denormalized FK). Als de story in
// een sprint zit, erft de task die sprint_id; anders null. Status='TO_DO'.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { withSerializableRetry } from '../lib/serializable-transaction.js'
import { withCodeUniqueRetry } from '../lib/code-unique-retry.js'
import { assertCeremonyOperationKey, executePpeMutation, ppeInputSchema } from '../lib/ppe-operation.js'

const TASK_AUTO_RE = /^T-(\d+)$/
async function generateNextTaskCode(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<string> {
  const tasks = await tx.task.findMany({
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

const inputSchema = z.object({
  story_id: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  implementation_plan: z.string().max(8000).optional(),
  priority: z.number().int().min(1).max(4),
  // Cross-repo override: zet expliciet de repo waarop de worker deze task
  // moet uitvoeren (overrides product.repo_url). Gebruik dit voor PBI's die
  // werk in meerdere repos coördineren — bv. PBI op Scrum4Me-product met
  // tasks die in scrum4me-mcp of scrum4me-docker landen.
  // Format: full git URL (https://github.com/owner/repo). Null/omit = erf
  // van product.repo_url.
  repo_url: z.string().url().optional(),
  ceremony_object_key: z.string().min(1).optional(),
  ppe: ppeInputSchema.optional(),
})

type CreateTaskInput = z.infer<typeof inputSchema>

export async function handleCreateTask({
  story_id,
  title,
  description,
  implementation_plan,
  priority,
  repo_url,
  ceremony_object_key,
  ppe,
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
    if ((ppe === undefined) !== (ceremony_object_key === undefined)) throw new Error('PPE_INPUT_INCOMPLETE')
    if (ppe) assertCeremonyOperationKey(ppe, 'task', ceremony_object_key!)

    const request = {
      story_id, title, description: description ?? null,
      implementation_plan: implementation_plan ?? null, priority,
      repo_url: repo_url ?? null, ceremony_object_key: ceremony_object_key ?? null,
    }
    return executePpeMutation({
      ppe,
      operationKind: 'CEREMONY_TASK',
      targetScope: `product:${story.product_id}`,
      request,
      authority: 'ceremony',
      mutate: async () => {
        const createTask = () => withSerializableRetry(async (tx) => {
          const last = await tx.task.findFirst({
            where: { story_id },
            orderBy: [{ sort_order: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
            select: { sort_order: true },
          })
          const resolvedSortOrder = (last?.sort_order ?? 0) + 1.0
          const code = await generateNextTaskCode(tx, story.product_id)
          if (story.sprint_id && story.assignee_id === null) {
            await tx.story.updateMany({
              where: { id: story_id, assignee_id: null },
              data: { assignee_id: auth.userId },
            })
          }

          return tx.task.create({
            data: {
              story_id,
              product_id: story.product_id,
              sprint_id: story.sprint_id,
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
        const task = await withCodeUniqueRetry('tasks_product_id_code_key', createTask)
        return toolJson(task)
      },
    })
  })
}

export function registerCreateTaskTool(server: McpServer) {
  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description:
        'Add a task under an existing story. Inherits sprint_id from the story (denormalized). Status defaults to TO_DO. Priority is team importance only; execution order appends within the parent and can be changed through backlog reorder. Optional repo_url overrides the product.repo_url for cross-repo work (e.g. tasks targeting scrum4me-mcp under a Scrum4Me PBI). Forbidden for demo accounts.',
      inputSchema,
    },
    handleCreateTask,
  )
}
