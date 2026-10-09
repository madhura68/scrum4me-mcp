import { it, expect, vi, beforeEach, describe } from 'vitest'

// M45-3 (test d): dispatch_job heeft een strikt invoerschema zonder required_capability. Via een echte McpServer en
// Client over een in-memory transport draait de eigen validatie van de SDK (validateToolInput, vóór de handler) mee:
// een onbekende sleutel, waaronder het oude required_capability, wordt geweigerd zonder dat de handler, de
// authenticatie of een dispatcher draait. Opvolger van de weigeringstest uit M45-2b (dispatch-job.test.ts) bij
// acceptatie 9.

vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn(),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/access.js', () => ({ userCanAccessProduct: vi.fn() }))
vi.mock('../src/lib/dispatch/task-implementation.js', () => ({
  dispatchTaskImplementation: vi.fn().mockResolvedValue({ job_id: 'job-5' }),
}))
vi.mock('../src/lib/dispatch/idea-jobs.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dispatchIdeaJob: vi.fn().mockResolvedValue({ job_id: 'job-1' }),
}))
vi.mock('../src/lib/dispatch/sprint-run.js', () => ({ dispatchSprintRun: vi.fn() }))
vi.mock('../src/lib/dispatch/review-jobs.js', () => ({
  dispatchPrReview: vi.fn(), dispatchSpecReview: vi.fn(), dispatchTaskReview: vi.fn(),
}))
vi.mock('../src/lib/dispatch/deploy-dispatch.js', () => ({ dispatchDeploy: vi.fn() }))
vi.mock('../src/lib/dispatch/docs-audit-dispatch.js', () => ({ dispatchDocsAudit: vi.fn() }))

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { requireWriteAccess } from '../src/auth.js'
import { userCanAccessProduct } from '../src/access.js'
import { dispatchTaskImplementation } from '../src/lib/dispatch/task-implementation.js'
import { registerDispatchJobTool } from '../src/tools/dispatch-job.js'

async function call(args: Record<string, unknown>): Promise<CallToolResult> {
  const server = new McpServer({ name: 'dispatch-job-transport-test', version: '0' })
  registerDispatchJobTool(server)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'dispatch-job-transport-test', version: '0' })
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    return (await client.callTool({ name: 'dispatch_job', arguments: args })) as CallToolResult
  } finally {
    await client.close()
    await server.close()
  }
}

function textOf(res: CallToolResult): string {
  const block = res.content[0] as { type: string; text?: string } | undefined
  return block?.type === 'text' ? (block.text ?? '') : ''
}

const TASK = { kind: 'TASK_IMPLEMENTATION', product_id: 'p1', task_id: 't1' }

describe('dispatch_job via een echte MCP-client: onbekende sleutels worden geweigerd vóór de handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(requireWriteAccess as ReturnType<typeof vi.fn>).mockResolvedValue({ userId: 'u1', isDemo: false })
    ;(userCanAccessProduct as ReturnType<typeof vi.fn>).mockResolvedValue(true)
  })

  it.each([
    ['required_capability local_llm', { required_capability: 'local_llm' }],
    ['required_capability met een andere waarde', { required_capability: 'deploy' }],
    ['een andere onbekende sleutel', { priority: 'high' }],
  ])('%s → isError met de validatiefout van de SDK, zonder auth en zonder dispatch', async (_label, extra) => {
    const res = await call({ ...TASK, ...extra })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/Input validation error/)
    expect(requireWriteAccess).not.toHaveBeenCalled()
    expect(userCanAccessProduct).not.toHaveBeenCalled()
    expect(dispatchTaskImplementation).not.toHaveBeenCalled()
  })

  it('zonder extra sleutel bereikt de aanroep de handler en wordt gedispatcht', async () => {
    const res = await call(TASK)

    expect(res.isError).toBeFalsy()
    expect(requireWriteAccess).toHaveBeenCalled()
    expect(dispatchTaskImplementation).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1', productId: 'p1' }))
  })
})
