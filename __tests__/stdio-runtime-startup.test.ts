import { beforeEach, describe, expect, it, vi } from 'vitest'

// Zelfde afspraak als stdio-bootstrap.test.ts: de prisma-module is een lazy proxy, maar
// een verdwaalde toegang mag nooit een echte DATABASE_URL raken.
vi.mock('../src/prisma.js', () => ({ prisma: {} }))

// Het échte lifecycle-pad (zonder geïnjecteerde lifecycle) roept `getAuth` en de
// presence-`registerWorker` aan. Beide worden hier vervangen door spies die bij
// aanroep een herkenbare fout geven, zodat een test die dit pad per ongeluk
// doorloopt nooit een transport op de stdin van de testworker zet.
const presenceMocks = vi.hoisted(() => ({ registerWorker: vi.fn() }))
const authMocks = vi.hoisted(() => ({ getAuth: vi.fn() }))

vi.mock('../src/auth.js', async () => ({
  ...(await vi.importActual<typeof import('../src/auth.js')>('../src/auth.js')),
  getAuth: authMocks.getAuth,
}))
vi.mock('../src/presence/worker.js', async () => ({
  ...(await vi.importActual<typeof import('../src/presence/worker.js')>('../src/presence/worker.js')),
  registerWorker: presenceMocks.registerWorker,
}))

import { startStdioServer, type StdioLifecycle } from '../src/stdio-server.js'

function poisonedLifecycle(): StdioLifecycle {
  return {
    authenticate: vi.fn(() => Promise.reject(new Error('AUTH_CALLED'))),
    registerWorker: vi.fn(() => Promise.reject(new Error('WORKER_CALLED'))),
    startHeartbeat: vi.fn(() => {
      throw new Error('HEARTBEAT_CALLED')
    }),
    startQueueMaintenance: vi.fn(() => {
      throw new Error('QUEUE_CALLED')
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  authMocks.getAuth.mockRejectedValue(new Error('GETAUTH_CALLED'))
  presenceMocks.registerWorker.mockRejectedValue(new Error('PRESENCE_REGISTER_CALLED'))
})

// De runtime wordt bij het starten vastgelegd (`resolveRuntimeContext`) en pas daarna begint
// de presence-bootstrap. Een onbekende runtime stopt het proces dus met exitcode 1 (index.ts
// vangt de afwijzing van startStdioServer op) vóór er een worker is geregistreerd.
describe('startStdioServer — worker-runtime bij het starten', () => {
  it('weigert SCRUM4ME_WORKER_RUNTIME=bogus vóór authenticatie, registratie en hartslag', async () => {
    const lifecycle = poisonedLifecycle()

    await expect(
      startStdioServer({ env: { SCRUM4ME_WORKER_RUNTIME: 'bogus' }, lifecycle }),
    ).rejects.toThrow('UNKNOWN_AGENT_RUNTIME')

    expect(lifecycle.authenticate).not.toHaveBeenCalled()
    expect(lifecycle.registerWorker).not.toHaveBeenCalled()
    expect(lifecycle.startHeartbeat).not.toHaveBeenCalled()
    expect(lifecycle.startQueueMaintenance).not.toHaveBeenCalled()
  })

  it('weigert het ook op het echte lifecycle-pad: geen getAuth en geen registerWorker', async () => {
    await expect(
      startStdioServer({ env: { SCRUM4ME_WORKER_RUNTIME: 'bogus' } }),
    ).rejects.toThrow('UNKNOWN_AGENT_RUNTIME')

    expect(authMocks.getAuth).not.toHaveBeenCalled()
    expect(presenceMocks.registerWorker).not.toHaveBeenCalled()
  })

  it.each(['HARNESS', 'harness', 'CODEX', 'CLAUDE', undefined])(
    'accepteert %j en begint met de presence-bootstrap (controle dat de weigering gericht is)',
    async (runtime) => {
      const lifecycle = poisonedLifecycle()
      const env = runtime === undefined ? {} : { SCRUM4ME_WORKER_RUNTIME: runtime }

      // De eerste stap van de bootstrap is authenticate(); die faalt hier met een eigen
      // marker, dus de runtime is geaccepteerd en de lifecycle is betreden.
      await expect(startStdioServer({ env, lifecycle })).rejects.toThrow('AUTH_CALLED')
      expect(lifecycle.authenticate).toHaveBeenCalledTimes(1)
    },
  )
})
