import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: { agentMessage: { create: vi.fn() }, $executeRaw: vi.fn() },
}))
vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})
vi.mock('../src/queue/git-origin.js', () => ({ deriveRepoFromCwd: vi.fn() }))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { deriveRepoFromCwd } from '../src/queue/git-origin.js'
import { registerQueuePushTool } from '../src/tools/queue-push.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as {
  agentMessage: { create: ReturnType<typeof vi.fn> }
  $executeRaw: ReturnType<typeof vi.fn>
}
const mockDerive = deriveRepoFromCwd as ReturnType<typeof vi.fn>
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
  registerQueuePushTool(server as unknown as McpServer)
  return server
}

const createdRow = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  type: 'info',
  from_server: 'mac',
  from_model: 'claude',
  to_server: 'scrum4me-server',
  to_model: 'claude',
  body: 'vraag',
  meta: {},
  source: 'mcp',
  status: 'pending',
  in_reply_to: null,
  error: null,
  claimed_by: null,
  claimed_at: null,
  started_at: null,
  finished_at: null,
  created_at: new Date(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('S4M_SERVER', 'mac')
  vi.stubEnv('S4M_MODEL', 'claude')
  mockAuth.mockResolvedValue({ userId: 'u', tokenId: 't', username: 'agent', isDemo: false })
  mockPrisma.agentMessage.create.mockResolvedValue(createdRow)
  mockPrisma.$executeRaw.mockResolvedValue(1)
  mockDerive.mockResolvedValue('https://git.jp-visser.nl/janpeter/x.git')
})
afterEach(() => vi.unstubAllEnvs())

describe('queue_push — §5.1', () => {
  it('insert met source=mcp, status=pending en afzender uit de identiteit', async () => {
    const server = makeServer()
    const result = await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'vraag' })
    const body = JSON.parse(result.content[0].text)
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'info',
        source: 'mcp',
        status: 'pending',
        from_server: 'mac',
        from_model: 'claude',
        to_server: 'scrum4me-server',
        to_model: 'claude',
        body: 'vraag',
      }),
    })
    expect(body.message_id).toBe(createdRow.id)
    expect(body.hint).toContain('queue_wait_reply')
    expect(body.hint).toContain(createdRow.id)
  })

  it('emit een NOTIFY-envelope ná de insert (best-effort)', async () => {
    const server = makeServer()
    await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'vraag' })
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1)
  })

  it('faalt niet wanneer de NOTIFY faalt', async () => {
    mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('notify down'))
    const server = makeServer()
    const result = await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'vraag' })
    expect(result.isError).toBeUndefined()
  })

  it('vult meta.task aan met cwd + afgeleide repo en valideert het task-contract', async () => {
    const server = makeServer()
    await server.call({
      to: 'scrum4me-server:claude',
      type: 'task',
      body: 'doe iets',
      cwd: '/work/dir',
      meta: { task: { objective: 'o', verification: 'v', response_format: 'rf' } },
    })
    expect(mockDerive).toHaveBeenCalledWith('/work/dir')
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: {
          task: {
            cwd: '/work/dir',
            repo: 'https://git.jp-visser.nl/janpeter/x.git',
            objective: 'o',
            verification: 'v',
            response_format: 'rf',
          },
        },
      }),
    })
  })

  it('expliciete meta.task.repo wint van afleiding', async () => {
    const server = makeServer()
    await server.call({
      to: 'scrum4me-server:claude',
      type: 'task',
      body: 'doe iets',
      cwd: '/work/dir',
      meta: {
        task: {
          repo: 'https://elders/x.git', objective: 'o', verification: 'v', response_format: 'rf',
        },
      },
    })
    expect(mockDerive).not.toHaveBeenCalled()
  })

  it('geeft VALIDATION_ERROR met uitleg als repo niet afleidbaar is', async () => {
    mockDerive.mockResolvedValue(null)
    const server = makeServer()
    const result = await server.call({
      to: 'scrum4me-server:claude',
      type: 'task',
      body: 'doe iets',
      cwd: '/geen/repo',
      meta: { task: { objective: 'o', verification: 'v', response_format: 'rf' } },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('VALIDATION_ERROR')
    expect(result.content[0].text).toContain('git remote get-url origin')
    expect(mockPrisma.agentMessage.create).not.toHaveBeenCalled()
  })

  it('geeft VALIDATION_ERROR bij een incompleet task-contract', async () => {
    const server = makeServer()
    const result = await server.call({
      to: 'scrum4me-server:claude',
      type: 'review_request',
      body: 'review dit',
      cwd: '/work/dir',
      meta: { task: { objective: 'o' } },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/VALIDATION_ERROR: meta\.task\./)
  })

  it('info heeft géén meta.task nodig', async () => {
    const server = makeServer()
    const result = await server.call({ to: 'mac:jp', type: 'info', body: 'akkoord?' })
    expect(result.isError).toBeUndefined()
  })

  it("'as' override't het afzender-model", async () => {
    const server = makeServer()
    await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'x', as: 'codex' })
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ from_model: 'codex' }),
    })
  })

  it('QUEUE_IDENTITY_REQUIRED zonder S4M_SERVER', async () => {
    vi.stubEnv('S4M_SERVER', '')
    const server = makeServer()
    const result = await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('QUEUE_IDENTITY_REQUIRED')
  })

  it('VALIDATION_ERROR bij een ongeldig doel', async () => {
    const server = makeServer()
    const result = await server.call({ to: 'mars:claude', type: 'info', body: 'x' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('VALIDATION_ERROR: invalid target')
  })
})
