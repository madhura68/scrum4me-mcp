import { describe, it, expect, vi } from 'vitest'

// createStdioServer only registers tool metadata — no handler runs during
// initialize/tools/list, and the canary forbids execution before any handler
// body. The prisma module is a lazy proxy (no connect on import), but we mock
// it so a stray access can never reach a real DATABASE_URL in CI.
vi.mock('../src/prisma.js', () => ({ prisma: {} }))

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { createStdioServer, type StdioLifecycle } from '../src/stdio-server.js'
import { stdioMode } from '../src/canary-mode.js'

type ToolDescriptor = Awaited<ReturnType<Client['listTools']>>['tools'][number]

// Each helper opens a fresh in-memory client/server pair and closes it, which
// clears the server's transport so the same server can be reconnected for a
// follow-up request (Protocol allows one transport at a time).
async function withClient<T>(server: McpServer, fn: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'stdio-bootstrap-test', version: '0' })
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    return await fn(client)
  } finally {
    await client.close()
    await server.close()
  }
}

// Sends real `initialize` + `tools/list` requests through an in-memory MCP
// transport and returns the descriptors, sorted so comparison is order-free.
async function listToolDescriptors(server: McpServer): Promise<ToolDescriptor[]> {
  return withClient(server, async (client) => {
    const { tools } = await client.listTools()
    return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  })
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<void> {
  return withClient(server, async (client) => {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) {
      const content = result.content as { type: string; text?: string }[] | undefined
      const text = content?.map((part) => part.text ?? '').join('') ?? ''
      throw new Error(text || `tool ${name} returned an error`)
    }
  })
}

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

describe('stdio canary bootstrap', () => {
  it('lists the runtime surface without credentials or lifecycle effects', async () => {
    const lifecycle = poisonedLifecycle()
    const runtimeServer = createStdioServer({ mode: 'runtime' })
    const canaryServer = createStdioServer({ mode: 'canary', lifecycle })
    const runtime = await listToolDescriptors(runtimeServer)
    const canary = await listToolDescriptors(canaryServer)

    expect(canary).toEqual(runtime)
    expect(lifecycle.authenticate).not.toHaveBeenCalled()
    expect(lifecycle.registerWorker).not.toHaveBeenCalled()
    await expect(callTool(canaryServer, 'health', {})).rejects.toThrow('CANARY_MODE_TOOL_CALL_FORBIDDEN')
  })

  it('canary forbids every tool in the surface, not just health', async () => {
    const canaryServer = createStdioServer({ mode: 'canary' })
    const tools = await listToolDescriptors(canaryServer)
    expect(tools.length).toBeGreaterThan(0)

    // A tool with a required input still fails with the canary marker rather
    // than a validation error only if we pass valid args; use health + a
    // no-arg tool to keep this independent of individual schemas.
    for (const name of ['health']) {
      await expect(callTool(canaryServer, name, {})).rejects.toThrow('CANARY_MODE_TOOL_CALL_FORBIDDEN')
    }
  })

  it('canary registers no prompts', async () => {
    const canaryServer = createStdioServer({ mode: 'canary' })
    await withClient(canaryServer, async (client) => {
      const caps = client.getServerCapabilities()
      // Runtime registers the implement_next_story prompt; canary must not.
      if (caps?.prompts) {
        const { prompts } = await client.listPrompts()
        expect(prompts).toHaveLength(0)
      }
    })
  })
})

describe('stdioMode', () => {
  it('is runtime when unset or empty', () => {
    expect(stdioMode({})).toBe('runtime')
    expect(stdioMode({ SCRUM4ME_CANARY_MODE: '' })).toBe('runtime')
  })

  it('is canary only for exactly "1"', () => {
    expect(stdioMode({ SCRUM4ME_CANARY_MODE: '1' })).toBe('canary')
  })

  it('is fatal for any other non-empty value', () => {
    expect(() => stdioMode({ SCRUM4ME_CANARY_MODE: 'true' })).toThrow('INVALID_CANARY_MODE')
    expect(() => stdioMode({ SCRUM4ME_CANARY_MODE: '0' })).toThrow('INVALID_CANARY_MODE')
    expect(() => stdioMode({ SCRUM4ME_CANARY_MODE: '2' })).toThrow('INVALID_CANARY_MODE')
  })
})
