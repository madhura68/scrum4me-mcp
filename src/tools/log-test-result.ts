import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Prisma } from '@prisma/client'
import { prisma } from '../prisma.js'
import { requireWriteAccess } from '../auth.js'
import { resolveStoryRef } from '../lib/resolve-entity.js'
import { toolError, toolJson, withToolErrors } from '../errors.js'
import { assertLogOperationKey, executePpeMutation, ppeInputSchema } from '../lib/ppe-operation.js'

const inputSchema = z.object({
  story_id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(['PASSED', 'FAILED']),
  metadata: z.record(z.string(), z.unknown()).optional(),
  task_id: z.string().min(1).optional(),
  execution_key: z.string().min(1).optional(),
  ppe: ppeInputSchema.optional(),
})

export async function handleLogTestResult({
  story_id, content, status, metadata, task_id, execution_key, ppe,
}: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    const ref = await resolveStoryRef(story_id, auth.userId)
    if ('error' in ref) return toolError(ref.error)
    const complete = task_id !== undefined && execution_key !== undefined
    if ((ppe !== undefined) !== complete) throw new Error('PPE_INPUT_INCOMPLETE')
    if (ppe) assertLogOperationKey(ppe, 'test-result', execution_key!)
    const request = {
      story_id, task_id: task_id ?? null, execution_key: execution_key ?? null,
      content, status, metadata: metadata ?? null,
    }
    return executePpeMutation({
      ppe,
      operationKind: 'LOG_TEST_RESULT',
      targetScope: `story:${ref.id}`,
      request,
      authority: 'execution',
      mutate: async () => {
        const storedMetadata = ppe
          ? { ...(metadata ?? {}), ppe: { task_id, execution_key, operation_key: ppe.operation_key, payload_hash: ppe.payload_hash } }
          : metadata
        const log = await prisma.storyLog.create({
          data: {
            story_id: ref.id,
            type: 'TEST_RESULT',
            content,
            status,
            metadata: (storedMetadata ?? undefined) as Prisma.InputJsonValue | undefined,
          },
          select: { id: true, created_at: true },
        })
        return toolJson({ id: log.id, created_at: log.created_at })
      },
    })
  })
}

export function registerLogTestResultTool(server: McpServer) {
  server.registerTool(
    'log_test_result',
    {
      title: 'Log test result',
      description:
        'Append a TEST_RESULT entry (PASSED or FAILED) to a story log. ' +
        'Forbidden for demo accounts.',
      inputSchema,
    },
    handleLogTestResult,
  )
}
