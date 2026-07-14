// Regressietest voor het MCP-wees-lek (worker-docs, 2026-07-14).
//
// Symptoom in productie: elke afgeronde Claude-job liet een levend
// `tsx src/index.ts`-proces achter. 30 van die wezen hielden samen 32 idle
// DB-connecties vast en dreven de productie-DB naar 97/100; ze bleven boven-
// dien heartbeaten in claude_workers, dus ze meldden zich als levende workers.
//
// Oorzaak: registerShutdownHandlers luisterde alleen naar SIGTERM/SIGINT.
// Claude spawnt de server via een `npx tsx`-wrapperketen, dus het echte
// node-proces is een kleinkind en krijgt dat signaal nooit. De stdin-pipe erft
// het wél — dus stdin-EOF is het enige afsluit-signaal waar deze server op kan
// rekenen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const unregisterWorker = vi.fn()
vi.mock('../src/presence/worker.js', () => ({
  unregisterWorker: (...args: unknown[]) => unregisterWorker(...args),
  registerWorker: vi.fn(),
}))

import { registerShutdownHandlers } from '../src/presence/shutdown.js'

function makeOpts() {
  return {
    userId: 'user-1',
    tokenId: 'token-1',
    instanceId: 'instance-1',
    stopHeartbeat: vi.fn(),
  }
}

describe('registerShutdownHandlers', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    unregisterWorker.mockReset()
    unregisterWorker.mockResolvedValue(undefined)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  })

  afterEach(() => {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    process.stdin.removeAllListeners('end')
    process.stdin.removeAllListeners('close')
    vi.restoreAllMocks()
  })

  it('sluit af op stdin-EOF — het enige signaal dat een gespawnde stdio-MCP bereikt', async () => {
    const opts = makeOpts()
    registerShutdownHandlers(opts)

    process.stdin.emit('end')

    await vi.waitFor(() => expect(unregisterWorker).toHaveBeenCalledTimes(1))
    expect(opts.stopHeartbeat).toHaveBeenCalledTimes(1)
    expect(unregisterWorker).toHaveBeenCalledWith({
      userId: 'user-1',
      tokenId: 'token-1',
      instanceId: 'instance-1',
    })
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('sluit ook af als stdin sluit zonder end-event', async () => {
    const opts = makeOpts()
    registerShutdownHandlers(opts)

    process.stdin.emit('close')

    await vi.waitFor(() => expect(unregisterWorker).toHaveBeenCalledTimes(1))
    expect(opts.stopHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('geeft een shutdown() terug zodat index.ts hem op transport.onclose kan hangen', async () => {
    const opts = makeOpts()
    const { shutdown } = registerShutdownHandlers(opts)

    await shutdown()

    expect(unregisterWorker).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('is idempotent: transport-close én stdin-EOF samen unregistreren één keer', async () => {
    const opts = makeOpts()
    const { shutdown } = registerShutdownHandlers(opts)

    process.stdin.emit('end')
    process.stdin.emit('close')
    await shutdown()

    await vi.waitFor(() => expect(unregisterWorker).toHaveBeenCalledTimes(1))
    expect(opts.stopHeartbeat).toHaveBeenCalledTimes(1)
  })

  it('blijft SIGTERM/SIGINT afhandelen', async () => {
    const opts = makeOpts()
    registerShutdownHandlers(opts)

    process.emit('SIGTERM')

    await vi.waitFor(() => expect(unregisterWorker).toHaveBeenCalledTimes(1))
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
