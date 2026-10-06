import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

vi.mock('../../src/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn() },
}))

import { prisma } from '../../src/prisma.js'
import { registerHealthTool } from '../../src/tools/health.js'

const mockQueryRaw = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>

type HealthResult = {
  content: { type: string; text: string }[]
  structuredContent: Record<string, unknown>
}

let handler: () => Promise<HealthResult>

function registerTool() {
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
  }
  registerHealthTool(server as unknown as McpServer)
}

// Spec §5.4 punt 3: `runtimes` noemt HARNESS pas in de release die ook de claimtak en
// isHarnessJob bevat. Een client (en de uitrol-controle van de operator) leest hier af welke
// runtimes deze MCP-installatie kent; een oudere installatie heeft het veld niet.
const KNOWN_RUNTIMES = ['CLAUDE', 'CODEX', 'HARNESS']

beforeEach(() => {
  vi.clearAllMocks()
  mockQueryRaw.mockResolvedValue([{ '?column?': 1 }])
  registerTool()
})

describe('health — runtimes', () => {
  it('meldt de runtimes die deze installatie kent, in structuredContent én in de tekst', async () => {
    const result = await handler()

    expect(result.structuredContent.runtimes).toEqual(KNOWN_RUNTIMES)
    expect(JSON.parse(result.content[0].text).runtimes).toEqual(KNOWN_RUNTIMES)
  })

  it('meldt de runtimes ook als de database niet bereikbaar is', async () => {
    mockQueryRaw.mockRejectedValue(new Error('connection refused'))

    const result = await handler()

    expect(result.structuredContent.database).toBe('down')
    expect(result.structuredContent.runtimes).toEqual(KNOWN_RUNTIMES)
  })

  it('geeft elke aanroep een eigen lijst: een lezer die hem wijzigt raakt de volgende niet', async () => {
    const first = await handler()
    expect(first.structuredContent.runtimes).toEqual(KNOWN_RUNTIMES)
    ;(first.structuredContent.runtimes as string[]).push('BOGUS')

    const second = await handler()

    expect(second.structuredContent.runtimes).toEqual(KNOWN_RUNTIMES)
  })

  it('voegt alleen runtimes toe: de bestaande velden blijven zoals ze waren', async () => {
    const result = await handler()

    expect(Object.keys(result.structuredContent).sort()).toEqual(
      ['database', 'runtimes', 'status', 'time', 'version'],
    )
    expect(result.structuredContent).toMatchObject({ status: 'ok', database: 'ok' })
    expect(typeof result.structuredContent.version).toBe('string')
    expect(new Date(result.structuredContent.time as string).toISOString()).toBe(
      result.structuredContent.time,
    )
  })
})
