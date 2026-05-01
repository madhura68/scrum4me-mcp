import { prisma } from '../prisma.js'

export function startHeartbeat(opts: {
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
        console.error('[scrum4me-mcp] Heartbeat: worker record not found — token may be revoked. Stopping.')
        clearInterval(timer)
      }
    } catch {
      // non-fatal
    }
  }, opts.intervalMs ?? 5_000)

  return { stop: () => clearInterval(timer) }
}
