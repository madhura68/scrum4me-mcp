import { writeFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

vi.mock('../src/prisma.js', () => ({ prisma: {} }))
vi.mock('../src/auth.js', () => ({
  requireWriteAccess: vi.fn().mockResolvedValue({ userId: 'user-1', tokenId: 'token-1' }),
  PermissionDeniedError: class PermissionDeniedError extends Error {},
}))
vi.mock('../src/lib/resolve-entity.js', () => ({ resolveTaskRef: vi.fn() }))
vi.mock('../src/lib/tasks-status-update.js', () => ({ updateTaskStatusWithStoryPromotion: vi.fn() }))

import { requireWriteAccess } from '../src/auth.js'
import { resolveTaskRef } from '../src/lib/resolve-entity.js'
import { updateTaskStatusWithStoryPromotion } from '../src/lib/tasks-status-update.js'
import { handleUpdateTaskStatus, registerUpdateTaskStatusTool } from '../src/tools/update-task-status.js'
import { toolText } from './helpers/tool-result.js'

// Schema-valid fixture only: never registered with a controller or used for a real mutation.
const ppeFixture = {
  run_id: '22222222-2222-4222-8222-222222222222',
  orchestrator_id: 'test-fixture', orchestrator_generation: 1,
  operation_key: 'test-fixture', payload_hash: 'a'.repeat(64),
  plan_authority_operation_key: 'test-fixture',
}
const missingPpe = 'PPE_INPUT_INCOMPLETE: expected_status requires ppe for PPE execution. For an ordinary update, omit both expected_status and ppe. For a PPE update, provide genuine PPE context; do not invent run or authority values.'
const missingExpected = 'PPE_INPUT_INCOMPLETE: ppe requires expected_status. Provide the expected task status together with the genuine PPE context.'

beforeEach(() => { vi.clearAllMocks() })

describe('update_task_status conditional input contract', () => {
  it.each([
    [{ expected_status: 'todo' }, missingPpe],
    [{ ppe: ppeFixture }, missingExpected],
  ])('explains incomplete input before resolving or mutating a task (%j)', async (extra, message) => {
    const result = await handleUpdateTaskStatus({ task_id: 'task-1', status: 'in_progress', ...extra })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toBe(message)
    expect(requireWriteAccess).toHaveBeenCalledOnce()
    expect(resolveTaskRef).not.toHaveBeenCalled()
    expect(updateTaskStatusWithStoryPromotion).not.toHaveBeenCalled()
  })

  it('publishes the coupled optional fields and actionable errors through the real MCP SDK', async () => {
    const server = new McpServer({ name: 'ppe-input-local-test', version: '1' })
    registerUpdateTaskStatusTool(server)
    const client = new Client({ name: 'ppe-input-test-client', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const { tools } = await client.listTools()
      const tool = tools.find(t => t.name === 'update_task_status')!
      expect(tool.description).toContain('ordinary updates, omit both expected_status and ppe')
      expect(tool.description).toContain('PPE updates require both')
      expect(tool.inputSchema.required).not.toContain('expected_status')
      expect(tool.inputSchema.required).not.toContain('ppe')
      const fields = tool.inputSchema.properties as Record<string, { description?: string }>
      expect(fields.expected_status.description).toContain('Required together with ppe')
      expect(fields.ppe.description).toContain('genuine PPE execution')
      expect(fields.ppe.description).toContain('expected_status')
      const errors = []
      for (const [extra, message] of [
        [{ expected_status: 'todo' }, missingPpe],
        [{ ppe: ppeFixture }, missingExpected],
      ] as const) {
        const result = await client.callTool({ name: tool.name, arguments: { task_id: 'task-1', status: 'in_progress', ...extra } })
        expect(result.isError).toBe(true)
        expect(result.content).toEqual([{ type: 'text', text: message }])
        errors.push(result)
      }
      expect(resolveTaskRef).not.toHaveBeenCalled()
      expect(updateTaskStatusWithStoryPromotion).not.toHaveBeenCalled()
      // Optional export of actual SDK output for the local acceptance report.
      if (process.env.PPE_INPUT_EVIDENCE_PATH) {
        await writeFile(process.env.PPE_INPUT_EVIDENCE_PATH, JSON.stringify({
          scope: 'Local MCP SDK / in-memory transport; auth and DB dependencies mocked; no live mutation',
          tool, errors,
        }, null, 2) + '\n')
      }
    } finally {
      await client.close()
      await server.close()
    }
  })
})
