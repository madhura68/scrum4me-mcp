import { unregisterWorker } from './worker.js'

export function registerShutdownHandlers(opts: {
  userId: string
  tokenId: string
  stopHeartbeat: () => void
}): void {
  let shuttingDown = false

  const handleShutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true

    console.log(`[scrum4me-mcp] ${signal} received — cleaning up worker presence`)
    opts.stopHeartbeat()

    try {
      await unregisterWorker({ userId: opts.userId, tokenId: opts.tokenId })
    } catch {
      // best-effort
    }

    process.exit(0)
  }

  process.on('SIGTERM', () => { void handleShutdown('SIGTERM') })
  process.on('SIGINT', () => { void handleShutdown('SIGINT') })
}
