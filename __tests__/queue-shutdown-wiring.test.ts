// Fase 3 — queue-maintenance (lease-refresh + stale-sweep) moet mee-afsluiten
// met de presence-shutdown. Stdio-only: alleen src/index.ts start deze timers,
// src/http.ts bewust niet (spec §5/§9).
//
// Deze suite pint óók de twee eigenschappen vast die een "vervang het hele
// bestand"-herschrijving van src/presence/shutdown.ts zou slopen:
//   1. de return-waarde `{ shutdown }` — index.ts hangt hem op
//      transport.onclose; met een void-return knalt de destructurering;
//   2. de stdin-handlers — onder de agent-runner is stdin-EOF het enige
//      afsluit-signaal dat een gespawnde stdio-MCP bereikt (zie het
//      comment-blok in shutdown.ts en __tests__/presence-shutdown.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/presence/worker.js', () => ({
  unregisterWorker: vi.fn().mockResolvedValue(undefined),
}))

import { registerShutdownHandlers } from '../src/presence/shutdown.js'
import { unregisterWorker } from '../src/presence/worker.js'

describe('registerShutdownHandlers — queue-maintenance stop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // restoreAllMocks() in afterEach zet de implementatie van een vi.fn()
    // terug op "geen"; opnieuw zetten houdt het await-contract intact.
    vi.mocked(unregisterWorker).mockResolvedValue(undefined)
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
  })

  // Zelfde listener-hygiëne als __tests__/presence-shutdown.test.ts: elke
  // registerShutdownHandlers-aanroep hangt vier listeners op globale objecten.
  // Zonder opruimen vuurt de shutdown van een eerdere test mee op de emit van
  // een latere (en tikt process/stdin richting MaxListenersExceededWarning).
  // Uitgebreid t.o.v. de beforeEach hierboven: die dekt de stdin-kant niet.
  afterEach(() => {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    process.stdin.removeAllListeners('end')
    process.stdin.removeAllListeners('close')
    // Vangnet voor de process.exit-spy als een assertie eerder afbreekt.
    vi.restoreAllMocks()
  })

  it('stopt heartbeat én queue-maintenance op SIGTERM', async () => {
    const stopHeartbeat = vi.fn()
    const stopQueueMaintenance = vi.fn()
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    registerShutdownHandlers({
      userId: 'u',
      tokenId: 't',
      instanceId: 'i',
      stopHeartbeat,
      stopQueueMaintenance,
    })
    process.emit('SIGTERM')
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())
    expect(stopHeartbeat).toHaveBeenCalledOnce()
    expect(stopQueueMaintenance).toHaveBeenCalledOnce()
    expect(unregisterWorker).toHaveBeenCalledOnce()
    exitSpy.mockRestore()
  })

  it('blijft werken zonder stopQueueMaintenance (optioneel veld)', async () => {
    const stopHeartbeat = vi.fn()
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    registerShutdownHandlers({ userId: 'u', tokenId: 't', instanceId: 'i', stopHeartbeat })
    process.emit('SIGINT')
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())
    expect(stopHeartbeat).toHaveBeenCalledOnce()
    exitSpy.mockRestore()
  })

  it('geeft een object met een aanroepbare shutdown terug die dezelfde opruiming doet', async () => {
    const stopHeartbeat = vi.fn()
    const stopQueueMaintenance = vi.fn()
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)

    // Niet gedestructureerd: index.ts leest `.shutdown` van de return-waarde en
    // hangt hem op transport.onclose. Een void-return (of een weggehaalde
    // `return { shutdown }`) breekt precies hier — dat moet rood worden.
    const handlers = registerShutdownHandlers({
      userId: 'u',
      tokenId: 't',
      instanceId: 'i',
      stopHeartbeat,
      stopQueueMaintenance,
    })
    expect(handlers).toBeDefined()
    expect(typeof handlers.shutdown).toBe('function')

    await handlers.shutdown()

    expect(stopHeartbeat).toHaveBeenCalledOnce()
    expect(stopQueueMaintenance).toHaveBeenCalledOnce()
    expect(unregisterWorker).toHaveBeenCalledOnce()
    expect(unregisterWorker).toHaveBeenCalledWith({
      userId: 'u',
      tokenId: 't',
      instanceId: 'i',
    })
    expect(exitSpy).toHaveBeenCalledWith(0)
    exitSpy.mockRestore()
  })

  it('stopt queue-maintenance ook op stdin-EOF — het signaal dat een gespawnde stdio-MCP wél bereikt', async () => {
    const stopHeartbeat = vi.fn()
    const stopQueueMaintenance = vi.fn()
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never)
    registerShutdownHandlers({
      userId: 'u',
      tokenId: 't',
      instanceId: 'i',
      stopHeartbeat,
      stopQueueMaintenance,
    })

    process.stdin.emit('end')

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())
    expect(stopHeartbeat).toHaveBeenCalledOnce()
    expect(stopQueueMaintenance).toHaveBeenCalledOnce()
    expect(unregisterWorker).toHaveBeenCalledOnce()
    exitSpy.mockRestore()
  })
})
