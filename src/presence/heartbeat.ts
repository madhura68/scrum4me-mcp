import { prisma } from '../prisma.js'
import { registerWorker } from './worker.js'

export function startHeartbeat(opts: {
  userId: string
  tokenId: string
  intervalMs?: number
}): { stop: () => void } {
  const timer = setInterval(async () => {
    try {
      const result = await prisma.claudeWorker.updateMany({
        where: { token_id: opts.tokenId },
        data: { last_seen_at: new Date() },
      })
      if (result.count === 0) {
        // Record disappeared — likely deleted by prisma_workers_cleanup,
        // a manual cleanup, or a race during shutdown of a parallel worker.
        // Re-register so the UI's 'Agent verbonden'-indicator self-heals
        // instead of going dark for the rest of the process lifetime.
        try {
          await registerWorker({ userId: opts.userId, tokenId: opts.tokenId })
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
