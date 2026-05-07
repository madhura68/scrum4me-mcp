// PBI-50 F3-T3: job_heartbeat
//
// Verlengt ClaudeJob.lease_until met 5 min zodat resetStaleClaimedJobs een
// long-running job (bv. SPRINT_IMPLEMENTATION over 30+ min) niet ten onrechte
// als stale markt. Worker draait een achtergrond-loop elke 60s.
//
// Voor SPRINT-jobs: respons bevat sprint_run_status zodat de worker zijn
// loop kan breken bij ≠ RUNNING (bv. UI-side cancel of MERGE_CONFLICT-pause).

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'

const inputSchema = z.object({
  job_id: z.string().min(1),
})

export function registerJobHeartbeatTool(server: McpServer) {
  server.registerTool(
    'job_heartbeat',
    {
      title: 'Job heartbeat',
      description:
        'Extend the lease on a CLAIMED/RUNNING job by 5 minutes. Token must own the job. ' +
        'For SPRINT_IMPLEMENTATION jobs: response includes sprint_run_status so the worker ' +
        'can break its task-loop on UI-side cancel/pause without an extra query. ' +
        'Worker should call this every ~60s during long-running batches. ' +
        'Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ job_id }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()

        // Atomic conditional UPDATE so a non-owner / non-active job is rejected
        // without a separate read.
        const updated = await prisma.$queryRaw<
          Array<{ id: string; lease_until: Date; kind: string; sprint_run_id: string | null }>
        >`
          UPDATE claude_jobs
          SET lease_until = NOW() + INTERVAL '5 minutes'
          WHERE id = ${job_id}
            AND claimed_by_token_id = ${auth.tokenId}
            AND status IN ('CLAIMED', 'RUNNING')
          RETURNING id, lease_until, kind::text AS kind, sprint_run_id
        `
        if (updated.length === 0) {
          return toolError(
            `Job ${job_id} not found, not claimed by your token, or in terminal state`,
          )
        }
        const row = updated[0]

        let sprint_run_status: string | null = null
        let sprint_run_pause_reason: string | null = null
        if (row.kind === 'SPRINT_IMPLEMENTATION' && row.sprint_run_id) {
          const sprintRun = await prisma.sprintRun.findUnique({
            where: { id: row.sprint_run_id },
            select: { status: true, pause_context: true },
          })
          sprint_run_status = sprintRun?.status ?? null
          // Extract pause_reason from pause_context Json (best-effort)
          const ctx = sprintRun?.pause_context as
            | { pause_reason?: string }
            | null
            | undefined
          sprint_run_pause_reason = ctx?.pause_reason ?? null
        }

        return toolJson({
          ok: true,
          job_id: row.id,
          lease_until: row.lease_until.toISOString(),
          sprint_run_status,
          sprint_run_pause_reason,
        })
      }),
  )
}
