import { prisma } from '../prisma.js'

export function startHeartbeat(opts: {
  tokenId: string
  intervalMs?: number
}): { stop: () => void } {
  const ms = opts.intervalMs ?? 5_000

  const timer = setInterval(async () => {
    try {
      const result = await prisma.claudeWorker.updateMany({
        where: { token_id: opts.tokenId },
        data: { last_seen_at: new Date() },
      })
      if (result.count === 0) {
        console.warn('[scrum4me-mcp] heartbeat: worker record not found — token may be revoked, stopping heartbeat')
        clearInterval(timer)
      }
    } catch (err) {
      console.warn('[scrum4me-mcp] heartbeat error:', err)
    }
  }, ms)

  return { stop: () => clearInterval(timer) }
}
