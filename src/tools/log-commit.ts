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
  commit_hash: z.string().min(1),
  commit_message: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  task_id: z.string().min(1).optional(),
  execution_key: z.string().min(1).optional(),
  ppe: ppeInputSchema.optional(),
})

export async function handleLogCommit({
  story_id, content, commit_hash, commit_message, metadata, task_id, execution_key, ppe,
}: z.infer<typeof inputSchema>) {
  return withToolErrors(async () => {
    const auth = await requireWriteAccess()
    const ref = await resolveStoryRef(story_id, auth.userId)
    if ('error' in ref) return toolError(ref.error)
    const complete = task_id !== undefined && execution_key !== undefined
    if ((ppe !== undefined) !== complete) throw new Error('PPE_INPUT_INCOMPLETE')
    if (ppe) assertLogOperationKey(ppe, 'commit', execution_key!)
    const request = {
      story_id, task_id: task_id ?? null, execution_key: execution_key ?? null,
      content, commit_hash, commit_message, metadata: metadata ?? null,
    }
    return executePpeMutation({
      ppe,
      operationKind: 'LOG_COMMIT',
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
            type: 'COMMIT',
            content,
            commit_hash,
            commit_message,
            metadata: (storedMetadata ?? undefined) as Prisma.InputJsonValue | undefined,
          },
          select: { id: true, created_at: true },
        })
        return toolJson({ id: log.id, created_at: log.created_at })
      },
    })
  })
}

export function registerLogCommitTool(server: McpServer) {
  server.registerTool(
    'log_commit',
    {
      title: 'Log commit',
      description:
        'Append a COMMIT entry to a story log with hash and message. ' +
        'Forbidden for demo accounts.',
      inputSchema,
    },
    handleLogCommit,
  )
}
