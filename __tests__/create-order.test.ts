import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn().mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' }),
}))
vi.mock('../src/access.js', () => ({
  userCanAccessProduct: vi.fn().mockResolvedValue(true),
}))
vi.mock('../src/prisma.js', () => ({
  prisma: {
    pbi: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    productDoc: { findMany: vi.fn() },
    productDocRevision: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}))

import { prisma } from '../src/prisma.js'
import { registerCreatePbiTool } from '../src/tools/create-pbi.js'
import { registerCreateStoryTool } from '../src/tools/create-story.js'
import { registerCreateTaskTool } from '../src/tools/create-task.js'

type RegisteredDefinition = { inputSchema: { shape: Record<string, unknown> } }

function captureRegistration(register: (server: never) => void) {
  let definition: RegisteredDefinition | null = null
  let handler: ((input: Record<string, unknown>) => Promise<unknown>) | null = null
  const server = {
    registerTool: vi.fn((_name: string, def: RegisteredDefinition, fn: typeof handler) => {
      definition = def
      handler = fn
    }),
  }
  register(server as never)
  return {
    definition: () => definition!,
    call: (input: Record<string, unknown>) => handler!(input),
  }
}

const mockPrisma = prisma as unknown as {
  pbi: {
    findMany: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
  }
  $transaction: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.pbi.findMany.mockResolvedValue([])
  mockPrisma.pbi.findFirst.mockResolvedValue({ sort_order: 3 })
  mockPrisma.pbi.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'pbi-1', code: 'PBI-1', ...data }),
  )
  mockPrisma.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma))
})

describe('create tool execution order', () => {
  it('appends a PBI in one product sequence regardless of priority', async () => {
    const tool = captureRegistration(registerCreatePbiTool)

    await tool.call({ product_id: 'prod-1', title: 'Urgent PBI', priority: 1 })

    expect(mockPrisma.pbi.findFirst).toHaveBeenCalledWith({
      where: { product_id: 'prod-1' },
      orderBy: [{ sort_order: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
      select: { sort_order: true },
    })
    expect(mockPrisma.pbi.create.mock.calls[0][0].data.sort_order).toBe(4)
  })

  it.each([
    ['story', registerCreateStoryTool],
    ['task', registerCreateTaskTool],
  ])('does not expose caller-controlled sort_order for %s creation', (_name, register) => {
    const tool = captureRegistration(register)

    expect(tool.definition().inputSchema.shape).not.toHaveProperty('sort_order')
  })
})
