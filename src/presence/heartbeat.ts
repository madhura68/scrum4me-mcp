import { prisma } from '../prisma.js'
import { registerWorker } from './worker.js'

export function startHeartbeat(opts: {
  tokenId: string
  instanceId: string
  productId?: string | null
  runtime?: 'CLAUDE' | 'CODEX'
  capabilities?: string[]
  hostname?: string | null
  pid?: number | null
  intervalMs?: number
}): { stop: () => void } {
  const timer = setInterval(async () => {
    try {
      // Re-resolve the token's current user_id each tick. An admin can re-
      // point ApiToken.user_id at runtime (see scripts/migrate-user.ts in the
      // Scrum4Me repo); a value captured at process startup would keep
      // writing the old owner into ClaudeWorker until the worker restarts.
      // PK-lookup over the unique token_id index is cheap.
      const token = await prisma.apiToken.findUnique({
        where: { id: opts.tokenId },
        select: { user_id: true, revoked_at: true },
      })
      if (!token || token.revoked_at) return

      const result = await prisma.claudeWorker.updateMany({
        where: { token_id: opts.tokenId, instance_id: opts.instanceId },
        data: { user_id: token.user_id, last_seen_at: new Date() },
      })
      if (result.count === 0) {
        // Record disappeared — likely deleted by prisma_workers_cleanup,
        // a manual cleanup, or a race during shutdown of a parallel worker.
        // Re-register so the UI's 'Agent verbonden'-indicator self-heals
        // instead of going dark for the rest of the process lifetime.
        try {
          await registerWorker({
            userId: token.user_id,
            tokenId: opts.tokenId,
            instanceId: opts.instanceId,
            productId: opts.productId ?? null,
            runtime: opts.runtime,
            capabilities: opts.capabilities,
            hostname: opts.hostname ?? null,
            pid: opts.pid ?? null,
          })
        } catch (err) {
          console.error('[scrum4me-mcp] Heartbeat: re-register failed', err)
        }
      }
    } catch {
      // non-fatal — next tick retries
    }
  }, opts.intervalMs ?? 10_000)

  return { stop: () => clearInterval(timer) }
}
