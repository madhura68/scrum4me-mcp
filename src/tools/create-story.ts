// MCP authoring tool: create een Story onder een bestaande PBI.
//
// product_id wordt afgeleid uit de PBI (denormalized FK conform CLAUDE.md
// convention — nooit vertrouwen op client-input). status='OPEN' default;
// landt in de Product Backlog, niet auto in een sprint.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const STORY_AUTO_RE = /^ST-(\d+)$/
const MAX_CODE_ATTEMPTS = 3

async function generateNextStoryCode(productId: string): Promise<string> {
  const stories = await prisma.story.findMany({
    where: { product_id: productId },
    select: { code: true },
  })
  let max = 0
  for (const s of stories) {
    const m = s.code?.match(STORY_AUTO_RE)
    if (m) {
      const n = Number.parseInt(m[1], 10)
      if (!Number.isNaN(n) && n > max) max = n
    }
  }
  return `ST-${String(max + 1).padStart(3, '0')}`
}

function isCodeUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code !== 'P2002') return false
  const target = (error.meta as { target?: string[] | string } | undefined)?.target
  if (!target) return false
  return Array.isArray(target) ? target.includes('code') : target.includes('code')
}

const inputSchema = z.object({
  pbi_id: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  acceptance_criteria: z.string().max(4000).optional(),
  priority: z.number().int().min(1).max(4),
  sort_order: z.number().optional(),
})

export function registerCreateStoryTool(server: McpServer) {
  server.registerTool(
    'create_story',
    {
      title: 'Create story',
      description:
        'Add a story under an existing PBI. Status defaults to OPEN (lands in product backlog, not in a sprint). Sort_order auto-set to last+1 within the PBI/priority group if not provided. Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ pbi_id, title, description, acceptance_criteria, priority, sort_order }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()

        const pbi = await prisma.pbi.findUnique({
          where: { id: pbi_id },
          select: { product_id: true },
        })
        if (!pbi) return toolError(`PBI ${pbi_id} not found`)
        if (!(await userCanAccessProduct(pbi.product_id, auth.userId))) {
          return toolError(`PBI ${pbi_id} not accessible`)
        }

        let resolvedSortOrder = sort_order
        if (resolvedSortOrder === undefined) {
          const last = await prisma.story.findFirst({
            where: { pbi_id, priority },
            orderBy: { sort_order: 'desc' },
            select: { sort_order: true },
          })
          resolvedSortOrder = (last?.sort_order ?? 0) + 1.0
        }

        let lastError: unknown
        for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
          const code = await generateNextStoryCode(pbi.product_id)
          try {
            const story = await prisma.story.create({
              data: {
                pbi_id,
                product_id: pbi.product_id, // denormalized uit DB-parent, niet uit input
                code,
                title,
                description: description ?? null,
                acceptance_criteria: acceptance_criteria ?? null,
                priority,
                sort_order: resolvedSortOrder,
                status: 'OPEN',
              },
              select: {
                id: true,
                code: true,
                title: true,
                description: true,
                acceptance_criteria: true,
                priority: true,
                sort_order: true,
                status: true,
                created_at: true,
              },
            })
            return toolJson(story)
          } catch (e) {
            if (isCodeUniqueConflict(e)) { lastError = e; continue }
            throw e
          }
        }
        throw lastError ?? new Error('Kon geen unieke Story-code genereren')
      }),
  )
}
