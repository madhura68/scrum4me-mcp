// MCP authoring tool: create een Sprint binnen een product.
//
// Status start altijd op OPEN; geen reuse-check op bestaande OPEN-sprints
// (per plan-to-pbi-flow.md "altijd nieuwe sprint"). Code wordt auto-gegenereerd
// als S-{YYYY-MM-DD}-{N} per product per datum, met retry bij race-condition
// op de unique constraint (@@unique([product_id, code])).

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const SPRINT_AUTO_RE = /^S-(\d{4}-\d{2}-\d{2})-(\d+)$/
const MAX_CODE_ATTEMPTS = 3

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

async function generateNextSprintCode(productId: string): Promise<string> {
  const today = todayIsoDate()
  const sprints = await prisma.sprint.findMany({
    where: { product_id: productId, code: { startsWith: `S-${today}-` } },
    select: { code: true },
  })
  let max = 0
  for (const s of sprints) {
    const m = s.code?.match(SPRINT_AUTO_RE)
    // Dubbele check op de datum — defensive tegen filterveranderingen
    // of mock-data die niet door de DB-where heen ging.
    if (m && m[1] === today) {
      const n = Number.parseInt(m[2], 10)
      if (!Number.isNaN(n) && n > max) max = n
    }
  }
  return `S-${today}-${max + 1}`
}

function isCodeUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code !== 'P2002') return false
  const target = (error.meta as { target?: string[] | string } | undefined)?.target
  if (!target) return false
  return Array.isArray(target) ? target.includes('code') : target.includes('code')
}

export const inputSchema = z.object({
  product_id: z.string().min(1),
  code: z.string().min(1).max(30).optional(),
  sprint_goal: z.string().min(1).max(500),
  start_date: z.string().date().optional(),
})

export async function handleCreateSprint(
  { product_id, code, sprint_goal, start_date }: z.infer<typeof inputSchema>,
) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    if (!(await userCanAccessProduct(product_id, auth.userId))) {
      return toolError(`Product ${product_id} not found or not accessible`)
    }

    const resolvedStartDate = start_date ? new Date(start_date) : new Date()
    const baseSelect = {
      id: true,
      code: true,
      sprint_goal: true,
      status: true,
      start_date: true,
      created_at: true,
    } as const

    if (code) {
      const sprint = await prisma.sprint.create({
        data: { product_id, code, sprint_goal, status: 'OPEN', start_date: resolvedStartDate },
        select: baseSelect,
      })
      return toolJson(sprint)
    }

    let lastError: unknown
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const generated = await generateNextSprintCode(product_id)
      try {
        const sprint = await prisma.sprint.create({
          data: { product_id, code: generated, sprint_goal, status: 'OPEN', start_date: resolvedStartDate },
          select: baseSelect,
        })
        return toolJson(sprint)
      } catch (e) {
        if (isCodeUniqueConflict(e)) { lastError = e; continue }
        throw e
      }
    }
    throw lastError ?? new Error('Kon geen unieke sprint-code genereren')
  })
}

export function registerCreateSprintTool(server: McpServer) {
  server.registerTool(
    'create_sprint',
    {
      title: 'Create Sprint',
      description:
        'Create a new sprint for a product with status=OPEN. Code auto-generated as S-{YYYY-MM-DD}-{N} per product per date if not provided. Forbidden for demo accounts.',
      inputSchema,
    },
    handleCreateSprint,
  )
}
