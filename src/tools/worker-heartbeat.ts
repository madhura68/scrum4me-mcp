// MCP write-tool: worker rapporteert quota-pct na pre-flight probe.
//
// Aanvulling op de bestaande achtergrond-heartbeat (die alleen last_seen_at
// elke 5s tickt). Deze tool wordt expliciet aangeroepen door de worker
// nadat scripts/worker-quota-probe.sh een quota-meting heeft gedaan.
//
// Updates ClaudeWorker.{last_quota_pct, last_quota_check_at, last_seen_at}
// en emit een pg_notify-event op 'scrum4me_changes' zodat de UI de
// stand-by-badge real-time kan tonen.
//
// Auth: api-token; demo mag niet (worker is geen demo-flow).

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from 'pg'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { getInstanceId } from '../presence/instance.js'
import { dbClientConfig } from '../db-connection.js'

const inputSchema = z.object({
  last_quota_pct: z.number().int().min(0).max(100),
  last_quota_check_at: z.string().datetime().optional(),
})

export function registerWorkerHeartbeatTool(server: McpServer) {
  server.registerTool(
    'worker_heartbeat',
    {
      title: 'Worker heartbeat with quota',
      description:
        'Report the worker\'s most recent rate-limit quota percentage to the server. Updates ClaudeWorker.last_quota_pct + last_quota_check_at. Emits a SSE event so the UI can show stand-by status. Forbidden for demo accounts.',
      inputSchema,
    },
    async ({ last_quota_pct, last_quota_check_at }) =>
      withToolErrors(async () => {
        const auth = await requireWriteAccess()
        const checkAt = last_quota_check_at ? new Date(last_quota_check_at) : new Date()
        const instanceId = process.env.SCRUM4ME_WORKER_INSTANCE_ID?.trim() || getInstanceId()

        const result = await prisma.claudeWorker.updateMany({
          where: { token_id: auth.tokenId, instance_id: instanceId },
          data: {
            last_seen_at: new Date(),
            last_quota_pct,
            last_quota_check_at: checkAt,
          },
        })

        if (result.count === 0) {
          return toolError(
            'Worker record not found — call register_worker first or wait for the next heartbeat tick',
          )
        }

        const worker = await prisma.claudeWorker.findFirst({
          where: { token_id: auth.tokenId, instance_id: instanceId },
          select: { runtime: true, instance_id: true },
        })

        if (!worker) {
          return toolError(
            'Worker record not found — call register_worker first or wait for the next heartbeat tick',
          )
        }

        // pg_notify zodat NavBar realtime kan updaten. Failure is non-fatal:
        // de DB-write is al gebeurd, alleen de live-update mist dan.
        try {
          const pg = new Client(dbClientConfig())
          await pg.connect()
          await pg.query('SELECT pg_notify($1, $2)', [
            'scrum4me_changes',
            JSON.stringify({
              type: 'claude_worker_heartbeat',
              worker_id: auth.tokenId,
              user_id: auth.userId,
              token_id: auth.tokenId,
              instance_id: worker.instance_id,
              runtime: worker.runtime ?? 'CLAUDE',
              last_quota_pct,
              last_quota_check_at: checkAt.toISOString(),
            }),
          ])
          await pg.end()
        } catch {
          // non-fatal
        }

        return toolJson({
          ok: true,
          last_quota_pct,
          last_quota_check_at: checkAt.toISOString(),
        })
      }),
  )
}
