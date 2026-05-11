// MCP tool: update een Sprint.
//
// Generieke update — wijzigt elke combinatie van status, sprint_goal,
// start_date en end_date. Géén state-machine validatie (zie
// docs/plans/sprint-mcp-tools.md): last-write-wins, het resubmit/heropen-pad
// zit elders. Bij status → CLOSED/FAILED/ARCHIVED zonder expliciete end_date
// wordt end_date automatisch op vandaag gezet. Bij status → CLOSED wordt
// daarnaast `completed_at` op now() gezet (parity met
// src/lib/tasks-status-update.ts dat hetzelfde doet bij auto-close via
// task-status-cascade; zo houden reporting en UI één bron van waarheid voor
// completion-tijd).

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SprintStatus } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const TERMINAL_STATUSES = new Set<SprintStatus>(['CLOSED', 'FAILED', 'ARCHIVED'])

export const inputSchema = z.object({
  sprint_id: z.string().min(1),
  status: z.enum(['OPEN', 'CLOSED', 'ARCHIVED', 'FAILED']).optional(),
  sprint_goal: z.string().min(1).max(500).optional(),
  end_date: z.string().date().optional(),
  start_date: z.string().date().optional(),
})

export async function handleUpdateSprint(
  { sprint_id, status, sprint_goal, end_date, start_date }: z.infer<typeof inputSchema>,
) {
  return withToolErrors(async () => {
    if (
      status === undefined &&
      sprint_goal === undefined &&
      end_date === undefined &&
      start_date === undefined
    ) {
      return toolError('Minstens één veld vereist om te wijzigen')
    }

    const auth = await requireWriteAccess()

    const sprint = await prisma.sprint.findUnique({
      where: { id: sprint_id },
      select: { id: true, product_id: true },
    })
    if (!sprint) {
      return toolError(`Sprint ${sprint_id} not found`)
    }
    if (!(await userCanAccessProduct(sprint.product_id, auth.userId))) {
      return toolError(`Sprint ${sprint_id} not accessible`)
    }

    const data: {
      status?: SprintStatus
      sprint_goal?: string
      start_date?: Date
      end_date?: Date
      completed_at?: Date
    } = {}
    if (status !== undefined) data.status = status
    if (sprint_goal !== undefined) data.sprint_goal = sprint_goal
    if (start_date !== undefined) data.start_date = new Date(start_date)
    if (end_date !== undefined) {
      data.end_date = new Date(end_date)
    } else if (status !== undefined && TERMINAL_STATUSES.has(status)) {
      data.end_date = new Date()
    }
    if (status === 'CLOSED') data.completed_at = new Date()

    const updated = await prisma.sprint.update({
      where: { id: sprint_id },
      data,
      select: {
        id: true,
        code: true,
        sprint_goal: true,
        status: true,
        start_date: true,
        end_date: true,
        completed_at: true,
      },
    })
    return toolJson(updated)
  })
}

export function registerUpdateSprintTool(server: McpServer) {
  server.registerTool(
    'update_sprint',
    {
      title: 'Update Sprint',
      description:
        'Update a sprint: status, sprint_goal, start_date and/or end_date. At least one field required. No state-machine validation — last-write-wins. When status goes to CLOSED/FAILED/ARCHIVED and end_date is not provided, end_date is set to today. When status goes to CLOSED, completed_at is set to now (parity with auto-close via task-cascade). Forbidden for demo accounts.',
      inputSchema,
    },
    handleUpdateSprint,
  )
}
