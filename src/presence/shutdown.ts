import { unregisterWorker } from './worker.js'

// SIGTERM/SIGINT dekken alleen het geval dat iets dit proces rechtstreeks
// signaleert. In de agent-runner gebeurt juist dát niet: Claude spawnt de
// server via `npx tsx …`, en die wrapper-keten start het echte node-proces als
// kleinkind. Een signaal naar Claude's directe child bereikt deze code dus
// nooit. Wat het proces wél erft is de stdin-pipe — verdwijnt de client, dan
// krijgt stdin EOF. Dat is het enige afsluit-signaal waar een gespawnde
// stdio-MCP op kan rekenen. Zonder de stdin-handlers hieronder bleef het proces
// na afloop van de job eeuwig draaien (de heartbeat-interval houdt de
// event-loop open), hield het zijn Prisma-pool vast en bleef het heartbeaten in
// claude_workers — waardoor de zombie zich als levende worker bleef melden.
export function registerShutdownHandlers(opts: {
  userId: string
  tokenId: string
  instanceId: string
  stopHeartbeat: () => void
}): { shutdown: () => Promise<void> } {
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
  process.stdin.on('end', () => void shutdown())
  process.stdin.on('close', () => void shutdown())

  return { shutdown }
}
