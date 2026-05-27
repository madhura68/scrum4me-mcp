import { unregisterWorker } from './worker.js'

export function registerShutdownHandlers(opts: {
  userId: string
  tokenId: string
  instanceId: string
  stopHeartbeat: () => void
}): void {
  let exiting = false

  const shutdown = async () => {
    if (exiting) return
    exiting = true
    opts.stopHeartbeat()
    await unregisterWorker({
      userId: opts.userId,
      tokenId: opts.tokenId,
      instanceId: opts.instanceId,
    })
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}
