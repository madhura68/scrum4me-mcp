// IDEA-235 (spec §5.3, plan Taak 8): feedback for the ceremony — the latest measurable tasks
// with their frozen estimate and what they actually took. "Measurable" and the pricing come from
// scrum4me-shared (lib/usage-sql.ts), so Insights uses the same definitions.
// A task without a price for every line gets no actual USD and only a time ratio.

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma } from '@prisma/client'
import {
  fullyPricedTaskSqlText,
  measurableTaskSqlText,
  usageLineUsdSqlText,
  usageRateCardJoinSqlText,
} from '@shared/usage-sql.js'
import { prisma } from '../prisma.js'
import { getAuth } from '../auth.js'
import { userCanAccessProduct } from '../access.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  product_id: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
})

type Row = {
  task_id: string
  code: string | null
  title: string
  estimate_active_minutes: number
  estimate_usd: string
  estimate_basis: string
  estimated_at: Date
  active_ms: bigint
  last_ended_at: Date
  actual_usd: string | null
  fully_priced: boolean
}

const MEASURABLE = Prisma.raw(measurableTaskSqlText('t'))
const FULLY_PRICED = Prisma.raw(fullyPricedTaskSqlText('t'))
const LINE_USD = Prisma.raw(usageLineUsdSqlText('ul'))
const PRICE_JOIN = Prisma.raw(usageRateCardJoinSqlText('ul.model_id', "'CLAUDE'"))

const ratio = (actual: number, estimate: number) => Math.round((actual / estimate) * 100) / 100

export async function handleGetEstimateHistory({ product_id, limit }: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const auth = await getAuth()
    if (!(await userCanAccessProduct(product_id, auth.userId))) {
      return toolError(`Product ${product_id} not found or not accessible`)
    }
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT t.id AS task_id, t.code, t.title,
        te.estimate_active_minutes, te.estimate_usd::text AS estimate_usd, te.estimate_basis, te.estimated_at,
        seg.active_ms, seg.last_ended_at,
        cost.usd::text AS actual_usd,
        ${FULLY_PRICED} AS fully_priced
      FROM tasks t
      JOIN task_estimates te ON te.task_id = t.id
      CROSS JOIN LATERAL (
        SELECT SUM(us.active_ms)::bigint AS active_ms, MAX(us.ended_at) AS last_ended_at
        FROM usage_segments us WHERE us.task_id = t.id
      ) seg
      CROSS JOIN LATERAL (
        SELECT ROUND(SUM(${LINE_USD}), 4) AS usd
        FROM usage_segments us
        JOIN usage_lines ul ON ul.segment_id = us.id
        ${PRICE_JOIN}
        WHERE us.task_id = t.id
      ) cost
      WHERE t.product_id = ${product_id} AND ${MEASURABLE}
      ORDER BY seg.last_ended_at DESC, t.id
      LIMIT ${limit}
    `
    const tasks = rows.map((row) => {
      const minutes = Math.round(Number(row.active_ms) / 6000) / 10
      // SUM skips unpriced lines, so a partial sum would understate the cost: never report it.
      const actualUsd = row.fully_priced ? row.actual_usd : null
      return {
        task_id: row.task_id,
        code: row.code,
        title: row.title,
        estimate: {
          active_minutes: row.estimate_active_minutes,
          usd: row.estimate_usd,
          basis: row.estimate_basis,
          estimated_at: row.estimated_at,
        },
        actual: {
          active_minutes: minutes,
          usd: actualUsd,
          usd_status: row.fully_priced ? 'priced' : 'no_price',
          finished_at: row.last_ended_at,
        },
        ratio: {
          time: ratio(minutes, row.estimate_active_minutes),
          cost: actualUsd === null ? null : ratio(Number(actualUsd), Number(row.estimate_usd)),
        },
      }
    })
    return toolJson({ product_id, count: tasks.length, tasks })
  })
}

export function registerGetEstimateHistoryTool(server: McpServer) {
  server.registerTool(
    'get_estimate_history',
    {
      title: 'Get estimate history',
      description:
        'Read-only feedback for estimating at the ceremony (IDEA-235): the latest measurable tasks of a product (done, estimated, fully measured by the usage-ledger mod) with estimate vs actual active minutes and USD-equivalent, ratios (actual ÷ estimate) and the estimate basis. A task without a price for every usage line has actual.usd null ("no_price") and only a time ratio. Tasks run by worker jobs are never measurable. Read this before giving tasks an estimate in create_task.',
      inputSchema,
    },
    handleGetEstimateHistory,
  )
}
