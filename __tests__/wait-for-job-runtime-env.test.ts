import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { toolText } from './helpers/tool-result.js'

const authMocks = vi.hoisted(() => ({ requireWriteAccess: vi.fn() }))

vi.mock('../src/auth.js', async () => ({
  ...(await vi.importActual<typeof import('../src/auth.js')>('../src/auth.js')),
  requireWriteAccess: authMocks.requireWriteAccess,
}))

vi.mock('../src/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    claudeJob: { findUnique: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  },
}))

import { prisma } from '../src/prisma.js'
import { registerWaitForJobTool } from '../src/tools/wait-for-job.js'

const mockPrisma = prisma as unknown as {
  $queryRaw: ReturnType<typeof vi.fn>
  $executeRaw: ReturnType<typeof vi.fn>
  $transaction: ReturnType<typeof vi.fn>
  claudeJob: Record<string, ReturnType<typeof vi.fn>>
}

type Handler = (input: { wait_seconds: number }) => Promise<CallToolResult>
let handler: Handler

function everyDatabaseCall(): ReturnType<typeof vi.fn>[] {
  return [
    mockPrisma.$queryRaw,
    mockPrisma.$executeRaw,
    mockPrisma.$transaction,
    ...Object.values(mockPrisma.claudeJob),
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  authMocks.requireWriteAccess.mockResolvedValue({
    userId: 'user-1',
    tokenId: 'token-1',
    username: 'jan',
    isDemo: false,
  })
  // De eerste databasestap van wait_for_job (resetStaleClaimedJobs) faalt met een eigen marker,
  // zodat een test die het claimpad bereikt dat ziet zonder een echte claim uit te voeren.
  mockPrisma.$queryRaw.mockRejectedValue(new Error('DATABASE_REACHED'))
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: Handler) => {
      handler = fn
    }),
  }
  registerWaitForJobTool(server as unknown as McpServer)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// De runtime van de worker (SCRUM4ME_WORKER_RUNTIME) bepaalt welke jobs hij mag claimen. Een
// onbekende waarde werd stil CLAUDE; nu is het een toolfout vóór er iets geclaimd wordt.
describe('wait_for_job — worker-runtime uit de omgeving', () => {
  it('geeft een toolfout UNKNOWN_AGENT_RUNTIME bij een onbekende runtime, zonder de database aan te raken', async () => {
    vi.stubEnv('SCRUM4ME_WORKER_RUNTIME', 'bogus')

    const result = await handler({ wait_seconds: 1 })

    expect(result.isError).toBe(true)
    expect(toolText(result)).toBe('UNKNOWN_AGENT_RUNTIME')
    for (const call of everyDatabaseCall()) expect(call).not.toHaveBeenCalled()
  })

  it.each(['harness', ' HARNESS ', 'codex', 'CLAUDE'])(
    'gaat bij de geldige runtime %j door naar het claimpad (controle dat de weigering gericht is)',
    async (runtime) => {
      vi.stubEnv('SCRUM4ME_WORKER_RUNTIME', runtime)

      const result = await handler({ wait_seconds: 1 })

      expect(result.isError).toBe(true)
      expect(toolText(result)).toBe('DATABASE_REACHED')
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1)
    },
  )
})
