import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/prisma.js', () => ({
  prisma: {
    sprintTaskExecution: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('../src/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/auth.js')>()
  return { ...original, requireWriteAccess: vi.fn() }
})

vi.mock('../src/verify/classify.js', () => ({
  classifyDiffAgainstPlan: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

import { prisma } from '../src/prisma.js'
import { requireWriteAccess } from '../src/auth.js'
import { classifyDiffAgainstPlan } from '../src/verify/classify.js'
import { execFile } from 'node:child_process'
import { registerVerifySprintTaskTool } from '../src/tools/verify-sprint-task.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const mockPrisma = prisma as unknown as {
  sprintTaskExecution: {
    findUnique: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}
const mockAuth = requireWriteAccess as ReturnType<typeof vi.fn>
const mockClassify = classifyDiffAgainstPlan as ReturnType<typeof vi.fn>
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>

const TOKEN_ID = 'tok-owner'

function makeServer() {
  let handler: (args: Record<string, unknown>) => Promise<unknown>
  const server = {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn
    }),
    call: (args: Record<string, unknown>) => handler(args),
  }
  registerVerifySprintTaskTool(server as unknown as McpServer)
  return server
}

function stubGitDiff(stdout: string) {
  // promisify(execFile) calls (cmd, args, opts, cb)
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout, stderr: '' })
    },
  )
}

function execRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec-1',
    sprint_job_id: 'job-1',
    order: 0,
    base_sha: 'sha-base',
    plan_snapshot: 'frozen plan',
    verify_required_snapshot: 'ALIGNED_OR_PARTIAL',
    verify_only_snapshot: false,
    sprint_job: {
      claimed_by_token_id: TOKEN_ID,
      status: 'CLAIMED',
      kind: 'SPRINT_IMPLEMENTATION',
    },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({
    userId: 'u-1',
    tokenId: TOKEN_ID,
    username: 'agent',
    isDemo: false,
  })
})

describe('verify_sprint_task', () => {
  it('rejects when execution not found', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(null)
    const server = makeServer()
    const result = (await server.call({
      execution_id: 'missing',
      worktree_path: '/tmp/wt',
    })) as { content: { text: string }[]; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/not found/i)
  })

  it('rejects wrong token', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(
      execRecord({
        sprint_job: { claimed_by_token_id: 'other', status: 'CLAIMED', kind: 'SPRINT_IMPLEMENTATION' },
      }),
    )
    const server = makeServer()
    const result = (await server.call({
      execution_id: 'exec-1',
      worktree_path: '/tmp/wt',
    })) as { content: { text: string }[]; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/Forbidden/)
  })

  it('PARTIAL with summary returns allowed_for_done=true under ALIGNED_OR_PARTIAL', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(execRecord())
    stubGitDiff('diff --git a/x b/x\n+ change\n')
    mockClassify.mockReturnValue({ result: 'PARTIAL', reasoning: 'extra files' })

    const server = makeServer()
    const result = (await server.call({
      execution_id: 'exec-1',
      worktree_path: '/tmp/wt',
      summary: 'Refactor touched extra files for type narrowing.',
    })) as { content: { text: string }[] }
    const body = JSON.parse(result.content[0].text)
    expect(body.result).toBe('partial')
    expect(body.allowed_for_done).toBe(true)
    expect(body.reason).toBeNull()
  })

  it('PARTIAL without summary returns allowed_for_done=false', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(execRecord())
    stubGitDiff('diff --git a/x b/x\n')
    mockClassify.mockReturnValue({ result: 'PARTIAL', reasoning: 'r' })

    const server = makeServer()
    const result = (await server.call({
      execution_id: 'exec-1',
      worktree_path: '/tmp/wt',
    })) as { content: { text: string }[] }
    const body = JSON.parse(result.content[0].text)
    expect(body.result).toBe('partial')
    expect(body.allowed_for_done).toBe(false)
    expect(body.reason).toMatch(/summary/i)
  })

  it('DIVERGENT with strict ALIGNED returns allowed_for_done=false', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(
      execRecord({ verify_required_snapshot: 'ALIGNED' }),
    )
    stubGitDiff('diff --git a/x b/x\n')
    mockClassify.mockReturnValue({ result: 'DIVERGENT', reasoning: 'r' })

    const server = makeServer()
    const result = (await server.call({
      execution_id: 'exec-1',
      worktree_path: '/tmp/wt',
      summary: 'Long enough summary describing the deviation rationale clearly.',
    })) as { content: { text: string }[] }
    const body = JSON.parse(result.content[0].text)
    expect(body.allowed_for_done).toBe(false)
    expect(body.reason).toMatch(/ALIGNED/)
  })

  it('auto-fills base_sha from previous DONE execution head_sha', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(
      execRecord({ order: 1, base_sha: null }),
    )
    mockPrisma.sprintTaskExecution.findFirst.mockResolvedValue({
      head_sha: 'prev-head-sha',
    })
    stubGitDiff('diff\n')
    mockClassify.mockReturnValue({ result: 'ALIGNED', reasoning: 'ok' })

    const server = makeServer()
    const result = (await server.call({
      execution_id: 'exec-1',
      worktree_path: '/tmp/wt',
    })) as { content: { text: string }[] }
    const body = JSON.parse(result.content[0].text)
    expect(body.base_sha).toBe('prev-head-sha')

    // Persisted back to row
    const updateCalls = mockPrisma.sprintTaskExecution.update.mock.calls
    const baseShaPersist = updateCalls.find((c) => c[0].data.base_sha === 'prev-head-sha')
    expect(baseShaPersist).toBeDefined()
  })

  it('errors when base_sha cannot be derived (no prior DONE)', async () => {
    mockPrisma.sprintTaskExecution.findUnique.mockResolvedValue(
      execRecord({ order: 2, base_sha: null }),
    )
    mockPrisma.sprintTaskExecution.findFirst.mockResolvedValue(null)

    const server = makeServer()
    const result = (await server.call({
      execution_id: 'exec-1',
      worktree_path: '/tmp/wt',
    })) as { content: { text: string }[]; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/MISSING_BASE_SHA/)
  })
})
