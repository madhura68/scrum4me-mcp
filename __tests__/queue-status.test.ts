import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { agentMessage: { findUnique: vi.fn(), findMany: vi.fn() } },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { registerQueueStatusTool } from '../src/tools/queue-status.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as {
  agentMessage: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }
}
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>

type ToolResult = { isError?: boolean; content: { text: string }[] }

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>) => handler(args) as Promise<ToolResult>,
  }
  registerQueueStatusTool(server as unknown as McpServer)
  return server
}

const MSG_ID = 'aaaaaaaa-0000-4000-8000-000000000010'

const requestRow = {
  id: MSG_ID,
  type: 'info',
  from_server: 'mac',
  from_model: 'claude',
  to_server: 'scrum4me-server',
  to_model: 'claude',
  body: 'vraag',
  meta: {},
  source: 'mcp',
  status: 'done',
  in_reply_to: null,
  error: null,
  claimed_by: null,
  claimed_at: null,
  started_at: null,
  finished_at: new Date(),
  created_at: new Date(),
}

const replyRow = {
  ...requestRow,
  id: 'aaaaaaaa-0000-4000-8000-000000000011',
  type: 'data',
  from_server: 'scrum4me-server',
  to_server: 'mac',
  body: 'antwoord',
  in_reply_to: MSG_ID,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
})

describe('queue_status — §5.6', () => {
  it('retourneert bericht + replies in messageView-vorm (from/to samengesteld)', async () => {
    mockPrisma.agentMessage.findUnique.mockResolvedValue(requestRow)
    mockPrisma.agentMessage.findMany.mockResolvedValue([replyRow])
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID })
    const body = JSON.parse(result.content[0].text)
    expect(body.message.id).toBe(MSG_ID)
    expect(body.message.from).toBe('mac:claude')
    expect(body.message.to).toBe('scrum4me-server:claude')
    expect(body.replies).toHaveLength(1)
    expect(body.replies[0].in_reply_to).toBe(MSG_ID)
    expect(mockPrisma.agentMessage.findMany).toHaveBeenCalledWith({
      where: { in_reply_to: MSG_ID },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })
  })

  it('QUEUE_NOT_FOUND voor een onbekend id', async () => {
    mockPrisma.agentMessage.findUnique.mockResolvedValue(null)
    const server = makeServer()
    const result = await server.call({ message_id: MSG_ID })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_NOT_FOUND')
    expect(mockPrisma.agentMessage.findMany).not.toHaveBeenCalled()
  })
})
