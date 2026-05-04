// MCP authoring tool: create een Product Backlog Item.
//
// Sort_order wordt automatisch op last+1 binnen de prioriteits-groep gezet als
// niet meegegeven. Code wordt auto-gegenereerd als PBI-N (zelfde logica als de
// Scrum4Me-app), met retry bij een race-condition op de unique constraint.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const PBI_AUTO_RE = /^PBI-(\d+)$/
const MAX_CODE_ATTEMPTS = 3

async function generateNextPbiCode(productId: string): Promise<string> {
  const pbis = await prisma.pbi.findMany({
    where: { product_id: productId },
    select: { code: true },
  })
  let max = 0
  for (const p of pbis) {
    const m = p.code?.match(PBI_AUTO_RE)
    if (m) {
      const n = Number.parseInt(m[1], 10)
      if (!Number.isNaN(n) && n > max) max = n
    }
  }
  return `PBI-${max + 1}`
}

function isCodeUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code !== 'P2002') return false
  const target = (error.meta as { target?: string[] | string } | undefined)?.target
  if (!target) return false
  return Array.isArray(target) ? target.includes('code') : target.includes('code')
}

const inputSchema = z.object({
  product_id: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  priority: z.number().int().min(1).max(4),
  sort_order: z.number().optional(),
})

export function registerCreatePbiTool(server: McpServer) {
  server.registerTool(
    'create_pbi',
    {
      title: 'Create PBI',
      description:
        'Add a Product Backlog Item to a product. Sort_order auto-set to last+1 within the priority group if not provided. Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ product_id, title, description, priority, sort_order }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        if (!(await userCanAccessProduct(product_id, auth.userId))) {
          return toolError(`Product ${product_id} not found or not accessible`)
        }

        let resolvedSortOrder = sort_order
        if (resolvedSortOrder === undefined) {
          const last = await prisma.pbi.findFirst({
            where: { product_id, priority },
            orderBy: { sort_order: 'desc' },
            select: { sort_order: true },
          })
          resolvedSortOrder = (last?.sort_order ?? 0) + 1.0
        }

        let lastError: unknown
        for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
          const code = await generateNextPbiCode(product_id)
          try {
            const pbi = await prisma.pbi.create({
              data: {
                product_id,
                code,
                title,
                description: description ?? null,
                priority,
                sort_order: resolvedSortOrder,
              },
              select: {
                id: true,
                code: true,
                title: true,
                description: true,
                priority: true,
                sort_order: true,
                created_at: true,
              },
            })
            return toolJson(pbi)
          } catch (e) {
            if (isCodeUniqueConflict(e)) { lastError = e; continue }
            throw e
          }
        }
        throw lastError ?? new Error('Kon geen unieke PBI-code genereren')
      }),
  )
}
