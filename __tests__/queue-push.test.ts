import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    agentMessage: { create: vi.fn() },
    $executeRaw: vi.fn(),
    task: { findUnique: vi.fn() },
    story: { findUnique: vi.fn() },
    sprint: { findUnique: vi.fn() },
  },
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
  task: { findUnique: ReturnType<typeof vi.fn> }
  story: { findUnique: ReturnType<typeof vi.fn> }
  sprint: { findUnique: ReturnType<typeof vi.fn> }
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

  it("accepteert as: 'kimi' — schema én afzender-identiteit", async () => {
    // De enum was overgetypt ('claude','codex','jp'): Zod weigerde 'kimi'
    // vóórdat resolveQueueIdentity — dat wél tegen QUEUE_MODELS toetst — draaide.
    // Twee lagen, want het harnas roept de handler rechtstreeks aan en slaat
    // Zod over: alleen de assertie op het geregistreerde inputSchema dekt de
    // schema-kant, alleen de handler-aanroep dekt de identiteit.
    const server = makeServer()
    const meta = server.registerTool.mock.calls[0][1] as {
      inputSchema: { parse: (value: unknown) => { as?: string } }
    }
    const base = { to: 'scrum4me-server:claude', type: 'info', body: 'x' }
    expect(meta.inputSchema.parse({ ...base, as: 'kimi' }).as).toBe('kimi')
    // Geen z.string(): een model buiten het vocabulaire blijft geweigerd.
    expect(() => meta.inputSchema.parse({ ...base, as: 'gpt' })).toThrow()

    await server.call({ ...base, as: 'kimi' })
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ from_model: 'kimi' }),
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

  it('laat een expliciete meta.task.cwd winnen van de cwd-parameter', async () => {
    // Load-bearing precedentie die nergens gedekt was: geeft de agent beide,
    // dan hoort de expliciete meta.task.cwd te winnen. Andersom voert de
    // ontvanger het werk in de verkeerde map uit.
    const server = makeServer()
    await server.call({
      to: 'scrum4me-server:claude',
      type: 'task',
      body: 'doe iets',
      cwd: '/param/dir',
      meta: {
        task: {
          cwd: '/expliciet/dir', objective: 'o', verification: 'v', response_format: 'rf',
        },
      },
    })
    expect(mockDerive).toHaveBeenCalledWith('/expliciet/dir')
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: {
          task: {
            cwd: '/expliciet/dir',
            repo: 'https://git.jp-visser.nl/janpeter/x.git',
            objective: 'o',
            verification: 'v',
            response_format: 'rf',
          },
        },
      }),
    })
  })

  it('vult from_server en from_model uit de resolved identity, niet hardgecodeerd', async () => {
    // Elke andere test stubt S4M_SERVER=mac, dus een hardgecodeerd 'mac' in de
    // insert bleef onzichtbaar. Stub hier een andere geldige server.
    vi.stubEnv('S4M_SERVER', 'max2')
    vi.stubEnv('S4M_MODEL', 'codex')
    const server = makeServer()
    await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'x' })
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ from_server: 'max2', from_model: 'codex' }),
    })
  })

  it('bewaart meegegeven meta bij een info-bericht', async () => {
    // info heeft geen meta.task nodig, maar meta mag daarom niet verdwijnen.
    const server = makeServer()
    await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'x', meta: { foo: 'bar' } })
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ meta: { foo: 'bar' } }),
    })
  })

  it('notificeert pas ná de insert, met een envelope uit de opgeslagen rij', async () => {
    // Mutatie A liet een optimistische NOTIFY vóór de insert overleven, met
    // een verzonnen id. invocationCallOrder is een monotone teller over alle
    // mocks heen, dus de volgorde is direct te asserteren; de id-vergelijking
    // met de opgeslagen rij sluit een verzonnen envelope uit.
    const server = makeServer()
    await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'vraag' })
    expect(mockPrisma.agentMessage.create.mock.invocationCallOrder[0])
      .toBeLessThan(mockPrisma.$executeRaw.mock.invocationCallOrder[0])
    const payload = mockPrisma.$executeRaw.mock.calls[0][2] as string
    expect(JSON.parse(payload).id).toBe(createdRow.id)
  })

  it('laat de tool slagen als de NOTIFY faalt', async () => {
    // Best-effort: de rij is al gecommit, dus een mislukte notify mag geen
    // tool-fout worden — inclusief het message_id in de succesvolle respons.
    mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('notify down'))
    const server = makeServer()
    const result = await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'vraag' })
    expect(result.isError).toBeUndefined()
    const body = JSON.parse(result.content[0].text)
    expect(body.message_id).toBe(createdRow.id)
  })
})

describe('queue_push — meta.work_item (spec 2026-08-20)', () => {
  it('task_id-parameter → canoniek blok, sprint/product uit de story', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      story_id: 's1', story: { sprint_id: 'sp1', product_id: 'p1' },
    })
    const server = makeServer()
    await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'x', task_id: 't1' })
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: { work_item: { product_id: 'p1', sprint_id: 'sp1', story_id: 's1', task_id: 't1' } },
      }),
    })
  })

  it('caller-blok zonder parameters wordt canoniek herschreven; meegegeven product_id vervalt', async () => {
    mockPrisma.story.findUnique.mockResolvedValue({ sprint_id: null, product_id: 'p-echt' })
    const server = makeServer()
    await server.call({
      to: 'scrum4me-server:claude', type: 'info', body: 'x',
      meta: { work_item: { story_id: 's1', product_id: 'p-vervalst', rommel: true } },
    })
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: { work_item: { product_id: 'p-echt', story_id: 's1' } },
      }),
    })
  })

  it('conflict parameter↔blok → VALIDATION_ERROR, geen insert, geen NOTIFY', async () => {
    const server = makeServer()
    const result = await server.call({
      to: 'scrum4me-server:claude', type: 'info', body: 'x',
      task_id: 't1', meta: { work_item: { task_id: 't2' } },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('VALIDATION_ERROR')
    expect(mockPrisma.agentMessage.create).not.toHaveBeenCalled()
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
  })

  it('onbestaand task_id → VALIDATION_ERROR, geen insert, geen NOTIFY', async () => {
    mockPrisma.task.findUnique.mockResolvedValue(null)
    const server = makeServer()
    const result = await server.call({
      to: 'scrum4me-server:claude', type: 'info', body: 'x', task_id: 'weg',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/VALIDATION_ERROR.*task_id/)
    expect(mockPrisma.agentMessage.create).not.toHaveBeenCalled()
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled()
  })

  it('zonder ids: geen work_item-sleutel en overige meta ongemoeid', async () => {
    const server = makeServer()
    await server.call({ to: 'scrum4me-server:claude', type: 'info', body: 'x', meta: { foo: 'bar' } })
    const data = mockPrisma.agentMessage.create.mock.calls[0][0].data as { meta: Record<string, unknown> }
    expect(data.meta).toEqual({ foo: 'bar' })
    expect(data.meta).not.toHaveProperty('work_item')
  })

  it('werkt samen met meta.task bij type task (work_item staat ernaast, niet erin)', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      story_id: 's1', story: { sprint_id: 'sp1', product_id: 'p1' },
    })
    const server = makeServer()
    await server.call({
      to: 'scrum4me-server:claude', type: 'task', body: 'doe iets', cwd: '/work/dir',
      task_id: 't1',
      meta: { task: { objective: 'o', verification: 'v', response_format: 'rf' } },
    })
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: {
          task: {
            cwd: '/work/dir', repo: 'https://git.jp-visser.nl/janpeter/x.git',
            objective: 'o', verification: 'v', response_format: 'rf',
          },
          work_item: { product_id: 'p1', sprint_id: 'sp1', story_id: 's1', task_id: 't1' },
        },
      }),
    })
  })

  it('registreert sprint_id/story_id/task_id in het inputSchema', () => {
    // Het harnas roept de handler direct aan en slaat Zod over (zelfde reden
    // als de as:'kimi'-test hierboven): alleen een assertie op het
    // geregistreerde inputSchema bewijst dat een echte MCP-caller de
    // parameters kan meegeven.
    const server = makeServer()
    const meta = server.registerTool.mock.calls[0][1] as {
      inputSchema: {
        parse: (value: unknown) => { sprint_id?: string; story_id?: string; task_id?: string }
      }
    }
    const base = { to: 'scrum4me-server:claude', type: 'info', body: 'x' }
    expect(meta.inputSchema.parse({ ...base, sprint_id: 'sp1' }).sprint_id).toBe('sp1')
    expect(meta.inputSchema.parse({ ...base, story_id: 's1' }).story_id).toBe('s1')
    expect(meta.inputSchema.parse({ ...base, task_id: 't1' }).task_id).toBe('t1')
    expect(() => meta.inputSchema.parse({ ...base, task_id: '' })).toThrow()
  })
})
